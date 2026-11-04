import fs from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import Docker from 'dockerode';
import tar from 'tar-stream';
import {
  BackendCapabilities,
  EnvironmentRecord,
  EnvironmentSpec,
  ExecutionBackend,
  OutputListener,
  PreviewEndpoint,
  ProcessExit,
  ProcessHandle,
  ProcessSpec,
  ResourceUsage,
  parseListeningPorts
} from './executionBackend.js';

const LABEL_MANAGED = 'squadforge.managed';
const LABEL_SESSION = 'squadforge.session';
const LABEL_BUILD = 'squadforge.build';
const LABEL_ROLE = 'squadforge.role';

const SANDBOX_USER = '10001:10001';
const SANDBOX_UID = 10001;
const WORKSPACE = '/workspace';
const EDGE_NETWORK = 'squadforge-edge';
const RELAY_PORT = 8080;
const EGRESS_PORT = 3128;
const STOP_GRACE_SECONDS = 5;
const MAX_READ_BACK_BYTES = 20 * 1024 * 1024;

export interface DockerBackendConfig {
  image: string;
  runtime?: string;
  previewBindIp: string;
  previewHost: string;
  registryUrl: string;
}

export function dockerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DockerBackendConfig {
  const previewBindIp = env.SANDBOX_PREVIEW_BIND_IP || '127.0.0.1';
  return {
    image: env.SANDBOX_IMAGE || 'squadforge-sandbox:1',
    runtime: env.SANDBOX_RUNTIME || undefined,
    previewBindIp,
    previewHost: env.SANDBOX_PREVIEW_HOST || previewBindIp,
    registryUrl: env.NPM_REGISTRY_URL || 'https://registry.npmjs.org/'
  };
}

export function dockerClientFromEnv(env: NodeJS.ProcessEnv = process.env): Docker {
  const { DOCKER_HOST: host, DOCKER_TLS_CA: ca, DOCKER_TLS_CERT: cert, DOCKER_TLS_KEY: key } = env;
  if (host && ca && cert && key) {
    const url = new URL(host.replace(/^tcp:/, 'https:'));
    return new Docker({
      host: url.hostname,
      port: Number(url.port || 2376),
      protocol: 'https',
      ca: fs.readFileSync(ca),
      cert: fs.readFileSync(cert),
      key: fs.readFileSync(key)
    });
  }
  return new Docker();
}

/** Host settings shared by every container, including relays and the egress proxy. */
export function hardenedHostConfig(
  config: Pick<DockerBackendConfig, 'runtime'>,
  limits: { memoryMb: number; cpus: number; pids: number; tmpfsMb: number }
): Docker.HostConfig {
  const memory = limits.memoryMb * 1024 * 1024;
  return {
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true'],
    ReadonlyRootfs: true,
    Privileged: false,
    Memory: memory,
    MemorySwap: memory,
    NanoCpus: Math.round(limits.cpus * 1e9),
    PidsLimit: limits.pids,
    Tmpfs: { '/tmp': `rw,noexec,nosuid,size=${limits.tmpfsMb}m` },
    LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '1' } },
    ...(config.runtime ? { Runtime: config.runtime } : {})
  };
}

const SERVICE_LIMITS = { memoryMb: 128, cpus: 0.25, pids: 32, tmpfsMb: 8 };

export class DockerBackend implements ExecutionBackend {
  readonly name = 'docker';

  constructor(
    private readonly docker: Docker = dockerClientFromEnv(),
    private readonly config: DockerBackendConfig = dockerConfigFromEnv()
  ) {}

  private networkName(sessionId: string) { return `sf-net-${sessionId}`; }
  private volumeName(sessionId: string) { return `sf-ws-${sessionId}`; }
  private cacheName(buildId: string) { return `sf-cache-${buildId}`; }
  private relayName(sessionId: string) { return `sf-relay-${sessionId}`; }
  private egressName(sessionId: string) { return `sf-egress-${sessionId}`; }

  private labels(sessionId: string, buildId: string, role: string): Record<string, string> {
    return { [LABEL_MANAGED]: 'true', [LABEL_SESSION]: sessionId, [LABEL_BUILD]: buildId, [LABEL_ROLE]: role };
  }

  async capabilities(): Promise<BackendCapabilities> {
    try {
      await this.docker.ping();
    } catch (err: any) {
      return { available: false, backend: this.name, reason: `Docker worker is unreachable: ${err.message}` };
    }
    try {
      await this.docker.getImage(this.config.image).inspect();
    } catch {
      return { available: false, backend: this.name, reason: `Sandbox image ${this.config.image} is not on the worker.` };
    }
    return { available: true, backend: this.name, runtime: this.config.runtime || 'runc' };
  }

  async createEnvironment(spec: EnvironmentSpec): Promise<void> {
    const labels = this.labels(spec.sessionId, spec.buildId, 'environment');
    await this.docker.createNetwork({
      Name: this.networkName(spec.sessionId),
      Internal: true,
      // Internal alone leaves the host reachable on the bridge gateway address
      Options: { 'com.docker.network.bridge.inhibit_ipv4': 'true' },
      Labels: labels
    });
    await this.docker.createVolume({ Name: this.volumeName(spec.sessionId), Labels: labels });
    await this.docker.createVolume({
      Name: this.cacheName(spec.buildId),
      Labels: { [LABEL_MANAGED]: 'true', [LABEL_BUILD]: spec.buildId, [LABEL_ROLE]: 'cache' }
    });
    await this.prepareVolumes(spec);
  }

  /** Runs one short root step with no network, so the sandbox user owns its volumes. */
  private async prepareVolumes(spec: EnvironmentSpec): Promise<void> {
    const container = await this.docker.createContainer({
      Image: this.config.image,
      User: '0:0',
      Cmd: ['chown', `${SANDBOX_UID}:${SANDBOX_UID}`, WORKSPACE, '/cache'],
      Labels: this.labels(spec.sessionId, spec.buildId, 'prepare'),
      HostConfig: {
        CapDrop: ['ALL'],
        CapAdd: ['CHOWN'],
        SecurityOpt: ['no-new-privileges:true'],
        NetworkMode: 'none',
        Binds: [`${this.volumeName(spec.sessionId)}:${WORKSPACE}`, `${this.cacheName(spec.buildId)}:/cache`]
      }
    });
    try {
      await container.start();
      const { StatusCode } = await container.wait();
      if (StatusCode !== 0) throw new Error(`Volume preparation failed with exit code ${StatusCode}`);
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  /** A stopped helper container gives the API a path into the session volume. */
  private async withVolumeHelper<T>(sessionId: string, action: (container: Docker.Container) => Promise<T>): Promise<T> {
    const container = await this.docker.createContainer({
      Image: this.config.image,
      Cmd: ['true'],
      User: SANDBOX_USER,
      Labels: { [LABEL_MANAGED]: 'true', [LABEL_SESSION]: sessionId, [LABEL_ROLE]: 'files' },
      HostConfig: {
        NetworkMode: 'none',
        Binds: [`${this.volumeName(sessionId)}:${WORKSPACE}`]
      }
    });
    try {
      return await action(container);
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  async uploadWorkspace(sessionId: string, archive: Buffer): Promise<void> {
    await this.withVolumeHelper(sessionId, container =>
      container.putArchive(Readable.from([archive]), { path: WORKSPACE })
    );
  }

  async readWorkspaceFile(sessionId: string, relativePath: string): Promise<Buffer | null> {
    return this.withVolumeHelper(sessionId, async container => {
      let archive: NodeJS.ReadableStream;
      try {
        archive = await container.getArchive({ path: `${WORKSPACE}/${relativePath}` });
      } catch (err: any) {
        if (err.statusCode === 404) return null;
        throw err;
      }
      return readSingleRegularFile(archive);
    });
  }

  async startProcess(sessionId: string, spec: ProcessSpec, onOutput: OutputListener): Promise<ProcessHandle> {
    const buildId = await this.buildIdForSession(sessionId);

    const binds = [`${this.volumeName(sessionId)}:${WORKSPACE}`];
    if (spec.mountDependencyCache) binds.push(`${this.cacheName(buildId)}:/cache`);

    let container: Docker.Container;
    try {
      const egress = spec.network === 'registry' ? await this.startEgressProxy(sessionId, buildId) : null;
      const env = Object.entries({
        HOME: '/tmp',
        NODE_ENV: 'development',
        ...spec.env,
        ...(egress ? { HTTPS_PROXY: egress, https_proxy: egress } : {})
      }).map(([key, value]) => `${key}=${value}`);

      container = await this.docker.createContainer({
        Image: this.config.image,
        Cmd: spec.argv,
        User: SANDBOX_USER,
        WorkingDir: WORKSPACE,
        Env: env,
        Labels: this.labels(sessionId, buildId, 'process'),
        HostConfig: {
          ...hardenedHostConfig(this.config, spec.limits),
          Binds: binds,
          NetworkMode: this.networkName(sessionId)
        }
      });

      const stream = await container.attach({ stream: true, stdout: true, stderr: true });
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.on('data', chunk => onOutput('stdout', chunk.toString('utf-8')));
      stderr.on('data', chunk => onOutput('stderr', chunk.toString('utf-8')));
      this.docker.modem.demuxStream(stream, stdout, stderr);

      await container.start();

      const started = container;
      const exit = this.watchExit(started, stream).finally(() => this.stopEgressProxy(sessionId));
      return {
        id: started.id,
        wait: () => exit,
        stop: async () => {
          await started.stop({ t: STOP_GRACE_SECONDS }).catch(() => undefined);
        }
      };
    } catch (err) {
      await this.stopEgressProxy(sessionId);
      throw err;
    }
  }

  private async watchExit(container: Docker.Container, stream: NodeJS.ReadableStream): Promise<ProcessExit> {
    // The container can be force-removed at any moment, so this must always resolve
    const FORCE_REMOVED_EXIT = 137;
    // Listen first: the output can end before wait() returns
    const outputEnded = new Promise<void>(resolve => {
      stream.once('end', resolve);
      stream.once('close', resolve);
    });
    const status = await container.wait().catch(() => ({ StatusCode: FORCE_REMOVED_EXIT }));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([outputEnded, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]);
    clearTimeout(timer);
    const details = await container.inspect().catch(() => null);
    await container.remove({ force: true }).catch(() => undefined);
    return { exitCode: status.StatusCode, oomKilled: Boolean(details?.State?.OOMKilled) };
  }

  private async buildIdForSession(sessionId: string): Promise<string> {
    const volume = await this.docker.getVolume(this.volumeName(sessionId)).inspect();
    const buildId = volume.Labels?.[LABEL_BUILD];
    if (!buildId) throw new Error(`Environment ${sessionId} does not exist`);
    return buildId;
  }

  /** Lives only for an install, so a running project can never reach it. */
  private async startEgressProxy(sessionId: string, buildId: string): Promise<string> {
    const host = new URL(this.config.registryUrl).hostname;
    await this.ensureEdgeNetwork();
    const name = this.egressName(sessionId);
    const container = await this.docker.createContainer({
      name,
      Image: this.config.image,
      Cmd: ['node', '/opt/squadforge/egress-proxy.mjs'],
      User: SANDBOX_USER,
      Env: [`EGRESS_ALLOWED_HOSTS=${host}`, `EGRESS_LISTEN_PORT=${EGRESS_PORT}`],
      Labels: this.labels(sessionId, buildId, 'egress'),
      HostConfig: { ...hardenedHostConfig(this.config, SERVICE_LIMITS), NetworkMode: EDGE_NETWORK }
    });
    await this.docker.getNetwork(this.networkName(sessionId)).connect({ Container: container.id });
    await container.start();
    await this.waitForOutput(container, 'egress-proxy-ready');
    return `http://${name}:${EGRESS_PORT}`;
  }

  private async waitForOutput(container: Docker.Container, marker: string): Promise<void> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const logs = await container.logs({ stdout: true, stderr: false });
      if (logs.toString('utf-8').includes(marker)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('The dependency proxy did not start.');
  }

  private async stopEgressProxy(sessionId: string): Promise<void> {
    await this.docker.getContainer(this.egressName(sessionId)).remove({ force: true }).catch(() => undefined);
  }

  private async ensureEdgeNetwork(): Promise<void> {
    try {
      await this.docker.getNetwork(EDGE_NETWORK).inspect();
    } catch {
      await this.docker.createNetwork({
        Name: EDGE_NETWORK,
        Labels: { [LABEL_MANAGED]: 'true', [LABEL_ROLE]: 'edge' },
        Options: { 'com.docker.network.bridge.enable_icc': 'false' }
      }).catch(err => {
        if (err.statusCode !== 409) throw err;
      });
    }
  }

  private async execCapture(processId: string, cmd: string[]): Promise<string> {
    const exec = await this.docker.getContainer(processId).exec({
      Cmd: cmd,
      User: SANDBOX_USER,
      AttachStdout: true,
      AttachStderr: false
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const stdout = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on('data', chunk => chunks.push(chunk));
    this.docker.modem.demuxStream(stream, stdout, new PassThrough());
    await new Promise<void>((resolve, reject) => {
      stream.once('end', resolve);
      stream.once('error', reject);
    });
    return Buffer.concat(chunks).toString('utf-8');
  }

  async listeningPorts(processId: string): Promise<number[]> {
    const output = await this.execCapture(processId, ['cat', '/proc/net/tcp', '/proc/net/tcp6']);
    return parseListeningPorts(output);
  }

  async usage(processId: string): Promise<ResourceUsage | null> {
    try {
      const container = this.docker.getContainer(processId);
      const stats: any = await container.stats({ stream: false });
      const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
      const systemDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats.system_cpu_usage || 0);
      const cpuCount = stats.cpu_stats.online_cpus || 1;
      const disk = await this.execCapture(processId, ['du', '-sb', WORKSPACE]);
      return {
        memoryBytes: stats.memory_stats.usage || 0,
        memoryLimitBytes: stats.memory_stats.limit || 0,
        cpuPercent: systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0,
        pids: stats.pids_stats?.current || 0,
        workspaceBytes: Number.parseInt(disk, 10) || 0
      };
    } catch {
      return null;
    }
  }

  async openPreview(sessionId: string, processId: string, port: number): Promise<PreviewEndpoint> {
    await this.closePreview(sessionId);
    await this.ensureEdgeNetwork();

    const target = await this.docker.getContainer(processId).inspect();
    const address = target.NetworkSettings.Networks[this.networkName(sessionId)]?.IPAddress;
    if (!address) throw new Error('The project process has no address on its session network.');

    const buildId = await this.buildIdForSession(sessionId);
    const portKey = `${RELAY_PORT}/tcp`;
    const relay = await this.docker.createContainer({
      name: this.relayName(sessionId),
      Image: this.config.image,
      Cmd: ['node', '/opt/squadforge/relay.mjs'],
      User: SANDBOX_USER,
      Env: [`RELAY_TARGET_HOST=${address}`, `RELAY_TARGET_PORT=${port}`, `RELAY_LISTEN_PORT=${RELAY_PORT}`],
      Labels: this.labels(sessionId, buildId, 'relay'),
      ExposedPorts: { [portKey]: {} },
      HostConfig: {
        ...hardenedHostConfig(this.config, SERVICE_LIMITS),
        NetworkMode: EDGE_NETWORK,
        PortBindings: { [portKey]: [{ HostIp: this.config.previewBindIp, HostPort: '' }] }
      }
    });
    await this.docker.getNetwork(this.networkName(sessionId)).connect({ Container: relay.id });
    await relay.start();

    const details = await relay.inspect();
    const published = details.NetworkSettings.Ports?.[portKey]?.[0]?.HostPort;
    if (!published) throw new Error('The preview relay did not publish a port.');
    return { host: this.config.previewHost, port: Number(published) };
  }

  async closePreview(sessionId: string): Promise<void> {
    await this.docker.getContainer(this.relayName(sessionId)).remove({ force: true }).catch(() => undefined);
  }

  async destroyEnvironment(sessionId: string): Promise<void> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_SESSION}=${sessionId}`] }
    });
    await Promise.all(containers.map(c =>
      this.docker.getContainer(c.Id).remove({ force: true }).catch(() => undefined)
    ));
    await this.docker.getNetwork(this.networkName(sessionId)).remove().catch(() => undefined);
    await this.docker.getVolume(this.volumeName(sessionId)).remove().catch(() => undefined);
  }

  async removeDependencyCache(buildId: string): Promise<void> {
    await this.docker.getVolume(this.cacheName(buildId)).remove().catch(() => undefined);
  }

  async listEnvironments(): Promise<EnvironmentRecord[]> {
    const { Volumes } = await this.docker.listVolumes({
      filters: { label: [`${LABEL_MANAGED}=true`, `${LABEL_ROLE}=environment`] }
    });
    return (Volumes || []).flatMap(volume => {
      const sessionId = volume.Labels?.[LABEL_SESSION];
      const buildId = volume.Labels?.[LABEL_BUILD];
      return sessionId && buildId ? [{ sessionId, buildId }] : [];
    });
  }
}

/** Reads one file from a Docker archive stream. Links return null and are never followed. */
function readSingleRegularFile(archive: NodeJS.ReadableStream): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    let result: Buffer | null = null;
    extract.on('entry', (header, stream, next) => {
      if ((header.size || 0) > MAX_READ_BACK_BYTES) {
        extract.destroy(new Error('The file is too large to read back from the sandbox.'));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', chunk => {
        if (header.type === 'file') chunks.push(chunk as Buffer);
      });
      stream.on('end', () => {
        if (header.type === 'file' && result === null) result = Buffer.concat(chunks);
        next();
      });
      stream.resume();
    });
    extract.on('finish', () => resolve(result));
    extract.on('error', reject);
    archive.pipe(extract);
  });
}
