import crypto from 'node:crypto';
import {
  AgentRole,
  DebugDiagnostic,
  ProjectFile,
  RepairLesson,
  RootCause,
  RootCauseCategory
} from '../types.js';
import { buildImportGraph, dependentsOf, isTestFile, resolveRelativeImport } from './importGraph.js';

/** Earlier categories are fixed first, because they stop later checks from seeing the truth. */
const CATEGORY_ORDER: RootCauseCategory[] = [
  'syntax_error',
  'config_error',
  'missing_dependency',
  'missing_module',
  'missing_export',
  'undefined_symbol',
  'type_mismatch',
  'null_access',
  'contract_violation',
  'build_failure',
  'runtime_crash',
  'api_failure',
  'test_failure',
  'resource_limit'
];

const LEAD_AGENT: Record<RootCauseCategory, AgentRole> = {
  syntax_error: 'debugging_specialist',
  config_error: 'devops_release_specialist',
  missing_dependency: 'devops_release_specialist',
  missing_module: 'integration_specialist',
  missing_export: 'integration_specialist',
  undefined_symbol: 'debugging_specialist',
  type_mismatch: 'debugging_specialist',
  null_access: 'debugging_specialist',
  contract_violation: 'integration_specialist',
  build_failure: 'devops_release_specialist',
  runtime_crash: 'debugging_specialist',
  api_failure: 'backend_developer',
  test_failure: 'qa_testing_specialist',
  resource_limit: 'performance_engineer'
};

const TS_CATEGORIES: Record<string, RootCauseCategory> = {
  TS2305: 'missing_export',
  TS2614: 'missing_export',
  TS2724: 'missing_export',
  TS2304: 'undefined_symbol',
  TS2552: 'undefined_symbol',
  TS2531: 'null_access',
  TS2532: 'null_access',
  TS18047: 'null_access',
  TS18048: 'null_access'
};

export function classifyDiagnostic(item: DebugDiagnostic): RootCauseCategory {
  switch (item.kind) {
    case 'syntax': return 'syntax_error';
    case 'dependency': return 'missing_dependency';
    case 'config': return 'config_error';
    case 'contract': return 'contract_violation';
    case 'build': return 'build_failure';
    case 'test': return 'test_failure';
    case 'api': return 'api_failure';
    case 'integration':
      if (item.code === 'missing_imported_file') return 'missing_module';
      if (item.code === 'unexported_identifier' || item.code === 'invalid_default_import') return 'missing_export';
      return 'contract_violation';
    case 'type':
      if (item.code === 'TS2307') {
        return /'\.{1,2}\//.test(item.message) ? 'missing_module' : 'missing_dependency';
      }
      return TS_CATEGORIES[item.code || ''] || 'type_mismatch';
    case 'runtime':
      if (item.code === 'out_of_memory' || item.code === 'timed_out' || item.code === 'disk_limit') return 'resource_limit';
      if (/Cannot find module/.test(item.message)) {
        return /Cannot find module '\.{1,2}\//.test(item.message) ? 'missing_module' : 'missing_dependency';
      }
      if (/is not defined/.test(item.message)) return 'undefined_symbol';
      if (/Cannot read propert|undefined is not|of undefined|of null/.test(item.message)) return 'null_access';
      return 'runtime_crash';
  }
}

/** The file to change is sometimes not the one that reported the error. */
function culpritFile(item: DebugDiagnostic, known: Set<string>): string | undefined {
  if (item.relatedFile && known.has(item.relatedFile)) return item.relatedFile;
  if (item.kind === 'type' && item.filePath) {
    const module = item.message.match(/Module '"([^"]+)"'/)?.[1];
    const target = module && resolveRelativeImport(item.filePath, module, known);
    if (target) return target;
  }
  return item.filePath && known.has(item.filePath) ? item.filePath : undefined;
}

function confidenceOf(group: DebugDiagnostic[], primaryFile: string | undefined): RootCause['confidence'] {
  if (!primaryFile) return 'low';
  if (group.some(item => item.source === 'static')) return 'high';
  return group.some(item => item.source === 'sandbox') ? 'medium' : 'low';
}

function latestChange(file: ProjectFile | undefined): string | undefined {
  const entry = file?.history?.[file.history.length - 1];
  if (!entry) return undefined;
  const message = entry.commitMessage ? `: ${entry.commitMessage.slice(0, 120)}` : '';
  return `${file!.path} last changed at v${entry.version} by ${entry.authorModel}${message}`;
}

export class RootCauseEngine {
  /**
   * Groups diagnostics by what explains them, using the import graph to separate causes from
   * their consequences. The result is ranked so the first cause is the one to fix first.
   */
  static analyze(files: ProjectFile[], diagnostics: DebugDiagnostic[], lessons: RepairLesson[] = []): RootCause[] {
    const known = new Set(files.map(file => file.path));
    const graph = buildImportGraph(files);

    // A file that cannot parse makes everything importing it report errors too
    const brokenFiles = diagnostics.filter(item => item.kind === 'syntax' && item.filePath).map(item => item.filePath!);
    const brokenReach = new Map(brokenFiles.map(file => [file, dependentsOf(graph, [file])]));

    const groups = new Map<string, { category: RootCauseCategory; primaryFile?: string; direct: DebugDiagnostic[]; cascaded: DebugDiagnostic[] }>();
    const groupFor = (category: RootCauseCategory, primaryFile: string | undefined) => {
      const key = `${category}:${primaryFile || 'project'}`;
      if (!groups.has(key)) groups.set(key, { category, primaryFile, direct: [], cascaded: [] });
      return groups.get(key)!;
    };

    for (const item of diagnostics) {
      if (item.kind === 'syntax') {
        groupFor('syntax_error', item.filePath).direct.push(item);
        continue;
      }
      const origin = item.filePath
        ? brokenFiles.find(file => brokenReach.get(file)!.has(item.filePath!))
        : undefined;
      if (origin) {
        groupFor('syntax_error', origin).cascaded.push(item);
        continue;
      }
      groupFor(classifyDiagnostic(item), culpritFile(item, known)).direct.push(item);
    }

    const causes = Array.from(groups.entries()).map(([key, group]): RootCause => {
      const all = [...group.direct, ...group.cascaded];
      const lead = group.direct[0];
      const fingerprints = group.direct.map(item => item.fingerprint);
      const evidence = group.direct.slice(0, 6).map(item =>
        `[${item.kind}/${item.source}] ${item.filePath || 'project'}${item.line ? `:${item.line}` : ''}: ${item.message}`
      );

      if (group.cascaded.length > 0) {
        evidence.push(`${group.cascaded.length} other diagnostic(s) come from files importing ${group.primaryFile}.`);
      }
      const history = latestChange(files.find(file => file.path === group.primaryFile));
      if (history) evidence.push(history);

      const related = lessons.filter(lesson => lesson.fingerprints.some(print => fingerprints.includes(print)));
      for (const lesson of related.slice(0, 3)) {
        evidence.push(lesson.outcome === 'verified'
          ? `This project verified a fix for this problem before: ${lesson.summary}`
          : `An earlier fix for this problem failed: ${lesson.summary}`);
      }

      return {
        id: `rc_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)}`,
        category: group.category,
        summary: `${group.category.replace(/_/g, ' ')}${group.primaryFile ? ` in ${group.primaryFile}` : ''}: ${lead.message}`.slice(0, 300),
        confidence: confidenceOf(group.direct, group.primaryFile),
        primaryFile: group.primaryFile,
        line: lead.line,
        affectedFiles: Array.from(new Set(all.map(item => item.filePath).filter((p): p is string => Boolean(p) && known.has(p!)))),
        fingerprints,
        cascadedFingerprints: group.cascaded.map(item => item.fingerprint),
        evidence,
        leadAgent: LEAD_AGENT[group.category]
      };
    });

    return causes.sort((a, b) =>
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
      (b.fingerprints.length + b.cascadedFingerprints.length) - (a.fingerprints.length + a.cascadedFingerprints.length) ||
      a.id.localeCompare(b.id)
    );
  }

  /**
   * Files a repair may touch: those in the evidence and the primary file's direct neighbours.
   * Tests stay out unless the evidence is in them, so a repair cannot pass by editing its check.
   */
  static repairScope(cause: RootCause, files: ProjectFile[]): string[] {
    const graph = buildImportGraph(files);
    const scope = new Set(cause.affectedFiles);

    if (cause.primaryFile) {
      scope.add(cause.primaryFile);
      for (const target of graph.get(cause.primaryFile) || []) scope.add(target);
      for (const [from, targets] of graph) {
        if (targets.has(cause.primaryFile)) scope.add(from);
      }
    }
    if (cause.category === 'missing_dependency' && files.some(file => file.path === 'package.json')) {
      scope.add('package.json');
    }

    const evidenceInTest = cause.primaryFile ? isTestFile(cause.primaryFile) : false;
    return Array.from(scope).filter(path => evidenceInTest || cause.affectedFiles.includes(path) || !isTestFile(path)).sort();
  }
}
