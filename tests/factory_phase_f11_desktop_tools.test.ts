// Factory Phase F11 — the Desktop & OS Tools workflow.
//
// A described desktop application flows through the factory
// machinery: the F5 Desktop Software Team resolved from registry
// data, a real swarm build (stub transport; the delivered content
// is the platform's own generated Avalonia project — the Phase 36
// DesktopProjectGenerator output — so every delivered byte is
// platform-generated and the fixture is labelled as such), the F6
// DESKTOP environment contract (the first Arc D workflow to use
// the desktop adapter: genuine dotnet build, two apphost --smoke
// runs with persisted LaunchCount 1 -> 2, ELF-verified export,
// deployment dry-run), and the F11 desktop gate, whose Windows half
// is produced by the Phase 23 release system (genuine dotnet
// publish -r win-x64, PE-verified exe, SHA-256 manifest,
// validatePackage, tamper detection).
//
// A described CLI utility flows the same way: the F5 Developer
// Tools Team — CLI, a real swarm build delivering a tool in the
// cli_tool_developer_utility profile's file organization (the
// platform has no deterministic CLI generator — the profile + swarm
// are the category's machinery, stated plainly), the F6 web
// environment cycle (bundle build honestly `skipped` for a bin
// entry; the tool's own tests through the platform test gate), and
// the F11 CLI gate, which EXECUTES the delivered tool with the
// platform's tsx runner: exact fixture-log counts, a JSON report
// file effect, the init command, and clean failures with no stack
// traces.
//
// Broken variants must fail: uncompilable C# fails the desktop
// pipeline build and the gate; a CLI tool whose entry crashes on
// valid input fails the execution gate.

process.env.SQUADFORGE_TRUSTED_HOST_TESTS = '1';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';

import { db } from '../server/store.js';
import { smartRouter } from '../server/smartRouter.js';
import { SwarmOrchestrator } from '../server/swarm/swarmOrchestrator.js';
import { ApprovalGateService } from '../server/swarm/approvalGateService.js';
import { DesktopProjectGenerator } from '../server/desktop/desktopProjectGenerator.js';
import { DesktopWorkflow } from '../server/desktop/desktopWorkflow.js';
import {
  assessDesktopDelivery,
  type WindowsPackageReport
} from '../server/desktop/desktopProjectGate.js';
import { createEnvironment } from '../server/environment/index.js';
import { CliToolWorkflow } from '../server/ide/cliWorkflow.js';
import { verifyCliTool } from '../server/ide/cliToolGate.js';

const DESKTOP_DESCRIPTION =
  'Build a desktop application called NoteKeeper for keeping short text notes in a native window. ' +
  'Notes are stored in a local state file so they persist between launches, and the app keeps a count of how many times it has launched.';

const CLI_DESCRIPTION =
  'Build a command line tool called logsum that summarizes application log files: it counts log lines by level ' +
  '(INFO, WARN, ERROR, DEBUG), prints a summary to stdout, and can write a JSON report file with --out. ' +
  'It creates a sample log with its init command, prints usage with --help and its version with --version, ' +
  'and fails cleanly with a helpful message and a non-zero exit code when the input file is missing — never an unhandled stack trace.';

// ---------------------------------------------------------------------------
// Swarm harness (the F10 pattern, parameterized by fixture + tasks)
// ---------------------------------------------------------------------------

interface FixtureTask {
  paths: string[];
  title: string;
  description: string;
  role: string;
  priority: number;
}

let counter = 0;

function makeBuild(description: string, tag: string): { buildId: string; userId: string } {
  const stamp = Date.now();
  const userId = `usr_f11_${tag}_` + stamp + '_' + ++counter;
  db.createUser({
    id: userId,
    email: userId + '@f11.test',
    name: userId,
    githubConnected: false,
    costLimitPerBuild: 25,
    enabledModelIds: ['gemini', 'claude', 'deepseek'],
    createdAt: stamp
  } as any);
  const buildId = `bld_f11_${tag}_` + stamp + '_' + counter;
  db.saveBuild({
    id: buildId,
    userId,
    idea: description,
    status: 'planning',
    createdAt: stamp,
    updatedAt: stamp,
    selectedModels: ['gemini', 'claude', 'deepseek'],
    autoPushGithub: false,
    totalTokens: 0,
    totalCost: 0,
    costLimit: 25,
    maxDurationSeconds: 600,
    patchesAppliedCount: 0
  } as any);
  return { buildId, userId };
}

function okResult(modelId: string, parsedResponse: any, rawText = ''): any {
  return {
    success: true,
    rawText,
    parsedResponse,
    tokensUsed: 10,
    modelId,
    actualModelUsed: modelId,
    providerUsed: 'stub-transport',
    isFallback: false,
    latencyMs: 1
  };
}

function installStub(
  t: any,
  buildId: string,
  fixture: Record<string, string>,
  tasks: FixtureTask[]
): void {
  const plannerActions = tasks.map(task => ({
    action: 'create_task',
    title: task.title,
    description: task.description,
    filePaths: task.paths,
    priority: task.priority,
    assignedRole: task.role
  }));
  t.mock.method(smartRouter, 'executeSmartRequest', async (params: any) => {
    const modelId: string = params.requestedModelId || 'unknown';
    const prompt: string = params.prompt || '';
    if (prompt.includes('PROJECT MANAGER & ARCHITECT SPECIFICATION')) {
      return okResult(modelId, { thinking: 'plan', actions: plannerActions });
    }
    if (prompt.includes('VERIFY SOFTWARE COMPLETION')) {
      return okResult(modelId, null, JSON.stringify({
        approved: true,
        summary: 'All requirements verified against specification',
        missingRequirements: []
      }));
    }
    const task = params.task;
    const actions = (task?.filePaths || []).map((p: string) => {
      const existing = db.getFile(buildId, p);
      if (existing && existing.content !== fixture[p]) {
        return {
          action: 'patch_file',
          path: p,
          edits: [{ find: existing.content, replace: fixture[p] }],
          commitMessage: 'Implement ' + task?.title
        };
      }
      if (existing) return null;
      return { action: 'create_file', path: p, content: fixture[p], commitMessage: 'Implement ' + task?.title };
    }).filter(Boolean);
    return okResult(modelId, { thinking: 'work', actions });
  });
}

function startApprovalPump(buildId: string, userId: string): () => void {
  const timer = setInterval(async () => {
    try {
      for (const req of db.getApprovalRequests(buildId, 'pending')) {
        const decided = ApprovalGateService.respondToApproval(buildId, userId, { requestId: req.id, approved: true });
        if (decided.success && decided.request) {
          await SwarmOrchestrator.resolveHeldTask(decided.request);
        }
      }
    } catch {
      // The pump must never take the test down with it.
    }
  }, 150);
  return () => clearInterval(timer);
}

async function runSwarmBuild(
  t: any,
  input: {
    description: string;
    tag: string;
    fixture: Record<string, string>;
    tasks: FixtureTask[];
    expectedType: string;
  }
): Promise<{ buildId: string; userId: string }> {
  const { buildId, userId } = makeBuild(input.description, input.tag);
  installStub(t, buildId, input.fixture, input.tasks);
  const stopPump = startApprovalPump(buildId, userId);
  try {
    await SwarmOrchestrator.startSwarm(buildId);
  } finally {
    stopPump();
  }

  const build = db.getBuild(buildId);
  const tasks = db.getTasks(buildId);
  const planned = tasks.filter(task => !task.isFixTask);
  const events = db.getEvents(buildId);

  assert.equal(build?.status, 'completed', 'swarm build must complete, got ' + build?.status + ': ' + (build?.error || build?.failureReason || ''));
  assert.equal(build?.projectType, input.expectedType, 'the build must be classified by the platform analyzer');
  assert.ok(events.some(e => e.type === 'verifier_approved'), 'the completion verifier must approve before completion');
  for (const e of events.filter(e => e.type === 'sandbox_check')) {
    assert.match(e.details, /passed cleanly/, 'every sandbox integrity check in the run must pass');
  }
  assert.equal(planned.length, input.tasks.length, 'expected the planner tasks, got ' + planned.length);
  for (const task of planned) {
    assert.equal(task.status, 'completed', 'task "' + task.title + '" must complete');
  }

  const delivered = new Map(db.getAllFiles(buildId).map(f => [f.path, f.content]));
  for (const [p, content] of Object.entries(input.fixture)) {
    assert.equal(delivered.get(p), content, 'delivered file matches the fixture: ' + p);
  }
  return { buildId, userId };
}

// ---------------------------------------------------------------------------
// Desktop fixture: the platform's generated Avalonia project
// ---------------------------------------------------------------------------

const DESKTOP_FIXTURE: Record<string, string> = DesktopProjectGenerator.generateProjectFiles(
  DesktopProjectGenerator.getLinuxDefaultConfig('NoteKeeper', 'NoteKeeper')
) as Record<string, string>;

const DESKTOP_TASKS: FixtureTask[] = [
  {
    title: 'Configure the solution and build props',
    description: 'Visual Studio solution file, gitignore and shared Directory.Build.props for the NoteKeeper desktop project',
    role: 'devops_release_specialist', priority: 3,
    paths: ['NoteKeeper.sln', '.gitignore', 'Directory.Build.props']
  },
  {
    title: 'Implement the app entry point and state store',
    description: 'Program entry point with the headless --smoke diagnostics mode, and the AppState store that persists notes and the launch count to a local state file',
    role: 'backend_developer', priority: 2,
    paths: ['src/NoteKeeper/Program.cs', 'src/NoteKeeper/AppState.cs']
  },
  {
    title: 'Build the Avalonia app and main window',
    description: 'Avalonia application definition and the main window (XAML and code-behind) where notes are kept',
    role: 'frontend_developer', priority: 2,
    paths: [
      'src/NoteKeeper/App.axaml',
      'src/NoteKeeper/App.axaml.cs',
      'src/NoteKeeper/MainWindow.axaml',
      'src/NoteKeeper/MainWindow.axaml.cs'
    ]
  },
  {
    title: 'Configure the project file and build scripts',
    description: 'The .NET project file, the Linux desktop entry, and the build script',
    role: 'devops_release_specialist', priority: 3,
    paths: ['src/NoteKeeper/NoteKeeper.csproj', 'src/NoteKeeper/NoteKeeper.desktop', 'build.sh']
  },
  {
    title: 'Write the project readme',
    description: 'Readme documenting the stack, how to build and run the app, the --smoke mode, and where state is stored',
    role: 'fullstack_developer', priority: 3,
    paths: ['README.md']
  }
];

// The Windows package report from the happy-path delivery, reused by
// the broken-variant test to prove the gate refuses a failed Linux
// build even when the Windows half of the evidence is genuine.
let goodWindowsPackage: WindowsPackageReport | null = null;

// ---------------------------------------------------------------------------
// (a) Desktop end-to-end: team -> swarm -> desktop contract -> gate
// ---------------------------------------------------------------------------

test('Factory F11: a desktop app description flows team -> swarm -> desktop contract -> gate to a verified delivery', { timeout: 900_000 }, async (t) => {
  // Step 1 — team resolution from F5 data.
  const plan = DesktopWorkflow.plan(DESKTOP_DESCRIPTION);
  assert.equal(plan.category, 'desktop_application');
  assert.equal(plan.teamName, 'Desktop Software Team');
  assert.equal(plan.profileId, 'desktop_application');
  assert.equal(plan.resolvedTeam.verifierModelId, 'claude',
    'the desktop team verification chain resolves its verifier through the registry');

  // Step 2 — the real swarm build.
  const { buildId } = await runSwarmBuild(t, {
    description: DESKTOP_DESCRIPTION,
    tag: 'desktop',
    fixture: DESKTOP_FIXTURE,
    tasks: DESKTOP_TASKS,
    expectedType: 'desktop_application'
  });

  // Steps 3–4 — desktop environment contract cycle + gate.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'f11_desktop_'));
  try {
    const delivery = await DesktopWorkflow.runEnvironmentCycle({
      buildId,
      title: 'NoteKeeper',
      workspaceRoot: path.join(scratch, 'workspaces'),
      artifactsRoot: path.join(scratch, 'artifacts'),
      windowsScratchRoot: path.join(scratch, 'winpkg')
    });

    assert.equal(delivery.environment, 'desktop');
    assert.equal(delivery.build.status, 'succeeded',
      'the DesktopBuildPipeline build must succeed: ' + (delivery.build.error || delivery.build.detail));
    assert.equal(delivery.smokeRuns.length, 2, 'two consecutive smoke runs are the persistence evidence');
    for (const run of delivery.smokeRuns) {
      assert.equal(run.status, 'passed', 'smoke run must pass: ' + run.detail);
      assert.equal(run.mode, 'compile_and_smoke');
      assert.match(run.detail, /SMOKE_OK/, 'the apphost printed its smoke marker');
    }
    assert.deepEqual(delivery.launchCounts, [1, 2],
      'the persisted LaunchCount must increase across the two apphost launches');

    assert.equal(delivery.artifact.kind, 'executable');
    assert.ok(delivery.artifact.sizeBytes > 0, 'the exported apphost must be non-empty');
    assert.match(delivery.artifact.sha256 || '', /^[0-9a-f]{64}$/);
    assert.ok(delivery.artifact.path && fs.existsSync(delivery.artifact.path), 'the artifact must exist on disk');
    const artifactBytes = fs.readFileSync(delivery.artifact.path!);
    assert.equal(
      crypto.createHash('sha256').update(artifactBytes).digest('hex'),
      delivery.artifact.sha256,
      'the artifact hash must match the bytes on disk'
    );
    assert.equal(artifactBytes.subarray(0, 4).toString('latin1'), '\x7fELF',
      'the exported Linux artifact is an ELF executable');

    assert.equal(delivery.deploymentDryRun.valid, true,
      'the deployment dry-run must be valid: ' + delivery.deploymentDryRun.defects.join('; '));

    const gate = delivery.gate;
    assert.equal(gate.passed, true,
      'gate checks: ' + JSON.stringify(gate.checks.filter(c => !c.ok)));
    assert.equal(gate.windowsPackage.published, true);
    assert.equal(gate.windowsPackage.exePeVerified, true,
      'the published Windows exe must be PE-verified');
    assert.ok(gate.windowsPackage.exeSizeBytes > 0);
    assert.equal(gate.windowsPackage.validation?.valid, true,
      'validatePackage must pass on the untouched package: ' +
        JSON.stringify(gate.windowsPackage.validation?.steps.filter(s => !s.ok)));
    assert.equal(gate.windowsPackage.manifestAllHashed, true,
      'every manifest file carries a SHA-256');
    assert.ok(gate.windowsPackage.manifestFileCount >= 2, 'the manifest lists the published files');
    assert.match(gate.windowsPackage.packageSha256, /^[0-9a-f]{64}$/);
    assert.equal(gate.windowsPackage.tamperDetected, true,
      'a byte-tampered package copy must be rejected at the file-hashes step: ' + gate.windowsPackage.tamperDetail);
    assert.equal(gate.windowsPackage.signingStatus, 'not-requested',
      'no signing was requested or fabricated');

    assert.equal(delivery.verified, true, 'full gate green = verified delivery');
    goodWindowsPackage = gate.windowsPackage;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI fixture: a real logsum tool in the cli_tool_developer_utility
// profile's file organization. Labelled fixture (the F9 pattern):
// the platform has no deterministic CLI generator module, so the
// swarm delivers this tool — written against the profile's required
// contracts (CliCommand, CliOption, CliExecutionResult,
// TerminalFormatOptions) and conventions (standard exit codes,
// --help/--version, clean failures without stack traces).
// ---------------------------------------------------------------------------

const CLI_FIXTURE: Record<string, string> = {
  'package.json': `{
  "name": "logsum",
  "version": "1.0.0",
  "description": "Summarize application log files by level from the command line",
  "type": "module",
  "bin": { "logsum": "bin/cli.ts" },
  "scripts": { "start": "tsx bin/cli.ts", "test": "tsx --test tests/cli.test.ts" },
  "license": "MIT"
}
`,

  'src/types/cli.ts': `/**
 * Shared contracts for the logsum command-line tool.
 * (Generation profile: cli_tool_developer_utility.)
 */
export interface CliOption {
  name: string;
  alias?: string;
  description: string;
  takesValue: boolean;
}

export interface CliCommand {
  name: string;
  description: string;
  options: CliOption[];
}

export interface CliExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TerminalFormatOptions {
  color: boolean;
  width: number;
}

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' | 'OTHER';

export interface LogReport {
  file: string;
  total: number;
  counts: Record<LogLevel, number>;
}
`,

  'src/cli/commandParser.ts': `import type { CliCommand, CliOption } from '../types/cli.js';

export class CliUsageError extends Error {}

export const CLI_OPTIONS: CliOption[] = [
  { name: '--help', alias: '-h', description: 'Print usage information', takesValue: false },
  { name: '--version', alias: '-v', description: 'Print the tool version', takesValue: false },
  { name: '--out', description: 'Write a JSON report to the given file', takesValue: true }
];

export const CLI_COMMANDS: CliCommand[] = [
  { name: 'run', description: 'Summarize a log file (the default command)', options: CLI_OPTIONS },
  { name: 'init', description: 'Create a sample log file', options: [] }
];

export interface ParsedArgs {
  command: 'run' | 'init';
  file?: string;
  out?: string;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: 'run', help: false, version: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--version' || arg === '-v') {
      parsed.version = true;
    } else if (arg === '--out') {
      const value = argv[++i];
      if (!value) throw new CliUsageError('Option --out requires a file path value.');
      parsed.out = value;
    } else if (arg.startsWith('-')) {
      throw new CliUsageError(\`Unknown option: \${arg}\`);
    } else {
      positional.push(arg);
    }
  }
  if (positional[0] === 'init') {
    parsed.command = 'init';
    parsed.file = positional[1];
  } else if (positional.length > 0) {
    parsed.file = positional[0];
  }
  return parsed;
}
`,

  'src/cli/formatter.ts': `import type { LogLevel, LogReport, TerminalFormatOptions } from '../types/cli.js';

export const USAGE = [
  'Usage: logsum <log-file> [--out <report.json>]',
  '       logsum init [file]',
  '       logsum --help | --version',
  '',
  'Summarize an application log file: counts lines by level',
  '(INFO, WARN, ERROR, DEBUG, OTHER) and prints a summary.',
  'With --out, the same summary is also written as a JSON report.'
].join('\\n');

const LEVEL_ORDER: LogLevel[] = ['INFO', 'WARN', 'ERROR', 'DEBUG', 'OTHER'];

export function formatSummary(
  report: LogReport,
  options: TerminalFormatOptions = { color: false, width: 60 }
): string {
  const lines = [
    \`Log summary for \${report.file}\`,
    \`Total lines: \${report.total}\`,
    '-'.repeat(Math.min(Math.max(options.width, 10), 40))
  ];
  for (const level of LEVEL_ORDER) {
    lines.push(\`\${level.padEnd(6)} \${report.counts[level]}\`);
  }
  return lines.join('\\n');
}

export function formatJsonReport(report: LogReport): string {
  return JSON.stringify({ file: report.file, total: report.total, counts: report.counts }, null, 2);
}
`,

  'src/cli/commands/run.ts': `import * as fs from 'fs';
import * as path from 'path';
import type { CliExecutionResult, LogLevel, LogReport } from '../../types/cli.js';
import { formatJsonReport, formatSummary } from '../formatter.js';

const LEVELS: LogLevel[] = ['INFO', 'WARN', 'ERROR', 'DEBUG'];

export function summarizeLog(file: string, content: string): LogReport {
  const counts: Record<LogLevel, number> = { INFO: 0, WARN: 0, ERROR: 0, DEBUG: 0, OTHER: 0 };
  let total = 0;
  for (const line of content.split('\\n')) {
    if (!line.trim()) continue;
    total++;
    const level = LEVELS.find(l => line.includes(' ' + l + ' ') || line.endsWith(' ' + l));
    counts[level ?? 'OTHER']++;
  }
  return { file, total, counts };
}

export function runSummarize(file: string | undefined, out: string | undefined): CliExecutionResult {
  if (!file) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'Error: missing required argument <log-file>.\\nRun "logsum --help" for usage.'
    };
  }
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return {
      exitCode: 1,
      stdout: '',
      stderr: \`Error: cannot read input file "\${file}". Check that the file exists and is readable.\`
    };
  }
  const report = summarizeLog(path.basename(file), content);
  let stdout = formatSummary(report);
  if (out) {
    try {
      fs.writeFileSync(out, formatJsonReport(report) + '\\n', 'utf-8');
    } catch {
      return { exitCode: 2, stdout: '', stderr: \`Error: cannot write report file "\${out}".\` };
    }
    stdout += \`\\nJSON report written to \${out}\`;
  }
  return { exitCode: 0, stdout, stderr: '' };
}
`,

  'src/cli/commands/init.ts': `import * as fs from 'fs';
import type { CliExecutionResult } from '../../types/cli.js';

export const SAMPLE_LOG = [
  '2026-01-01T09:00:00Z INFO service started',
  '2026-01-01T09:00:01Z WARN disk usage above 80%',
  '2026-01-01T09:00:02Z ERROR failed to open cache file',
  '2026-01-01T09:00:03Z INFO request completed in 12ms',
  ''
].join('\\n');

export function runInit(file: string | undefined): CliExecutionResult {
  const target = file ?? 'sample.log';
  try {
    fs.writeFileSync(target, SAMPLE_LOG, 'utf-8');
  } catch {
    return { exitCode: 2, stdout: '', stderr: \`Error: cannot write sample log file "\${target}".\` };
  }
  return { exitCode: 0, stdout: \`Sample log written to \${target}\`, stderr: '' };
}
`,

  'bin/cli.ts': `#!/usr/bin/env node
import { parseArgs, CliUsageError, type ParsedArgs } from '../src/cli/commandParser.js';
import { runSummarize } from '../src/cli/commands/run.js';
import { runInit } from '../src/cli/commands/init.js';
import { USAGE } from '../src/cli/formatter.js';

const VERSION = '1.0.0';

export function main(argv: string[]): number {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      console.error(\`Error: \${err.message}\`);
      console.error('Run "logsum --help" for usage.');
      return 1;
    }
    throw err;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.version) {
    console.log(\`logsum \${VERSION}\`);
    return 0;
  }
  const result = args.command === 'init' ? runInit(args.file) : runSummarize(args.file, args.out);
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  return result.exitCode;
}

process.exitCode = main(process.argv.slice(2));
`,

  'tests/cli.test.ts': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, CliUsageError } from '../src/cli/commandParser.js';
import { summarizeLog } from '../src/cli/commands/run.js';
import { formatSummary } from '../src/cli/formatter.js';

test('parseArgs reads a positional file and the --out option', () => {
  const parsed = parseArgs(['app.log', '--out', 'report.json']);
  assert.equal(parsed.command, 'run');
  assert.equal(parsed.file, 'app.log');
  assert.equal(parsed.out, 'report.json');
});

test('parseArgs routes the init command', () => {
  const parsed = parseArgs(['init', 'seed.log']);
  assert.equal(parsed.command, 'init');
  assert.equal(parsed.file, 'seed.log');
});

test('parseArgs rejects unknown options with a usage error', () => {
  assert.throws(() => parseArgs(['--nope']), CliUsageError);
});

test('summarizeLog counts lines by level', () => {
  const report = summarizeLog('app.log', [
    '2026-01-01T00:00:00Z INFO started',
    '2026-01-01T00:00:01Z ERROR failed',
    '2026-01-01T00:00:02Z ERROR failed again',
    'a plain line',
    ''
  ].join('\\n'));
  assert.equal(report.total, 4);
  assert.equal(report.counts.INFO, 1);
  assert.equal(report.counts.ERROR, 2);
  assert.equal(report.counts.OTHER, 1);
});

test('formatSummary prints the total and per-level counts', () => {
  const text = formatSummary({
    file: 'app.log',
    total: 4,
    counts: { INFO: 1, WARN: 0, ERROR: 2, DEBUG: 0, OTHER: 1 }
  });
  assert.match(text, /Total lines: 4/);
  assert.match(text, /ERROR\\s+2/);
});
`,

  'README.md': `# logsum

logsum is a command-line tool that summarizes application log files:
it counts log lines by level (INFO, WARN, ERROR, DEBUG, and OTHER for
lines without a level) and prints a summary table to stdout.

## Usage

- \`logsum <log-file>\` — print the summary for a log file.
- \`logsum <log-file> --out report.json\` — also write the summary as a JSON report file.
- \`logsum init [file]\` — create a small sample log file (default: sample.log).
- \`logsum --help\` — print usage. \`logsum --version\` — print the version.

Exit codes follow the usual convention: 0 = success, 1 = user error
(such as a missing or unreadable input file), 2 = system error.
Errors are reported as short messages on stderr — never as stack
traces.

## Data export/import functionality

Import: logsum reads plain-text log files whose lines carry a level
token (INFO, WARN, ERROR or DEBUG); lines without one are counted as
OTHER. Export: with \`--out <path>\`, the summary (file name, total
line count, and the per-level counts) is written to that path as a
JSON report file that other tools can consume.

## Development

The tool is TypeScript with no runtime dependencies. \`bin/cli.ts\`
is the entry point; argument parsing lives in
\`src/cli/commandParser.ts\`, the commands in \`src/cli/commands/\`,
output formatting in \`src/cli/formatter.ts\`, and the shared
contracts in \`src/types/cli.ts\`. Tests live in \`tests/cli.test.ts\`.
`
};

const CLI_TASKS: FixtureTask[] = [
  {
    title: 'Configure the package and shared contracts',
    description: 'package.json with the logsum bin entry, and the shared CLI contracts (CliCommand, CliOption, CliExecutionResult, TerminalFormatOptions) plus the log report types',
    role: 'backend_developer', priority: 2,
    paths: ['package.json', 'src/types/cli.ts']
  },
  {
    title: 'Implement argument parsing and output formatting',
    description: 'The argument parser (commands, --help/--version/--out, usage errors) and the summary/JSON formatters with the usage text',
    role: 'backend_developer', priority: 2,
    paths: ['src/cli/commandParser.ts', 'src/cli/formatter.ts']
  },
  {
    title: 'Implement the summarize and init commands and the entry point',
    description: 'The run command (read a log file, count lines by level, print the summary, optionally write the JSON report, clean failures), the init command (write a sample log), and the bin/cli.ts entry point wiring them together with standard exit codes',
    role: 'fullstack_developer', priority: 2,
    paths: ['src/cli/commands/run.ts', 'src/cli/commands/init.ts', 'bin/cli.ts']
  },
  {
    title: 'Write the tool tests and the readme',
    description: 'Node tests for the parser, the level counting and the formatter, and the readme documenting usage, exit codes, and the data export/import functionality (reading log files in, writing JSON reports out)',
    role: 'qa_testing_specialist', priority: 3,
    paths: ['tests/cli.test.ts', 'README.md']
  }
];

// ---------------------------------------------------------------------------
// (b) CLI end-to-end: team -> swarm -> web contract -> execution gate
// ---------------------------------------------------------------------------

test('Factory F11: a CLI tool description flows team -> swarm -> contract -> execution gate to a verified delivery', { timeout: 600_000 }, async (t) => {
  // Step 1 — team resolution from F5 data.
  const plan = CliToolWorkflow.plan(CLI_DESCRIPTION);
  assert.equal(plan.category, 'cli_tool');
  assert.equal(plan.teamName, 'Developer Tools Team — CLI');
  assert.equal(plan.profileId, 'cli_tool_developer_utility');
  assert.equal(plan.resolvedTeam.verifierModelId, 'claude',
    'the CLI team verification chain resolves its verifier through the registry');

  // Step 2 — the real swarm build.
  const { buildId, userId } = await runSwarmBuild(t, {
    description: CLI_DESCRIPTION,
    tag: 'cli',
    fixture: CLI_FIXTURE,
    tasks: CLI_TASKS,
    expectedType: 'cli_tool'
  });

  // Steps 3–4 — web environment contract cycle + execution gate.
  const delivery = await CliToolWorkflow.runEnvironmentCycle({
    projectId: buildId,
    userId,
    title: 'logsum'
  });

  assert.equal(delivery.environment, 'web');
  assert.equal(delivery.build.status, 'skipped',
    'a bin/cli.ts entry point is not a bundle entry the web build recognises — reported, not hidden');
  assert.equal(delivery.tests.status, 'passed',
    'the tool own test suite must pass through the platform test gate: ' + delivery.tests.detail);
  assert.ok(delivery.tests.passed >= 5, 'the fixture suite ran, got ' + delivery.tests.passed + ' passing');
  assert.ok(delivery.artifact.sizeBytes > 0, 'the exported artifact must be non-empty');
  assert.match(delivery.artifact.sha256 || '', /^[0-9a-f]{64}$/);
  assert.ok(delivery.artifact.path && fs.existsSync(delivery.artifact.path), 'the artifact must exist on disk');
  const artifactBytes = fs.readFileSync(delivery.artifact.path!);
  assert.equal(
    crypto.createHash('sha256').update(artifactBytes).digest('hex'),
    delivery.artifact.sha256,
    'the artifact hash must match the bytes on disk'
  );

  // The execution gate: the delivered tool genuinely ran.
  const gate = delivery.gate;
  assert.equal(gate.passed, true,
    'gate cases: ' + JSON.stringify(gate.cases.filter(c => !c.ok)));
  assert.equal(gate.toolName, 'logsum');
  assert.equal(gate.entryPoint, 'bin/cli.ts');
  const byName = new Map(gate.cases.map(c => [c.name, c]));
  for (const name of [
    'structure', 'help', 'version', 'summarize-fixture-log', 'json-report-file',
    'init-command', 'missing-argument-clean-failure', 'missing-file-clean-failure'
  ]) {
    assert.equal(byName.get(name)?.ok, true, `gate case ${name}: ${byName.get(name)?.detail}`);
  }
  assert.equal(byName.get('missing-argument-clean-failure')?.exitCode, 1);
  assert.equal(byName.get('missing-file-clean-failure')?.exitCode, 1);

  assert.equal(delivery.verified, true, 'execution gate passed + real artifact = verified delivery');
});

// ---------------------------------------------------------------------------
// (c) Broken variants are refused
// ---------------------------------------------------------------------------

test('Factory F11: broken variants fail their gates', { timeout: 600_000 }, async () => {
  // Desktop variant: uncompilable C# in the delivered project.
  const brokenFixture: Record<string, string> = { ...DESKTOP_FIXTURE };
  const programPath = 'src/NoteKeeper/Program.cs';
  brokenFixture[programPath] = brokenFixture[programPath] + '\nthis is not valid C# at all {{{\n';

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'f11_broken_'));
  try {
    const env = createEnvironment('desktop', {
      workspaceRoot: path.join(scratch, 'workspaces'),
      artifactsRoot: path.join(scratch, 'artifacts')
    });
    const projectId = 'f11-broken-desktop';
    await env.openProject({
      projectId,
      title: 'NoteKeeper',
      files: Object.entries(brokenFixture).map(([p, content]) => ({ path: p, content }))
    });

    const build = await env.build(projectId);
    assert.equal(build.status, 'failed',
      'uncompilable C# must fail the pipeline build');
    assert.ok(build.diagnostics.length > 0 || (build.error ?? '').length > 0,
      'the failed build names its diagnostics');

    const tests = await env.runTests(projectId);
    assert.equal(tests.status, 'failed', 'the test cycle reports the compile failure, not a pass');
    assert.match(tests.detail, /Compilation failed/);

    const dryRun = await env.validateDeployment(projectId);
    assert.equal(dryRun.valid, false, 'no successful build means the dry-run cannot validate');

    assert.ok(goodWindowsPackage, 'the happy-path test must run first and record its Windows package');
    const gate = assessDesktopDelivery({
      build,
      smokeRuns: [tests],
      launchCounts: [],
      artifact: { name: 'none', kind: 'executable', sizeBytes: 0 },
      artifactElfOk: false,
      deploymentDryRun: dryRun,
      windowsPackage: goodWindowsPackage!
    });
    assert.equal(gate.passed, false, 'the gate must refuse a delivery whose Linux build failed');
    assert.equal(gate.checks.find(c => c.name === 'pipeline-build')?.ok, false);
    assert.equal(DesktopWorkflow.verifyDelivery({ gate }), false);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  // CLI variant: the entry point crashes on any input (uncaught throw).
  const brokenCli: Record<string, string> = { ...CLI_FIXTURE };
  brokenCli['bin/cli.ts'] = `#!/usr/bin/env node
// Broken variant: the entry point throws before doing any work.
throw new Error('boom: the summarizer crashed before it could start');
`;
  const cliGate = await verifyCliTool(brokenCli);
  assert.equal(cliGate.passed, false, 'a tool that crashes on valid input must fail the execution gate');
  assert.equal(cliGate.cases.find(c => c.name === 'summarize-fixture-log')?.ok, false);
  assert.equal(cliGate.cases.find(c => c.name === 'help')?.ok, false);

  const artifact = { name: 'x.zip', kind: 'zip', sizeBytes: 1234, sha256: 'x' } as any;
  assert.equal(CliToolWorkflow.verifyDelivery({ artifact, gate: cliGate }), false);
});
