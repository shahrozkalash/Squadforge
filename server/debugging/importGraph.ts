import ts from 'typescript';
import { ProjectFile } from '../types.js';

const CODE_FILE = /\.(?:[cm]?[tj]sx?)$/;
const IMPORT_PATTERNS = [
  /\b(?:import|export)\s+(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
  /\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g
];
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

const TEST_SUPPORT = /(?:^|\/)(?:tests?|__tests__|__mocks__|fixtures)\/|(?:^|\/)test[-_]?(?:utils?|helpers?)\.|(?:^|\/)testUtils?\.|(?:^|\/)(?:setupTests|test[-_.]?setup|(?:jest|vitest)\.setup)\./i;

/** Includes helpers, because weakening one can make a failing test pass. */
export function isTestFile(path: string): boolean {
  return path.includes('.test.') || path.includes('.spec.') || TEST_SUPPORT.test(path);
}

/** Reads path aliases such as "@/*": ["src/*"]. tsconfig files may hold comments. */
function readPathAliases(files: ProjectFile[]): Array<{ prefix: string; targets: string[] }> {
  const config = files.find(file => file.path === 'tsconfig.json');
  if (!config) return [];
  try {
    const parsed = ts.parseConfigFileTextToJson('tsconfig.json', config.content).config;
    const baseUrl = String(parsed?.compilerOptions?.baseUrl || '.').replace(/^\.\/?/, '').replace(/\/$/, '');
    return Object.entries<string[]>(parsed?.compilerOptions?.paths || {}).map(([alias, targets]) => ({
      prefix: alias.replace(/\*$/, ''),
      targets: targets.map(target => [baseUrl, target.replace(/^\.\//, '').replace(/\*$/, '')].filter(Boolean).join('/'))
    }));
  } catch {
    return [];
  }
}

export function joinRelativePath(fromPath: string, specifier: string): string {
  const parts = fromPath.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.' && segment !== '') parts.push(segment);
  }
  return parts.join('/');
}

function resolveBase(base: string, known: Set<string>): string | undefined {
  for (const suffix of RESOLVE_SUFFIXES) {
    if (known.has(base + suffix)) return base + suffix;
  }
  const withoutJs = base.replace(/\.[cm]?jsx?$/, '');
  return ['.ts', '.tsx'].map(extension => withoutJs + extension).find(candidate => known.has(candidate));
}

/** Resolves a relative specifier to a project file, including "./x.js" written for x.ts. */
export function resolveRelativeImport(fromPath: string, specifier: string, known: Set<string>): string | undefined {
  return specifier.startsWith('.') ? resolveBase(joinRelativePath(fromPath, specifier), known) : undefined;
}

/** Maps each project file to the project files it imports. */
export function buildImportGraph(files: ProjectFile[]): Map<string, Set<string>> {
  const known = new Set(files.map(file => file.path));
  const aliases = readPathAliases(files);
  const graph = new Map<string, Set<string>>();
  const resolve = (from: string, specifier: string) => {
    const relative = resolveRelativeImport(from, specifier, known);
    if (relative) return relative;
    const alias = aliases.find(item => specifier.startsWith(item.prefix));
    return alias?.targets
      .map(target => resolveBase(target + specifier.slice(alias.prefix.length), known))
      .find(Boolean);
  };

  for (const file of files) {
    const imports = new Set<string>();
    if (CODE_FILE.test(file.path)) {
      for (const pattern of IMPORT_PATTERNS) {
        for (const match of file.content.matchAll(pattern)) {
          const target = resolve(file.path, match[1]);
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

const COMPUTED_IMPORT = /\b(?:import|require)\(\s*(?:[^'"`\s)]|`[^`]*\$\{)/;

/** Test files that reach a changed file through imports, or every test if imports are computed. */
export function selectAffectedTests(files: ProjectFile[], changedPaths: string[]): string[] {
  const tests = files.map(file => file.path).filter(isTestFile);
  // A computed path can load anything, so no test can be ruled out
  if (files.some(file => CODE_FILE.test(file.path) && COMPUTED_IMPORT.test(file.content))) return tests.sort();

  const reached = dependentsOf(buildImportGraph(files), changedPaths);
  return tests.filter(path => reached.has(path)).sort();
}

/** Some GET routes change things in spite of the method, so a probe leaves them alone. */
const UNSAFE_ROUTE = /logout|signout|sign-out|seed|reset|delete|remove|clear|drop|purge|migrate|install|shutdown/i;
const GET_ROUTE = /\b(?:app|router|server)\.get\(\s*['"](\/[^'":*?]*)['"]/g;

/** GET routes with no parameters. These are the only routes safe to call without knowing the app. */
export function detectGetRoutes(files: ProjectFile[]): Array<{ path: string; filePath: string }> {
  const routes = new Map<string, string>();
  for (const file of files) {
    if (!CODE_FILE.test(file.path) || isTestFile(file.path)) continue;
    for (const match of file.content.matchAll(GET_ROUTE)) {
      if (!routes.has(match[1]) && !UNSAFE_ROUTE.test(match[1])) routes.set(match[1], file.path);
    }
  }
  return Array.from(routes, ([path, filePath]) => ({ path, filePath }));
}
