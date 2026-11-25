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
      buildId
    })
);
process.exit(ok ? 0 : 1);
