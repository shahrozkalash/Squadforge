import * as fs from 'fs';
import * as path from 'path';
import { findCsproj } from './packager.js';
import { stampCsprojVersion } from './versioning.js';

/** Stamp the release version into the project's .csproj in place. */
export function findCsprojSafe(workspaceRoot: string, version: string): string {
  const rel = findCsproj(workspaceRoot);
  const abs = path.join(workspaceRoot, rel);
  fs.writeFileSync(abs, stampCsprojVersion(fs.readFileSync(abs, 'utf8'), version), 'utf8');
  return rel;
}
