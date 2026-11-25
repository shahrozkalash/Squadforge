import {
  BackendCapabilities,
  EnvironmentSpec,
  ExecutionBackend,
  OutputListener,
  ProcessSpec,
  WorkerDiagnostics
} from './executionBackend.js';

const UNAVAILABLE = 'Project execution is not configured on this server.';

/** The default backend. It reports execution as unavailable and never runs anything. */
export class DisabledBackend implements ExecutionBackend {
  readonly name = 'disabled';

  constructor(private readonly unavailableReason: string = UNAVAILABLE) {}

  private refuse(): never {
    throw new Error(this.unavailableReason);
  }

  async capabilities(): Promise<BackendCapabilities> {
    return { available: false, backend: this.name, reason: this.unavailableReason };
  }

  async diagnostics(): Promise<WorkerDiagnostics> {
    return {
      backend: this.name,
      available: false,
      checkedAt: Date.now(),
      configError: this.unavailableReason
    };
  }

  createEnvironment = async (_spec?: EnvironmentSpec) => this.refuse();
  uploadWorkspace = async (_sessionId?: string, _tar?: Buffer) => this.refuse();
  readWorkspaceFile = async (_sessionId?: string, _relativePath?: string) => this.refuse();
  startProcess = async (_sessionId?: string, _spec?: ProcessSpec, _onOutput?: OutputListener) => this.refuse();
  listeningPorts = async (_processId?: string) => this.refuse();
  usage = async (_processId?: string) => this.refuse();
  openPreview = async (_sessionId?: string, _processId?: string, _port?: number) => this.refuse();
  closePreview = async (_sessionId?: string) => undefined;
  destroyEnvironment = async (_sessionId?: string) => undefined;
  removeDependencyCache = async (_buildId?: string) => undefined;
  listEnvironments = async () => [];
}
