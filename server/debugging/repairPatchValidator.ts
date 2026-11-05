import crypto from 'node:crypto';
import { computeContentHash } from '../store.js';
import {
  DebugDiagnostic,
  DiagnosticCheck,
  PatchValidationCheck,
  ProjectContract,
  ProjectFile,
  RepairPatchValidation,
  RootCause
} from '../types.js';
import { ExecutionAdapter } from '../swarm/executionAdapter.js';
import { runStaticChecks } from './staticChecks.js';
import { isTestFile, joinRelativePath } from './importGraph.js';

const MAX_CHANGED_LINES = 80;
const MAX_FILES_CHANGED = 5;
/** Past this share of a file, a patch is a rewrite rather than a repair. */
const MAX_REWRITE_RATIO = 0.6;
const MIN_LINES_FOR_RATIO = 30;

/** Hiding an error is not fixing it, and neither is switching off the test that found it. */
const SUPPRESSIONS = [
  /@ts-ignore/,
  /@ts-nocheck/,
  /@ts-expect-error/,
  /eslint-disable/,
  /\b(?:it|test|describe)\.(?:skip|only|todo)\b/,
  /\bx(?:it|describe)\(/
];

export interface RepairAction {
  action: 'patch_file' | 'create_file';
  path: string;
  edits?: Array<{ find: string; replace: string }>;
  content?: string;
  commitMessage?: string;
  expectedVersion?: number;
  expectedContentHash?: string;
}

export interface ValidationContext {
  buildId: string;
  files: ProjectFile[];
  /** Everything wrong with the workspace before the patch. */
  baseline: DebugDiagnostic[];
  baselineChecks: DiagnosticCheck[];
  cause: RootCause;
  scope: string[];
  contracts: ProjectContract[];
  /** Patches this project already saw fail. */
  failedPatches: Set<string>;
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length;
}

/** Counts lines that differ, ignoring the context repeated around a change. */
function changedLineCount(find: string, replace: string): number {
  const before = find.split('\n');
  const after = replace.split('\n');
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) end++;
  return Math.max(before.length - start - end, after.length - start - end);
}

export class RepairPatchValidator {
  /** Keeps only what a repair may do, with one action per file. Anything else is reported. */
  static normalize(rawActions: any[]): { actions: RepairAction[]; rejected: string[] } {
    const byPath = new Map<string, RepairAction>();
    const rejected: string[] = [];

    for (const raw of rawActions) {
      if (raw?.action !== 'patch_file' && raw?.action !== 'create_file') {
        rejected.push(`Action "${raw?.action}" is not allowed in a repair`);
        continue;
      }
      const { valid, cleanPath, error } = ExecutionAdapter.sanitizeFilePath(String(raw.path ?? ''));
      if (!valid) {
        rejected.push(`Invalid path "${raw.path}": ${error}`);
        continue;
      }

      const existing = byPath.get(cleanPath);
      if (raw.action === 'create_file') {
        if (existing) rejected.push(`More than one change to ${cleanPath}`);
        else byPath.set(cleanPath, { action: 'create_file', path: cleanPath, content: String(raw.content ?? ''), commitMessage: raw.commitMessage });
        continue;
      }

      const edits = (Array.isArray(raw.edits) ? raw.edits : []).map((edit: any) => ({
        find: String(edit?.find ?? ''),
        replace: String(edit?.replace ?? '')
      }));
      if (existing?.action === 'patch_file') existing.edits!.push(...edits);
      else if (existing) rejected.push(`More than one change to ${cleanPath}`);
      else byPath.set(cleanPath, { action: 'patch_file', path: cleanPath, edits, commitMessage: raw.commitMessage });
    }

    return { actions: Array.from(byPath.values()), rejected };
  }

  /** Identifies a change, so a patch that already failed is not tried again. */
  static fingerprintPatch(actions: RepairAction[]): string {
    const canonical = actions
      .map(action => [action.path, action.action, action.edits ?? action.content])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
  }

  /** Applies a patch to copies, with the same exact-match rules as the real write. */
  static applyToCopy(files: ProjectFile[], actions: RepairAction[]): { files?: ProjectFile[]; error?: string } {
    const copy = new Map(files.map(file => [file.path, { ...file }]));

    for (const action of actions) {
      const file = copy.get(action.path);
      if (action.action === 'create_file') {
        if (file) return { error: `${action.path} already exists, so it can only be patched.` };
        copy.set(action.path, { path: action.path, content: action.content || '', version: 0 } as ProjectFile);
        continue;
      }

      if (!file) return { error: `${action.path} does not exist.` };
      let content = file.content;
      for (const edit of action.edits || []) {
        if (!edit.find) return { error: `An edit to ${action.path} has empty "find" text.` };
        const occurrences = content.split(edit.find).length - 1;
        if (occurrences !== 1) {
          return { error: `"find" text appears ${occurrences} time(s) in ${action.path}. It must appear exactly once.` };
        }
        content = content.replace(edit.find, () => edit.replace);
      }
      if (content === file.content) return { error: `The edits to ${action.path} change nothing.` };
      if (!content.trim()) return { error: `The edits would empty ${action.path}.` };
      file.content = content;
      file.contentHash = computeContentHash(content);
    }

    return { files: Array.from(copy.values()) };
  }

  private static minimality(actions: RepairAction[], files: ProjectFile[]): { lines: number; problem?: string } {
    let lines = 0;
    for (const action of actions) {
      if (action.action === 'create_file') {
        lines += lineCount(action.content || '');
        continue;
      }

      const original = files.find(file => file.path === action.path);
      const changed = (action.edits || []).reduce((sum, edit) => sum + changedLineCount(edit.find, edit.replace), 0);
      lines += changed;

      const size = lineCount(original?.content || '');
      if (size >= MIN_LINES_FOR_RATIO && changed / size > MAX_REWRITE_RATIO) {
        return { lines, problem: `The patch rewrites ${changed} of ${size} lines in ${action.path}.` };
      }
    }
    if (actions.length > MAX_FILES_CHANGED) return { lines, problem: `The patch changes ${actions.length} files. The limit is ${MAX_FILES_CHANGED}.` };
    if (lines > MAX_CHANGED_LINES) return { lines, problem: `The patch changes ${lines} lines. The limit is ${MAX_CHANGED_LINES}.` };
    return { lines };
  }

  /** Where the failing imports expect a module to be, without an extension. */
  private static missingModulePaths(context: ValidationContext): Set<string> {
    const paths = new Set<string>();
    if (context.cause.category !== 'missing_module') return paths;

    for (const item of context.baseline) {
      if (!context.cause.fingerprints.includes(item.fingerprint) || !item.filePath) continue;
      const importer = context.files.find(file => file.path === item.filePath)?.content || '';
      for (const match of item.message.matchAll(/['"](\.{1,2}\/[^'"]+)['"]/g)) {
        // Output can claim anything, so the import must really be in the file
        if (!importer.includes(match[1])) continue;
        paths.add(joinRelativePath(item.filePath, match[1]).replace(/\.[cm]?[tj]sx?$/, ''));
      }
    }
    return paths;
  }

  private static outOfScope(actions: RepairAction[], context: ValidationContext): string[] {
    const missing = this.missingModulePaths(context);
    const isMissingFile = (action: RepairAction) => {
      const withoutExtension = action.path.replace(/\.[cm]?[tj]sx?$/, '');
      return action.action === 'create_file' && withoutExtension !== action.path &&
        (missing.has(withoutExtension) || missing.has(withoutExtension.replace(/\/index$/, '')));
    };
    return actions
      .filter(action => !context.scope.includes(action.path) && !isMissingFile(action))
      .map(action => action.path);
  }

  private static addedText(action: RepairAction): string {
    return action.action === 'create_file'
      ? action.content || ''
      : (action.edits || []).map(edit => edit.replace).join('\n');
  }

  private static suppression(actions: RepairAction[]): string | undefined {
    for (const action of actions) {
      const removed = (action.edits || []).map(edit => edit.find).join('\n');
      const added = this.addedText(action);
      const match = SUPPRESSIONS.find(pattern => pattern.test(added) && !pattern.test(removed));
      if (match) return `${action.path} adds ${match.source.replace(/\\/g, '')}`;
    }
    return undefined;
  }

  /**
   * A syntax error garbles the code after it, so fixing one can reveal errors that were always
   * there. A new error outside the lines the patch touched is one of those, and on those lines it
   * is the patch's own fault. Either way the run cannot end as verified.
   */
  static splitRevealed(
    cause: RootCause,
    baseline: DebugDiagnostic[],
    after: DebugDiagnostic[],
    actions: RepairAction[],
    files: ProjectFile[]
  ): { comparable: DebugDiagnostic[]; revealed: DebugDiagnostic[] } {
    if (cause.category !== 'syntax_error') return { comparable: after, revealed: [] };

    const known = new Set(baseline.map(item => item.fingerprint));
    const ranges = new Map<string, Array<[number, number]> | 'whole_file'>();
    for (const action of actions) {
      const content = files.find(file => file.path === action.path)?.content || '';
      const edits = action.edits || [];
      // A deletion leaves no text to find, and a new file is all patch
      if (action.action !== 'patch_file' || edits.some(edit => !edit.replace)) {
        ranges.set(action.path, 'whole_file');
        continue;
      }
      const lines: Array<[number, number]> = [];
      for (const edit of edits) {
        for (let index = content.indexOf(edit.replace); index >= 0; index = content.indexOf(edit.replace, index + 1)) {
          const start = content.slice(0, index).split('\n').length;
          lines.push([start, start + edit.replace.split('\n').length - 1]);
        }
      }
      ranges.set(action.path, lines);
    }

    // Garbled code hides errors in its own file. Anything new elsewhere came from the patch
    const couldBeHidden = (item: DebugDiagnostic) => {
      const lines = item.filePath === cause.primaryFile && item.filePath ? ranges.get(item.filePath) : undefined;
      if (!lines || lines === 'whole_file' || (item.kind !== 'type' && item.kind !== 'integration')) return false;
      // With no line it cannot be pinned on the patch, and being revealed still blocks verified
      return item.line === undefined || !lines.some(([from, to]) => item.line! >= from && item.line! <= to);
    };
    const isRevealed = (item: DebugDiagnostic) => !known.has(item.fingerprint) && couldBeHidden(item);
    return { comparable: after.filter(item => !isRevealed(item)), revealed: after.filter(isRevealed) };
  }

  /** Compares a finished state with the baseline. Used on the dry run and on the real result. */
  static compare(cause: RootCause, baseline: DebugDiagnostic[], after: DebugDiagnostic[]) {
    const before = new Map(baseline.map(item => [item.fingerprint, item]));
    const remaining = new Set(after.map(item => item.fingerprint));
    const staticTargets = cause.fingerprints.filter(print => before.get(print)?.source === 'static');

    return {
      clearedFingerprints: staticTargets.filter(print => !remaining.has(print)),
      remainingFingerprints: staticTargets.filter(print => remaining.has(print)),
      newDiagnostics: after
        .filter(item => !before.has(item.fingerprint))
        .map(item => `[${item.kind}] ${item.filePath || 'project'}: ${item.message}`),
      needsRuntimeProof: cause.fingerprints.filter(print => before.get(print)?.source !== 'static')
    };
  }

  /**
   * Decides whether a patch may be applied. Nothing is written. The dry run re-checks a copy of
   * the project, so a patch passes only if its target is gone and nothing new is wrong.
   */
  static async validate(context: ValidationContext, rawActions: any[], signal?: AbortSignal): Promise<RepairPatchValidation> {
    const { actions, rejected } = this.normalize(rawActions);
    const checks: PatchValidationCheck[] = [];
    const add = (name: string, passed: boolean, detail?: string) => checks.push({ name, passed, detail });
    const patchFingerprint = this.fingerprintPatch(actions);
    const result = (extra: Partial<RepairPatchValidation> = {}): RepairPatchValidation => ({
      passed: checks.every(check => check.passed),
      patchFingerprint,
      checks,
      changedLines: 0,
      clearedFingerprints: [],
      remainingFingerprints: context.cause.fingerprints,
      newDiagnostics: [],
      needsRuntimeProof: [],
      revealedDiagnostics: [],
      ...extra
    });

    add('allowed_actions', rejected.length === 0 && actions.length > 0, rejected.join('; ') || (actions.length ? undefined : 'The patch changes nothing'));

    const outside = this.outOfScope(actions, context);
    add('scope', outside.length === 0, outside.length ? `Outside the evidence for this problem: ${outside.join(', ')}` : undefined);

    if (context.cause.category === 'test_failure') {
      const edited = actions.filter(action => isTestFile(action.path)).map(action => action.path);
      add('tests_unchanged', edited.length === 0, edited.length ? `A test failure cannot be fixed by editing ${edited.join(', ')}` : undefined);
    }

    const suppressed = this.suppression(actions);
    add('no_suppression', !suppressed, suppressed);

    add('not_tried_before', !context.failedPatches.has(patchFingerprint), context.failedPatches.has(patchFingerprint) ? 'This exact patch already failed in this project' : undefined);

    const { lines, problem } = this.minimality(actions, context.files);
    add('minimal', !problem, problem);

    const applied = this.applyToCopy(context.files, actions);
    add('applies_cleanly', Boolean(applied.files), applied.error);

    // The checks below are slow, and the answer is already known
    if (!applied.files || checks.some(check => !check.passed)) return result({ changedLines: lines });

    const before = ExecutionAdapter.auditSecurity(context.files).findings.map(finding => JSON.stringify(finding));
    const newFindings = ExecutionAdapter.auditSecurity(applied.files).findings
      .map(finding => JSON.stringify(finding))
      .filter(finding => !before.includes(finding));
    add('security_audit', newFindings.length === 0, newFindings.length ? `New findings: ${newFindings.join('; ').slice(0, 400)}` : undefined);

    const candidate = await runStaticChecks(context.buildId, applied.files, context.contracts, signal);

    const ranBefore = new Set(context.baselineChecks.filter(check => check.status !== 'skipped').map(check => check.name));
    const stopped = candidate.checks.filter(check => check.status === 'skipped' && ranBefore.has(check.name));
    add('checks_still_run', stopped.length === 0, stopped.length ? `No longer checked: ${stopped.map(check => check.name).join(', ')}` : undefined);

    // Errors from a check that could not run before are not caused by this patch
    const skippedBefore = new Set(context.baselineChecks.filter(check => check.status === 'skipped').map(check => check.name));
    const { comparable, revealed } = this.splitRevealed(
      context.cause,
      context.baseline,
      candidate.diagnostics.filter(item => !skippedBefore.has(item.kind)),
      actions,
      applied.files
    );
    const comparison = this.compare(context.cause, context.baseline, comparable);

    add('target_cleared', comparison.remainingFingerprints.length === 0, comparison.remainingFingerprints.length
      ? `${comparison.remainingFingerprints.length} target diagnostic(s) remain after the patch`
      : undefined);
    add('no_regressions', comparison.newDiagnostics.length === 0, comparison.newDiagnostics.slice(0, 5).join('; ') || undefined);

    return result({
      changedLines: lines,
      ...comparison,
      revealedDiagnostics: revealed.map(item => `[${item.kind}] ${item.filePath || 'project'}: ${item.message}`)
    });
  }
}
