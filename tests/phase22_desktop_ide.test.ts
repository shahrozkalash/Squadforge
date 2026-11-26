import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { tokenize, highlightToHtml, languageForPath } from '../server/ide/syntaxHighlighter.js';
import { WorkspaceFiles } from '../server/ide/workspaceFiles.js';
import { TerminalService } from '../server/ide/terminalService.js';
import { BuildRunner, detectProjectKind, parseDiagnostics } from '../server/ide/buildRunner.js';
import { GitService } from '../server/ide/gitService.js';
import { PackageService } from '../server/ide/packageService.js';
import { PROJECT_TEMPLATES, getTemplate } from '../server/ide/templates.js';
import { reviewCode, explainDiagnostic, AiAssistService } from '../server/ide/aiAssist.js';
import { IdeProjectGenerator } from '../server/ide/ideProjectGenerator.js';

// The scratch tree must live OUTSIDE any git work tree:
// GitService.isRepository() runs `git rev-parse --is-inside-work-tree`,
// which walks up parent directories — a workspace created under the
// repository checkout therefore reports itself as a repository before
// `git init`, and test 5.1's not-a-repository assertion fails. That is
// exactly what happened in CI (real checkout); it passed on hosts
// whose working copy has no .git directory of its own.
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'squadforge-ide-tests-'));

function freshWorkspace(name: string): string {
  const dir = path.join(BASE, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('SquadForge Phase 22: Desktop IDE and Development Tools Test Suite', () => {
  before(() => fs.mkdirSync(BASE, { recursive: true }));
  after(() => fs.rmSync(BASE, { recursive: true, force: true }));

  describe('1. Syntax highlighting (real tokenizer)', () => {
    test('1.1 TypeScript tokens classify keyword/string/comment/number/function', () => {
      const src = `// greeting\nconst name: string = "world";\nconsole.log(name, 42);`;
      const tokens = tokenize(src, 'typescript');
      const byType = (t: string) => tokens.filter((x) => x.type === t);
      assert.ok(byType('comment').some((t) => t.text.includes('greeting')));
      assert.ok(byType('keyword').some((t) => t.text === 'const'));
      assert.ok(byType('string').some((t) => t.text === '"world"'));
      assert.ok(byType('number').some((t) => t.text === '42'));
      assert.ok(byType('function').some((t) => t.text === 'log'));
      // Offsets reconstruct the source exactly
      assert.equal(tokens.map((t) => t.text).join(''), src);
    });

    test('1.2 C# and Python tokenize; HTML output is escaped', () => {
      const cs = tokenize('public class Foo { private int x = 1; }', 'csharp');
      assert.ok(cs.some((t) => t.type === 'keyword' && t.text === 'class'));
      assert.ok(cs.some((t) => t.type === 'type' && t.text === 'Foo'));
      const py = tokenize('# comment\ndef main():\n    return True', 'python');
      assert.ok(py.some((t) => t.type === 'comment'));
      assert.ok(py.some((t) => t.type === 'keyword' && t.text === 'def'));
      const html = highlightToHtml('const a = "<b>";', 'typescript');
      assert.match(html, /&lt;b&gt;/);
      assert.match(html, /tok-keyword/);
      assert.equal(languageForPath('src/App.cs'), 'csharp');
      assert.equal(languageForPath('x.unknown'), null);
    });
  });

  describe('2. File explorer / workspace files', () => {
    test('2.1 CRUD + tree; traversal is rejected', () => {
      const files = new WorkspaceFiles(freshWorkspace('files'));
      files.writeFile('src/app.ts', 'export const x = 1;');
      files.createFile('README.md', '# hi');
      assert.equal(files.readFile('src/app.ts'), 'export const x = 1;');
      assert.deepEqual(files.listFiles(), ['README.md', 'src/app.ts']);
      const tree = files.tree();
      assert.equal(tree.kind, 'directory');
      assert.ok(tree.children!.some((c) => c.name === 'src'));
      assert.throws(() => files.createFile('README.md'), /already exists/);
      assert.throws(() => files.readFile('../escape.txt'), /Unsafe workspace path/);
      assert.throws(() => files.writeFile('/abs.txt', 'x'), /Unsafe workspace path/);
      files.renamePath('README.md', 'docs/README.md');
      assert.deepEqual(files.listFiles(), ['docs/README.md', 'src/app.ts']);
      files.deletePath('docs/README.md');
      assert.deepEqual(files.listFiles(), ['src/app.ts']);
    });
  });

  describe('3. Terminal isolation', () => {
    test('3.1 Allowlist enforced; cwd locked to the workspace', async () => {
      const dir = freshWorkspace('term');
      const terminal = new TerminalService(dir);
      await assert.rejects(() => terminal.run('rm', ['-rf', '.']), /not allowed/);
      await assert.rejects(() => terminal.run('sh', ['-c', 'ls']), /not allowed/);
      const pwd = await terminal.run('node', ['-e', 'console.log(process.cwd())']);
      assert.equal(pwd.exitCode, 0);
      assert.equal(pwd.stdout.trim(), fs.realpathSync(dir));
    });

    test('3.2 Path arguments cannot escape; timeouts are enforced', async () => {
      const dir = freshWorkspace('term2');
      const terminal = new TerminalService(dir);
      await assert.rejects(() => terminal.run('node', ['../outside.js']), /escapes the workspace/);
      await assert.rejects(() => terminal.run('git', ['-C', '/etc', 'status']), /escapes the workspace/);
      const slow = await terminal.run('node', ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 300 });
      assert.equal(slow.timedOut, true);
      const echo = await terminal.run('node', ['-e', 'console.log("hello-ide")']);
      assert.match(echo.stdout, /hello-ide/);
    });
  });

  describe('4. Build & run with diagnostics', () => {
    test('4.1 Diagnostic parser handles TypeScript and C# formats', () => {
      const ts = parseDiagnostics('src/index.ts(3,14): error TS2304: Cannot find name \'foo\'.\n');
      assert.equal(ts.length, 1);
      assert.deepEqual([ts[0].file, ts[0].line, ts[0].column, ts[0].code], ['src/index.ts', 3, 14, 'TS2304']);
      const cs = parseDiagnostics('C:\\app\\Program.cs(7,5): error CS1002: ; expected [C:\\app\\App.csproj]');
      assert.equal(cs.length, 1);
      assert.equal(cs[0].code, 'CS1002');
    });

    test('4.2 Node template builds and runs for real', async () => {
      const dir = freshWorkspace('build-node');
      const files = new WorkspaceFiles(dir);
      files.writeProjectFiles(getTemplate('node').generate('HelloApp'));
      assert.equal(detectProjectKind(dir), 'node');
      const runner = new BuildRunner(new TerminalService(dir));
      const outcome = await runner.build();
      assert.equal(outcome.success, true, outcome.result.stderr);
      const run = await runner.runApp();
      assert.equal(run.exitCode, 0);
      assert.match(run.stdout, /Hello from HelloApp!/);
    });

    test('4.3 Broken code fails the build honestly; Python template builds', async () => {
      const dir = freshWorkspace('build-broken');
      const files = new WorkspaceFiles(dir);
      files.writeProjectFiles(getTemplate('node').generate('BrokenApp'));
      files.writeFile('src/index.js', 'function broken( {');
      const outcome = await new BuildRunner(new TerminalService(dir)).build();
      assert.equal(outcome.success, false);

      const pyDir = freshWorkspace('build-python');
      new WorkspaceFiles(pyDir).writeProjectFiles(getTemplate('python').generate('PyApp'));
      assert.equal(detectProjectKind(pyDir), 'python');
      const pyOutcome = await new BuildRunner(new TerminalService(pyDir)).build();
      assert.equal(pyOutcome.success, true, pyOutcome.result.stderr);
    });
  });

  describe('5. Git integration (real git)', () => {
    test('5.1 init → status → add → commit → log → diff cycle', async () => {
      const dir = freshWorkspace('git');
      const files = new WorkspaceFiles(dir);
      files.writeFile('a.txt', 'one\n');
      const git = new GitService(new TerminalService(dir));
      assert.equal(await git.isRepository(), false);
      await git.init();
      assert.equal(await git.isRepository(), true);
      let status = await git.status();
      assert.ok(status.some((s) => s.path === 'a.txt'));
      await git.add(['a.txt']);
      const hash = await git.commit('initial commit');
      assert.match(hash, /^[0-9a-f]{40}$/);
      const log = await git.log();
      assert.equal(log.length, 1);
      assert.equal(log[0].subject, 'initial commit');
      assert.equal(await git.currentBranch(), 'main');
      files.writeFile('a.txt', 'one\ntwo\n');
      status = await git.status();
      assert.ok(status.some((s) => s.path === 'a.txt' && s.worktree === 'M'));
      const diff = await git.diff();
      assert.match(diff, /\+two/);
    });
  });

  describe('6. Package management', () => {
    test('6.1 A real local package installs via npm and is listed', async () => {
      const dir = freshWorkspace('pkgs');
      const files = new WorkspaceFiles(dir);
      files.writeProjectFiles(getTemplate('node').generate('PkgApp'));
      files.writeFile('localpkg/package.json', JSON.stringify({ name: 'localpkg', version: '1.2.3', main: 'index.js' }));
      files.writeFile('localpkg/index.js', 'module.exports = 42;');
      const packages = new PackageService(new TerminalService(dir));
      assert.deepEqual(packages.listPackages(), []);
      await packages.addNpmPackage('file:./localpkg');
      const listed = packages.listPackages();
      // npm records a file: dependency by its spec; the real install
      // proof is the package's presence in node_modules (below).
      assert.ok(listed.some((p) => p.name === 'localpkg' && p.version.includes('file:')));
      assert.ok(fs.existsSync(path.join(dir, 'node_modules', 'localpkg', 'index.js')));
    });
  });

  describe('7. Templates', () => {
    test('7.1 All templates generate complete starter projects', () => {
      assert.deepEqual(PROJECT_TEMPLATES.map((t) => t.id), ['node', 'typescript', 'python', 'csharp-console', 'web', 'android']);
      const ts = getTemplate('typescript').generate('TsApp');
      assert.ok(ts['tsconfig.json'] && ts['src/index.ts']);
      const cs = getTemplate('csharp-console').generate('CsApp');
      assert.ok(cs['CsApp.csproj'] && cs['Program.cs']);
      const web = getTemplate('web').generate('WebApp');
      assert.ok(web['index.html'] && web['app.js'] && web['styles.css']);
      const android = getTemplate('android').generate('DroidApp');
      assert.ok(android['settings.gradle.kts'], 'android template must be the genuine Phase 17 project');
      assert.ok(Object.keys(android).length > 10);
    });
  });

  describe('8. AI assistance (existing systems, honest availability)', () => {
    test('8.1 Static review finds TODOs and long lines; diagnostics are explained', () => {
      const review = reviewCode('a.ts', '// TODO: fix\nconst x = 1;\n' + 'y'.repeat(150));
      assert.equal(review.metrics.todoCount, 1);
      assert.ok(review.findings.some((f) => f.message.includes('150 characters')));
      const explained = explainDiagnostic({ severity: 'error', file: 'a.ts', line: 1, column: 1, code: 'TS2304', message: 'Cannot find name' });
      assert.match(explained.explanation, /missing import|typo/);
      const unknown = explainDiagnostic({ severity: 'error', file: 'a.ts', line: 2, column: 3, code: 'TS9999', message: '???' });
      assert.match(unknown.suggestedFix, /cascade/);
    });

    test('8.2 Generation reports unavailability honestly when no local model is up', async () => {
      const result = await new AiAssistService().generate('write a function');
      assert.equal(result.available, false);
      assert.match(result.reason ?? '', /not attempted|health check/);
    });
  });

  describe('9. Generated IDE application source', () => {
    test('9.1 Generator emits a complete IDE app on the desktop stack', () => {
      const config = IdeProjectGenerator.getDefaultConfig('ForgeStudio');
      const files = IdeProjectGenerator.generateProjectFiles(config);
      for (const expected of [
        'ForgeStudio.sln',
        'src/ForgeStudio/ForgeStudio.csproj',
        'src/ForgeStudio/Program.cs',
        'src/ForgeStudio/MainForm.cs',
        'src/ForgeStudio/IdeCore.cs'
      ]) {
        assert.ok(files[expected], `missing ${expected}`);
      }
      assert.match(files['src/ForgeStudio/IdeCore.cs'], /ParseDiagnostics/);
      assert.match(files['src/ForgeStudio/MainForm.cs'], /SyntaxRules/);
      assert.match(files['src/ForgeStudio/MainForm.cs'], /Git/);
    });
  });
});
