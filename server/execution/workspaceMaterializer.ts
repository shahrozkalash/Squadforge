import crypto from 'node:crypto';
import tar from 'tar-stream';
import { ProjectFile } from '../types.js';
import { ExecutionAdapter } from '../swarm/executionAdapter.js';

const SANDBOX_UID = 10001;

/** Files the sandbox must never read from the project, because they can redirect installs. */
const INSTALL_CONFIG_FILES = new Set(['.npmrc', '.yarnrc', '.yarnrc.yml']);

export interface MaterializedWorkspace {
  archive: Buffer;
  hash: string;
  fileCount: number;
}

function cleanFiles(files: ProjectFile[]): Array<{ path: string; content: string }> {
  const cleaned = files.map(file => {
    const { valid, cleanPath, error } = ExecutionAdapter.sanitizeFilePath(file.path);
    if (!valid) throw new Error(`Unsafe project path "${file.path}": ${error || 'rejected'}`);
    return { path: cleanPath, content: file.content };
  });
  return cleaned
    .filter(file => !INSTALL_CONFIG_FILES.has(file.path.split('/').pop() || ''))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Identifies exactly what will run. Approvals are tied to this value. */
export function hashWorkspace(files: ProjectFile[]): string {
  const hash = crypto.createHash('sha256');
  for (const file of cleanFiles(files)) {
    hash.update(file.path).update('\0').update(file.content).update('\0');
  }
  return hash.digest('hex');
}

/**
 * Builds the archive uploaded to the sandbox. Only regular file entries are created,
 * so a project cannot add links or write outside its workspace.
 */
export async function materializeWorkspace(files: ProjectFile[]): Promise<MaterializedWorkspace> {
  const cleaned = cleanFiles(files);
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on('data', chunk => chunks.push(chunk as Buffer));
  const finished = new Promise<void>((resolve, reject) => {
    pack.on('end', resolve);
    pack.on('error', reject);
  });

  for (const file of cleaned) {
    pack.entry(
      { name: file.path, type: 'file', mode: 0o644, uid: SANDBOX_UID, gid: SANDBOX_UID },
      file.content
    );
  }
  pack.finalize();
  await finished;

  return { archive: Buffer.concat(chunks), hash: hashWorkspace(files), fileCount: cleaned.length };
}
