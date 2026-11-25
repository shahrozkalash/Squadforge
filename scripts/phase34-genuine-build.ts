/**
 * Phase 34 genuine-build verification harness.
 *
 * Drives SquadForge's Phase 34 generator (ClipForge native Android
 * video editor) + the Phase 17 AndroidBuildPipeline exactly as the
 * HTTP routes do, on a host with a real Android toolchain (JDK 17+,
 * Android SDK, apksigner, bundletool). Used by the Phase 34 CI
 * workflow (.github/workflows/phase34-android-video-editor.yml) to
 * prove genuine Gradle compilation of the generated Kotlin/Compose
 * editor — including Media3 — and to run the generated app's own
 * JVM unit tests (EditorOpsTest) through Gradle's testDebugUnitTest.
 *
 * Usage:
 *   tsx scripts/phase34-genuine-build.ts build   # genuine debug APK + unit tests
 *   tsx scripts/phase34-genuine-build.ts broken  # Kotlin syntax error must fail honestly
 *
 * Exit code: 0 when the outcome matches the expectation, 1 otherwise.
 * A single RESULT_JSON line is printed for machine-readable evidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AndroidBuildPipeline } from '../server/android/androidBuildPipeline.js';
import {
  generateVideoEditorProject,
  getVideoEditorConfig
} from '../server/android/videoEditorGenerator.js';

const mode = process.argv[2] || 'build';
const buildId = `phase34_ci_${mode}_${Date.now()}`;

const config = getVideoEditorConfig();
const files = generateVideoEditorProject(config);
console.log(`Generated ${Object.keys(files).length} ClipForge project files for ${config.packageName}`);
console.log(
  `Config: compileSdk=${config.compileSdk} targetSdk=${config.targetSdk} minSdk=${config.minSdk} kotlin=${config.kotlinVersion} agp=${config.agpVersion}`
);

if (mode === 'broken') {
  const opsKey = Object.keys(files).find((k) => k.endsWith('/editor/EditorOps.kt'));
  if (!opsKey) {
    console.log('RESULT_JSON ' + JSON.stringify({ mode, ok: false, reason: 'no EditorOps.kt generated' }));
    process.exit(1);
  }
  files[opsKey] = files[opsKey] + '\nthis is not valid kotlin {{{\n';
}

const { result, apkBuffer } = await AndroidBuildPipeline.build(buildId, config, files, {
  mode: 'debug',
  target: 'apk',
  runTests: mode === 'build'
});

const verifyLogs = result.logs
  .filter((l) => l.step === 'VERIFY' || l.step === 'HARVEST')
  .map((l) => `${l.level} ${l.step}: ${l.message}`);

console.log('=== BUILD RESULT ===');
console.log('status:', result.status);
console.log('durationMs:', result.durationMs);
console.log('error:', result.error || '(none)');
console.log('apkBytes:', apkBuffer?.length || 0);
for (const line of verifyLogs) console.log(line);
for (const d of result.diagnostics || []) {
  console.log(`DIAG [${d.severity}] ${d.file}: ${d.message}`);
}
console.log('buildId:', buildId);

if (mode === 'broken') {
  const ok = result.status === 'failed' && !apkBuffer;
  console.log(
    'RESULT_JSON ' +
      JSON.stringify({ mode, ok, status: result.status, error: (result.error || '').slice(0, 300), buildId })
  );
  process.exit(ok ? 0 : 1);
}

// Unit-test evidence: read Gradle's own test-results XML from the
// workspace instead of merely claiming the tests were included
// (CI run 45698797957's log had no visible test evidence at all).
let unitTests: { tests: number; failures: number; errors: number; skipped: number; suites: string[] } | null = null;
try {
  const resultsDir = path.resolve(
    process.cwd(),
    '.android_workspaces',
    buildId,
    'app',
    'build',
    'test-results',
    'testDebugUnitTest'
  );
  const xmlFiles = fs.readdirSync(resultsDir).filter((f) => f.endsWith('.xml'));
  if (xmlFiles.length) {
    unitTests = { tests: 0, failures: 0, errors: 0, skipped: 0, suites: [] };
    for (const f of xmlFiles) {
      const xml = fs.readFileSync(path.join(resultsDir, f), 'utf-8');
      const head = xml.match(/<testsuite[^>]*>/);
      if (!head) continue;
      const attr = (name: string) => Number(head[0].match(new RegExp(`${name}="(\\d+)"`))?.[1] || 0);
      unitTests.tests += attr('tests');
      unitTests.failures += attr('failures');
      unitTests.errors += attr('errors');
      unitTests.skipped += attr('skipped');
      const suiteName = head[0].match(/name="([^"]+)"/)?.[1];
      if (suiteName) unitTests.suites.push(suiteName);
    }
    console.log(
      `UNIT_TESTS tests=${unitTests.tests} failures=${unitTests.failures} errors=${unitTests.errors} skipped=${unitTests.skipped} suites=${unitTests.suites.join(',')}`
    );
  }
} catch {
  unitTests = null;
}
if (!unitTests) console.log('UNIT_TESTS none found (test-results XML missing)');

const ok = result.status === 'success' && Boolean(apkBuffer);
console.log(
  'RESULT_JSON ' +
    JSON.stringify({
      mode,
      ok,
      status: result.status,
      durationMs: result.durationMs,
      apkBytes: apkBuffer?.length || 0,
      apkSha256: result.apkChecksum || null,
      unitTestsIncluded: true,
      unitTests,
      buildId
    })
);
process.exit(ok ? 0 : 1);
