import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { ExecutionAdapter } from '../swarm/executionAdapter.js';

const execFileAsync = promisify(execFile);

/**
 * Factory Phase F11 — the CLI / OS-tool gate.
 *
 * A generated command-line tool is not verified by existing, or by
 * compiling: it is verified by *running* it. The gate materializes
 * the delivered project into a scratch directory (paths sanitized
 * through the platform's own ExecutionAdapter helper, the F9
 * pattern) and executes its entry point with the repository's own
 * tsx runner — the same runner the platform uses for TypeScript
 * entry points — against fixture input the gate creates:
 *
 *   --help / --version     the profile's documented surface
 *   summarize a log file   stdout carries the exact level counts
 *   summarize --out        a JSON report file appears and parses
 *                          with the same counts (a real file effect)
 *   init                   the tool's second command creates its
 *                          sample file, which then summarizes
 *   no arguments           clean failure: exit 1, a message, and
 *                          NO stack trace (the generation profile's
 *                          own validation rule)
 *   missing input file     clean failure naming the file, exit 1,
 *                          no stack trace
 *
 * The fixture log's level counts are known constants, so the
 * assertions are exact. A tool that crashes on valid input, prints
 * wrong counts, writes no report, or dumps a stack trace on bad
 * input fails the gate by named case.
 */

export type CliToolFileInput =
  | Array<{ path: string; content: string }>
  | Record<string, string>;

export interface CliGateCase {
  name: string;
  ok: boolean;
  detail: string;
  exitCode?: number;
}

export interface CliGateReport {
  passed: boolean;
  toolName: string;
  entryPoint: string;
  cases: CliGateCase[];
}

/** The gate's fixture log: level counts are the asserted constants. */
export const CLI_GATE_FIXTURE_LOG = [
  '2026-01-01T10:00:00Z INFO service started',
  '2026-01-01T10:00:01Z INFO listening on port 8080',
  '2026-01-01T10:00:02Z WARN cache miss for key user:42',
  '2026-01-01T10:00:03Z ERROR failed to connect to database',
  '2026-01-01T10:00:04Z ERROR retry failed for job 7',
  '2026-01-01T10:00:05Z DEBUG loaded config from disk',
  '2026-01-01T10:00:06Z INFO request completed in 42ms',
  '2026-01-01T10:00:07Z ERROR timeout waiting for upstream',
  'a plain line without a level',
  ''
].join('\n');

export const CLI_GATE_EXPECTED_COUNTS: Record<string, number> = {
  INFO: 3,
  WARN: 1,
  ERROR: 3,
  DEBUG: 1,
  OTHER: 1
};
export const CLI_GATE_EXPECTED_TOTAL = 9;

function normalizeFiles(files: CliToolFileInput): Array<{ path: string; content: string }> {
  if (Array.isArray(files)) return files;
  return Object.entries(files).map(([p, content]) => ({ path: p, content }));
}

/** Finds the platform's own tsx binary the way the F9 runtime probe does. */
function locateTsx(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'node_modules/.bin/tsx'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../node_modules/.bin/tsx')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const STACK_TRACE_PATTERN = /(^|\n)\s+at\s+[\w$.]+\s+\(\S+:\d+:\d+\)/;

function hasStackTrace(output: string): boolean {
  return (
    STACK_TRACE_PATTERN.test(output) ||
    output.includes('UnhandledPromiseRejection') ||
    output.includes('node:internal')
  );
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

async function runTool(
  tsxPath: string,
  entryPath: string,
  args: string[],
  cwd: string
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(tsxPath, [entryPath, ...args], {
      cwd,
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' }
    });
    return { code: 0, stdout, stderr };
  } catch (err: any) {
    if (typeof err?.code === 'number') {
      return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
    return {
      code: -1,
      stdout: err?.stdout ?? '',
      stderr: err?.stderr ?? '',
      spawnError: err?.message ?? String(err)
    };
  }
}

/**
 * Executes the delivered CLI tool against the gate's fixture cases.
 * The scratch directory is always removed; every assertion outcome
 * is recorded in the returned report.
 */
export async function verifyCliTool(files: CliToolFileInput): Promise<CliGateReport> {
  const cases: CliGateCase[] = [];
  const record = (name: string, ok: boolean, detail: string, exitCode?: number): void => {
    cases.push({ name, ok, detail, exitCode });
  };

  const fileList = normalizeFiles(files);
  const byPath = new Map(fileList.map(f => [f.path, f.content]));

  // -- structure: a package.json whose bin field names the entry --
  let toolName = 'unknown';
  let version = '';
  let entryPoint = 'bin/cli.ts';
  const packageJsonRaw = byPath.get('package.json');
  if (!packageJsonRaw) {
    record('structure', false, 'package.json is missing from the delivered project.');
    return { passed: false, toolName, entryPoint, cases };
  }
  try {
    const pkg = JSON.parse(packageJsonRaw);
    toolName = typeof pkg.name === 'string' && pkg.name ? pkg.name : 'unknown';
    version = typeof pkg.version === 'string' ? pkg.version : '';
    const binValues =
      pkg.bin && typeof pkg.bin === 'object' ? Object.values(pkg.bin) : [];
    if (typeof binValues[0] === 'string' && binValues[0]) entryPoint = binValues[0] as string;
  } catch (err: any) {
    record('structure', false, `package.json does not parse: ${err.message}`);
    return { passed: false, toolName, entryPoint, cases };
  }
  if (!byPath.has(entryPoint)) {
    record('structure', false, `the bin entry point "${entryPoint}" is missing from the delivered project.`);
    return { passed: false, toolName, entryPoint, cases };
  }
  record(
    'structure',
    true,
    `package.json declares bin entry "${entryPoint}" for tool "${toolName}"${version ? ` v${version}` : ''}, and the entry file was delivered.`
  );

  const tsxPath = locateTsx();
  if (!tsxPath) {
    record('execution', false, 'the platform tsx runner (node_modules/.bin/tsx) was not found; the tool was not executed.');
    return { passed: false, toolName, entryPoint, cases };
  }

  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'squadforge_cli_gate_'));
  try {
    const projectDir = path.join(scratch, 'project');
    const workDir = path.join(scratch, 'work');
    await fsp.mkdir(projectDir, { recursive: true });
    await fsp.mkdir(workDir, { recursive: true });
    for (const file of fileList) {
      const { valid, cleanPath } = ExecutionAdapter.sanitizeFilePath(file.path);
      if (!valid) continue;
      const target = path.join(projectDir, cleanPath);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, file.content, 'utf-8');
    }
    const entryAbs = path.join(projectDir, entryPoint);
    const run = (args: string[]): Promise<RunResult> => runTool(tsxPath, entryAbs, args, workDir);

    // -- --help ----------------------------------------------------
    const help = await run(['--help']);
    record(
      'help',
      help.code === 0 && help.stdout.includes('Usage:'),
      help.code === 0
        ? `--help exited 0 and printed usage ("${help.stdout.split('\n')[0]}").`
        : `--help exited ${help.code}; stdout: ${help.stdout.slice(0, 200)} stderr: ${help.stderr.slice(0, 200)}`,
      help.code
    );

    // -- --version ---------------------------------------------------
    const versionRun = await run(['--version']);
    record(
      'version',
      versionRun.code === 0 && (version === '' || versionRun.stdout.includes(version)),
      versionRun.code === 0
        ? `--version exited 0 and printed "${versionRun.stdout.trim()}".`
        : `--version exited ${versionRun.code}; stdout: ${versionRun.stdout.slice(0, 200)} stderr: ${versionRun.stderr.slice(0, 200)}`,
      versionRun.code
    );

    // -- summarize the fixture log -----------------------------------
    await fsp.writeFile(path.join(workDir, 'sample.log'), CLI_GATE_FIXTURE_LOG, 'utf-8');
    const summary = await run(['sample.log']);
    const summaryOk =
      summary.code === 0 &&
      summary.stdout.includes(`Total lines: ${CLI_GATE_EXPECTED_TOTAL}`) &&
      new RegExp(`ERROR\\s+${CLI_GATE_EXPECTED_COUNTS.ERROR}\\b`).test(summary.stdout) &&
      new RegExp(`INFO\\s+${CLI_GATE_EXPECTED_COUNTS.INFO}\\b`).test(summary.stdout);
    record(
      'summarize-fixture-log',
      summaryOk,
      summary.code === 0
        ? `exit 0; stdout reported Total lines: ${CLI_GATE_EXPECTED_TOTAL} with INFO=${CLI_GATE_EXPECTED_COUNTS.INFO} and ERROR=${CLI_GATE_EXPECTED_COUNTS.ERROR} as asserted. Output: ${summary.stdout.replace(/\n/g, ' | ').slice(0, 300)}`
        : `exit ${summary.code}; stdout: ${summary.stdout.slice(0, 300)} stderr: ${summary.stderr.slice(0, 300)}`,
      summary.code
    );

    // -- summarize with a JSON report (real file effect) -------------
    const reportRun = await run(['sample.log', '--out', 'report.json']);
    const reportPath = path.join(workDir, 'report.json');
    let reportOk = reportRun.code === 0 && fs.existsSync(reportPath);
    let reportDetail = reportOk ? '' : `exit ${reportRun.code}; report.json ${fs.existsSync(reportPath) ? 'exists' : 'was NOT written'}.`;
    if (reportOk) {
      try {
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
        const counts = report.counts ?? {};
        const countsMatch =
          report.total === CLI_GATE_EXPECTED_TOTAL &&
          Object.entries(CLI_GATE_EXPECTED_COUNTS).every(([k, v]) => counts[k] === v);
        reportOk = countsMatch;
        reportDetail = countsMatch
          ? `report.json written by the tool and parses: total=${report.total}, counts=${JSON.stringify(counts)}.`
          : `report.json parses but its counts disagree with the fixture: ${JSON.stringify(report).slice(0, 300)}`;
      } catch (err: any) {
        reportOk = false;
        reportDetail = `report.json does not parse: ${err.message}`;
      }
    }
    record('json-report-file', reportOk, reportDetail, reportRun.code);

    // -- init command creates a sample the tool itself can read -------
    const init = await run(['init', 'seed.log']);
    const seedPath = path.join(workDir, 'seed.log');
    let initOk = init.code === 0 && fs.existsSync(seedPath) && fs.statSync(seedPath).size > 0;
    let initDetail = initOk
      ? 'init exited 0 and created a non-empty seed.log.'
      : `init exited ${init.code}; seed.log ${fs.existsSync(seedPath) ? 'exists' : 'was NOT created'}; stderr: ${init.stderr.slice(0, 200)}`;
    if (initOk) {
      const seedSummary = await run(['seed.log']);
      initOk = seedSummary.code === 0;
      initDetail += ` Summarizing the created file exited ${seedSummary.code}.`;
    }
    record('init-command', initOk, initDetail, init.code);

    // -- missing argument: clean failure, no stack trace --------------
    const noArgs = await run([]);
    const noArgsClean = !hasStackTrace(noArgs.stderr + noArgs.stdout);
    record(
      'missing-argument-clean-failure',
      noArgs.code === 1 && noArgs.stderr.trim().length > 0 && noArgsClean,
      `exit ${noArgs.code} (expected 1); stderr: "${noArgs.stderr.trim().slice(0, 200)}"; stack trace present: ${!noArgsClean}.`,
      noArgs.code
    );

    // -- missing input file: clean failure naming the file ------------
    const missing = await run(['does-not-exist.log']);
    const missingClean = !hasStackTrace(missing.stderr + missing.stdout);
    record(
      'missing-file-clean-failure',
      missing.code === 1 && missing.stderr.includes('does-not-exist.log') && missingClean,
      `exit ${missing.code} (expected 1); stderr: "${missing.stderr.trim().slice(0, 200)}"; names the file: ${missing.stderr.includes('does-not-exist.log')}; stack trace present: ${!missingClean}.`,
      missing.code
    );
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }

  return {
    passed: cases.every(c => c.ok),
    toolName,
    entryPoint,
    cases
  };
}
