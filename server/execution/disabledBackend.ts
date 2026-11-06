import {
  BackendCapabilities,
  EnvironmentSpec,
  ExecutionBackend,
  OutputListener,
  ProcessSpec
} from './executionBackend.js';

const UNAVAILABLE = 'Project execution is not configured on this server.';

function refuse(): never {
  throw new Error(UNAVAILABLE);
}

/** The default backend. It reports execution as unavailable and never runs anything. */
export class DisabledBackend implements ExecutionBackend {
  readonly name = 'disabled';

  async capabilities(): Promise<BackendCapabilities> {
    return { available: false, backend: this.name, reason: UNAVAILABLE };
  }

  createEnvironment = async (_spec?: EnvironmentSpec) => refuse();
  uploadWorkspace = async (_sessionId?: string, _tar?: Buffer) => refuse();
  readWorkspaceFile = async (_sessionId?: string, _relativePath?: string) => refuse();
  startProcess = async (_sessionId?: string, _spec?: ProcessSpec, _onOutput?: OutputListener) => refuse();
  listeningPorts = async (_processId?: string) => refuse();
  usage = async (_processId?: string) => refuse();
  openPreview = async (_sessionId?: string, _processId?: string, _port?: number) => refuse();
  closePreview = async (_sessionId?: string) => undefined;
  destroyEnvironment = async (_sessionId?: string) => undefined;
  removeDependencyCache = async (_buildId?: string) => undefined;
  listEnvironments = async () => [];
}
