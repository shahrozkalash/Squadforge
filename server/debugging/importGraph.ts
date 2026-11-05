import { ProjectFile } from '../types.js';

const CODE_FILE = /\.(?:[cm]?[tj]sx?)$/;
const IMPORT_PATTERNS = [
  /\b(?:import|export)\s+(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
  /\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g
];
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

export function isTestFile(path: string): boolean {
  return path.includes('.test.') || path.includes('.spec.') || path.startsWith('tests/');
}

/** Resolves a relative specifier to a project file, including "./x.js" written for x.ts. */
export function resolveRelativeImport(fromPath: string, specifier: string, known: Set<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined;

  const parts = fromPath.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.' && segment !== '') parts.push(segment);
  }
  const base = parts.join('/');

  for (const suffix of RESOLVE_SUFFIXES) {
    if (known.has(base + suffix)) return base + suffix;
  }
  const withoutJs = base.replace(/\.[cm]?jsx?$/, '');
  return ['.ts', '.tsx'].map(extension => withoutJs + extension).find(candidate => known.has(candidate));
}

/** Maps each project file to the project files it imports. */
export function buildImportGraph(files: ProjectFile[]): Map<string, Set<string>> {
  const known = new Set(files.map(file => file.path));
  const graph = new Map<string, Set<string>>();

  for (const file of files) {
    const imports = new Set<string>();
    if (CODE_FILE.test(file.path)) {
      for (const pattern of IMPORT_PATTERNS) {
        for (const match of file.content.matchAll(pattern)) {
          const target = resolveRelativeImport(file.path, match[1], known);
          if (target && target !== file.path) imports.add(target);
        }
      }
    }
    graph.set(file.path, imports);
  }
  return graph;
}

/** Every file that depends on the given files, directly or not, including those files. */
export function dependentsOf(graph: Map<string, Set<string>>, paths: string[]): Set<string> {
  const reverse = new Map<string, string[]>();
  for (const [from, targets] of graph) {
    for (const target of targets) reverse.set(target, [...(reverse.get(target) || []), from]);
  }

  const seen = new Set(paths);
  const queue = [...paths];
  while (queue.length > 0) {
    for (const importer of reverse.get(queue.pop()!) || []) {
      if (!seen.has(importer)) {
        seen.add(importer);
        queue.push(importer);
      }
    }
  }
  return seen;
}

/** Test files that reach a changed file through imports. Dynamic paths cannot be followed. */
export function selectAffectedTests(files: ProjectFile[], changedPaths: string[]): string[] {
  const reached = dependentsOf(buildImportGraph(files), changedPaths);
  return files.map(file => file.path).filter(path => isTestFile(path) && reached.has(path)).sort();
}
