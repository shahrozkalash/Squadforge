import { DesktopEnvironmentAdapter, DesktopEnvironmentOptions } from './desktopEnvironment.js';
import {
  EnvironmentKind,
  FactoryEnvironment
} from './environmentContract.js';
import { WebEnvironmentAdapter } from './webEnvironment.js';

export * from './environmentContract.js';
export * from './webEnvironment.js';
export * from './desktopEnvironment.js';

export interface EnvironmentFactoryOptions extends DesktopEnvironmentOptions {
  /** Platform user owning web-environment projects. */
  userId?: string;
}

/**
 * Creates the environment adapter for a kind — the single place
 * category workflows obtain an environment. Mirrors the wiring style
 * of server/execution/index.ts (backend selected in one module,
 * consumers hold only the interface).
 */
export function createEnvironment(
  kind: EnvironmentKind,
  options: EnvironmentFactoryOptions = {}
): FactoryEnvironment {
  switch (kind) {
    case 'web':
      return new WebEnvironmentAdapter({ userId: options.userId ?? 'factory-environment-user' });
    case 'desktop':
      return new DesktopEnvironmentAdapter({
        workspaceRoot: options.workspaceRoot,
        artifactsRoot: options.artifactsRoot,
        platform: options.platform
      });
    default:
      throw new Error(`Unknown environment kind: ${String(kind)}`);
  }
}

export function listEnvironmentKinds(): EnvironmentKind[] {
  return ['web', 'desktop'];
}
