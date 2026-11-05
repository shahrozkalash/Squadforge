import crypto from 'node:crypto';
import { db } from '../store.js';
import {
  DebugDiagnostic,
  DiagnosticCheck,
  DiagnosticKind,
  DiagnosticReport,
  ExecutionSession,
  ProjectContract,
  ProjectFile
} from '../types.js';
import { detectMissingModules } from '../execution/dependencyService.js';
import { hashWorkspace } from '../execution/workspaceMaterializer.js';
import { ContractFirstEngine } from '../swarm/contractFirstEngine.js';
import { ExecutionAdapter } from '../swarm/executionAdapter.js';
import { IntegrationAgent } from '../swarm/integrationAgent.js';

const MAX_MESSAGE_LENGTH = 600;
const MAX_DIAGNOSTICS = 100;
const MAX_LOG_ENTRIES = 5000;
const MAX_LOG_CHARS = 256 * 1024;
const MAX_STACK_FRAMES = 8;
const FAILED_END_REASONS = new Set(['failed', 'out_of_memory', 'timed_out', 'disk_limit']);

/** A problem someone saw while using the project. It is a claim, not a compiler result. */
export interface ReportedProblem {
  kind: 'runtime' | 'api';
  message: string;
  filePath?: string;
  line?: number;
  stack?: string;
}

/** Project output and reports can hold credentials, and they reach model prompts and history. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}/g, '[REDACTED]')
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)=\S+/g, '$1=[REDACTED]')
    .replace(/(\/\/[^/\s:@]+:)[^/\s@]+@/g, '$1[REDACTED]@');
}

/** Line numbers and temporary paths change between runs, so they are not part of identity. */
function normalizeMessage(message: string): string {
  return message
    .replace(/(?:[A-Za-z]:)?[\\/](?:[\w.@-]+[\\/])+/g, '')
    .replace(/\b0x[0-9a-f]+\b/gi, 'H')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
}

export function fingerprintDiagnostic(kind: DiagnosticKind, filePath: string | undefined, message: string): string {
  return crypto.createHash('sha256')
    .update(`${kind}|${filePath || ''}|${normalizeMessage(message)}`)
    .digest('hex')
    .slice(0, 16);
}

function diagnostic(
  fields: Omit<DebugDiagnostic, 'fingerprint' | 'occurrences'> & { fingerprintMessage?: string }
): DebugDiagnostic {
  const { fingerprintMessage, ...rest } = fields;
  const message = rest.message.slice(0, MAX_MESSAGE_LENGTH);
  return {
    ...rest,
    message,
    fingerprint: fingerprintDiagnostic(rest.kind, rest.filePath, fingerprintMessage || message),
    occurrences: 1
  };
}

function mergeDuplicates(diagnostics: DebugDiagnostic[]): DebugDiagnostic[] {
  const merged = new Map<string, DebugDiagnostic>();
  for (const item of diagnostics) {
    const existing = merged.get(item.fingerprint);
    if (existing) existing.occurrences += item.occurrences;
    else merged.set(item.fingerprint, { ...item });
  }
  return Array.from(merged.values()).slice(0, MAX_DIAGNOSTICS);
}

/** Maps a path from a stack trace to a project file, ignoring where the sandbox mounted it. */
function matchProjectPath(rawPath: string, files: ProjectFile[]): string | undefined {
  const path = rawPath.replace(/^file:\/\//, '').replace(/\\/g, '/');
  if (path.includes('node_modules/')) return undefined;
  return files
    .map(file => file.path)
    .filter(known => path === known || path.endsWith(`/${known}`))
    .sort((a, b) => b.length - a.length)[0];
}

const ERROR_LINE = /^\s*(?:Uncaught\s+|Unhandled\s+)?(?:\[?[\w.-]+\]?\s+)?([A-Z][A-Za-z]*Error(?: \[[A-Z_]+\])?): (.+)$/;
/** Assertion errors put a multi-line message between the error and its stack. */
const MAX_LINES_BEFORE_STACK = 20;
const TAP_LOCATION = /^\s*location:\s*'?(.+?):(\d+):(\d+)'?\s*$/;
const TEST_LOCATION = /^\s*test at (.+?):(\d+):(\d+)\s*$/;
const STACK_FRAME = /^\s*at\s+(?:.*?\()?((?:file:\/\/)?(?:[A-Za-z]:)?[^\s():]+):(\d+):(\d+)\)?\s*$/;
const API_FAILURES = [
  /\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\/\S*)\s+(?:-\s+)?([45]\d\d)\b/,
  /\b(?:status code|status:?|HTTP(?:\/\d(?:\.\d)?)?)\s*([45]\d\d)\b/i,
  /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed)\b/
];
const TEST_FAILURES = [
  /^\s*(?:✖|×|✕)\s+(.+?)(?:\s+\([\d.]+\s*m?s\))?$/,
  /^\s*not ok \d+ - (.+)$/,
  /^\s*FAIL\s+(\S+)/
];

/** TAP puts a failure's location in a YAML block under its "not ok" line. */
function tapLocation(lines: string[], index: number, files: ProjectFile[]) {
  for (let next = index + 1; next < Math.min(lines.length, index + MAX_LINES_BEFORE_STACK); next++) {
    if (/^\s*\.\.\.\s*$/.test(lines[next])) return undefined;
    const match = lines[next].match(TAP_LOCATION);
    if (match) return { filePath: matchProjectPath(match[1], files), line: Number(match[2]) };
  }
  return undefined;
}

/** Turns raw process output into diagnostics. Output is untrusted text from project code. */
export function parseProcessOutput(
  rawOutput: string,
  session: Pick<ExecutionSession, 'id' | 'script'>,
  files: ProjectFile[]
): DebugDiagnostic[] {
  const output = redactSecrets(rawOutput);
  const lines = output.split(/\r?\n/);
  const isTestRun = Boolean(session.script?.startsWith('test'));
  const base = { source: 'sandbox' as const, sessionId: session.id };
  const found: DebugDiagnostic[] = [];

  for (const name of detectMissingModules(output)) {
    found.push(diagnostic({ ...base, kind: 'dependency', code: 'MODULE_NOT_FOUND', message: `Cannot find package "${name}" at runtime` }));
  }

  let testLocation: { filePath?: string; line: number } | undefined;

  lines.forEach((line, index) => {
    const located = line.match(TEST_LOCATION);
    if (located) testLocation = { filePath: matchProjectPath(located[1], files), line: Number(located[2]) };

    const error = line.match(ERROR_LINE);
    if (error) {
      const stack: string[] = [];
      let location: { filePath: string; line: number; column: number } | undefined;

      const searchEnd = Math.min(lines.length, index + 1 + MAX_LINES_BEFORE_STACK);
      for (let next = index + 1; next < searchEnd && stack.length < MAX_STACK_FRAMES; next++) {
        const frame = lines[next].match(STACK_FRAME);
        if (!frame) {
          if (stack.length > 0) break;
          continue;
        }
        stack.push(lines[next].trim());
        const filePath = matchProjectPath(frame[1], files);
        if (filePath && !location) location = { filePath, line: Number(frame[2]), column: Number(frame[3]) };
      }

      found.push(diagnostic({
        ...base,
        kind: isTestRun ? 'test' : 'runtime',
        code: error[1],
        message: `${error[1]}: ${error[2].trim()}`,
        filePath: location?.filePath,
        line: location?.line,
        column: location?.column,
        stack
      }));
    }

    if (API_FAILURES.some(pattern => pattern.test(line))) {
      found.push(diagnostic({ ...base, kind: 'api', message: line.trim() }));
    }

    if (isTestRun) {
      const failure = TEST_FAILURES.map(pattern => line.match(pattern)).find(Boolean);
      if (failure && !/^failing tests:?$/.test(failure[1].trim())) {
        const location = testLocation || (/not ok/.test(line) ? tapLocation(lines, index, files) : undefined);
        found.push(diagnostic({
          ...base,
          kind: 'test',
          message: `Test failed: ${failure[1].trim()}`,
          filePath: matchProjectPath(failure[1].trim(), files) || location?.filePath,
          line: location?.line
        }));
        testLocation = undefined;
      }
    }
  });

  // Runners print a failure twice, and only the summary says where it is
  const located = new Set(found.filter(item => item.filePath).map(item => item.message));
  return found.filter(item => item.filePath || !located.has(item.message));
}

function declaredPackages(files: ProjectFile[]): Set<string> {
  const manifest = files.find(file => file.path === 'package.json');
  if (!manifest) return new Set();
  try {
    const parsed = JSON.parse(manifest.content);
    return new Set([...Object.keys(parsed.dependencies || {}), ...Object.keys(parsed.devDependencies || {})]);
  } catch {
    return new Set();
  }
}

export class DiagnosticCollector {
  /**
   * Runs every check that needs no project code to run. Dry runs use this on a copy of the
   * files. No check here executes project code: they parse, type-check, and bundle it.
   */
  static collectStatic(
    buildId: string,
    files: ProjectFile[],
    contracts: ProjectContract[] = []
  ): { diagnostics: DebugDiagnostic[]; checks: DiagnosticCheck[] } {
    const diagnostics: DebugDiagnostic[] = [];
    const checks: DiagnosticCheck[] = [];
    const source = 'static' as const;
    const record = (name: DiagnosticKind, count: number, detail?: string) =>
      checks.push({ name, status: count === 0 ? 'passed' : 'failed', detail });

    const syntaxErrors = ExecutionAdapter.validateSyntax(files);
    for (const error of syntaxErrors) {
      diagnostics.push(diagnostic({ kind: 'syntax', source, message: error.message, filePath: error.filePath, line: error.line }));
    }
    record('syntax', syntaxErrors.length);

    const types = ExecutionAdapter.validateTypes(buildId, files);
    for (const error of types.errors) {
      diagnostics.push(diagnostic({
        kind: 'type',
        source,
        code: error.code,
        message: `${error.code}: ${error.message}`,
        filePath: error.filePath,
        line: error.line,
        column: error.column
      }));
    }
    for (const name of types.missingDependencies || []) {
      diagnostics.push(diagnostic({ kind: 'dependency', source, code: 'TS2307', message: `Package "${name}" is imported but not installed or declared` }));
    }
    if (types.status === 'skipped' || types.status === 'not_run') {
      checks.push({ name: 'type', status: 'skipped', detail: types.skipReason });
    } else {
      record('type', types.errors.length);
    }

    const integration = IntegrationAgent.analyzeProjectContracts(files);
    const integrationErrors = integration.issues.filter(issue => issue.severity === 'error');
    for (const issue of integrationErrors) {
      diagnostics.push(diagnostic({
        kind: issue.type === 'missing_dependency' ? 'dependency' : 'integration',
        source,
        code: issue.type,
        message: issue.message,
        filePath: issue.sourceFile,
        relatedFile: issue.targetFile
      }));
    }
    record('integration', integrationErrors.length);
    record('dependency', diagnostics.filter(item => item.kind === 'dependency').length);

    const contractErrors = ContractFirstEngine.validateFilesAgainstContracts(files, contracts)
      .flatMap(result => result.errors.map(message => ({ message, filePath: result.contract.filePath })));
    for (const error of contractErrors) {
      diagnostics.push(diagnostic({ kind: 'contract', source, ...error }));
    }
    record('contract', contractErrors.length);

    const configErrors = ExecutionAdapter.validateConfigs(files);
    for (const message of configErrors) {
      diagnostics.push(diagnostic({ kind: 'config', source, message }));
    }
    record('config', configErrors.length);

    if (syntaxErrors.length > 0) {
      checks.push({ name: 'build', status: 'skipped', detail: 'Bundling waits until syntax errors are fixed.' });
    } else {
      const build = ExecutionAdapter.runProductionBuild(buildId, files);
      if (build.status === 'skipped') {
        checks.push({ name: 'build', status: 'skipped', detail: build.output });
      } else {
        const declared = declaredPackages(files);
        const locations = build.locations?.length ? build.locations : build.errors.map(message => ({ message, filePath: undefined, line: undefined }));
        const buildErrors = locations.filter(error => {
          // The checker has no node_modules, so a declared package failing to resolve proves nothing
          const unresolved = error.message.match(/^Could not resolve "([^".][^"]*)"/)?.[1];
          return !unresolved || !declared.has(unresolved.startsWith('@') ? unresolved.split('/').slice(0, 2).join('/') : unresolved.split('/')[0]);
        });
        for (const error of buildErrors) {
          diagnostics.push(diagnostic({ kind: 'build', source, message: error.message, filePath: error.filePath, line: error.line }));
        }
        record('build', buildErrors.length);
      }
    }

    return { diagnostics: mergeDuplicates(diagnostics), checks };
  }

  private static readOutput(sessionId: string): string {
    const text = db.getExecutionLogs(sessionId, 0, MAX_LOG_ENTRIES)
      .filter(entry => entry.stream !== 'system')
      .map(entry => entry.text)
      .join('');
    return text.slice(-MAX_LOG_CHARS);
  }

  /** The latest run of each script decides, so a later success clears an earlier failure. */
  private static collectSandbox(buildId: string, files: ProjectFile[], workspaceHash: string) {
    const current: DebugDiagnostic[] = [];
    const stale: DebugDiagnostic[] = [];
    const latestByScript = new Map<string, ExecutionSession>();

    for (const session of db.getExecutionSessions(buildId, 20)) {
      if (session.script && session.endReason && !latestByScript.has(session.script)) {
        latestByScript.set(session.script, session);
      }
    }

    for (const session of latestByScript.values()) {
      if (!FAILED_END_REASONS.has(session.endReason!)) continue;

      const found = parseProcessOutput(this.readOutput(session.id), session, files);
      const isTestRun = session.script!.startsWith('test');
      if (found.length === 0) {
        found.push(diagnostic({
          kind: isTestRun ? 'test' : 'runtime',
          source: 'sandbox',
          sessionId: session.id,
          code: session.endReason,
          message: `Script "${session.script}" ended with ${session.endReason} (exit code ${session.exitCode})`
        }));
      }
      (session.workspaceHash === workspaceHash ? current : stale).push(...found);
    }

    for (const session of db.getExecutionSessions(buildId, 5)) {
      for (const install of db.getDependencyInstalls(session.id)) {
        if (install.status !== 'failed') continue;
        const item = diagnostic({
          kind: 'dependency',
          source: 'sandbox',
          sessionId: session.id,
          code: 'INSTALL_FAILED',
          message: redactSecrets(install.error || `Dependency install failed: ${install.command}`)
        });
        (session.workspaceHash === workspaceHash ? current : stale).push(item);
      }
    }

    return { current, stale };
  }

  private static fromReports(reports: ReportedProblem[], files: ProjectFile[]): DebugDiagnostic[] {
    const known = new Set(files.map(file => file.path));
    return reports.map(report => diagnostic({
      kind: report.kind,
      source: 'reported',
      message: redactSecrets(report.message),
      filePath: report.filePath && known.has(report.filePath) ? report.filePath : undefined,
      line: report.line,
      stack: report.stack ? redactSecrets(report.stack).split(/\r?\n/).slice(0, MAX_STACK_FRAMES) : undefined
    }));
  }

  /** Contracts from the newest generation run are the ones the project was built against. */
  static contractsFor(buildId: string): ProjectContract[] {
    return db.getGenerationRuns(buildId)[0]?.contractsEstablished || [];
  }

  /** Gathers every kind of error for the current workspace. It reads and never writes. */
  static collect(buildId: string, reports: ReportedProblem[] = []): DiagnosticReport {
    const files = db.getAllFiles(buildId);
    const workspaceHash = hashWorkspace(files);
    const staticResult = this.collectStatic(buildId, files, this.contractsFor(buildId));
    const sandbox = this.collectSandbox(buildId, files, workspaceHash);

    const hasRun = db.getExecutionSessions(buildId, 1).length > 0;
    const runtimeCheck: DiagnosticCheck = sandbox.current.length > 0
      ? { name: 'runtime', status: 'failed' }
      : hasRun
        ? { name: 'runtime', status: 'passed', detail: 'No failed run for this workspace.' }
        : { name: 'runtime', status: 'skipped', detail: 'This project has not run in the sandbox.' };

    return {
      buildId,
      workspaceHash,
      diagnostics: mergeDuplicates([
        ...staticResult.diagnostics,
        ...sandbox.current,
        ...this.fromReports(reports, files)
      ]),
      staleDiagnostics: mergeDuplicates(sandbox.stale),
      checks: [...staticResult.checks, runtimeCheck],
      collectedAt: Date.now()
    };
  }
}
