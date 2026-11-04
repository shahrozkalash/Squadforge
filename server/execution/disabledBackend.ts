import { BackendCapabilities, ExecutionBackend } from './executionBackend.js';

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

  createEnvironment = async () => refuse();
  uploadWorkspace = async () => refuse();
  readWorkspaceFile = async () => refuse();
  startProcess = async () => refuse();
  listeningPorts = async () => refuse();
  usage = async () => refuse();
  openPreview = async () => refuse();
  closePreview = async () => undefined;
  destroyEnvironment = async () => undefined;
  removeDependencyCache = async () => undefined;
  listEnvironments = async () => [];
}
