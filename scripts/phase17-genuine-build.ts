/**
 * Phase 17 genuine-build verification harness.
 *
 * Drives SquadForge's own AndroidProjectGenerator + AndroidBuildPipeline
 * exactly as the HTTP routes do, on a host that has a real Android
 * toolchain (JDK 17+, Android SDK, apksigner, bundletool). Used by the
 * Phase 17 CI workflow (.github/workflows/phase17-android-verify.yml) to
 * prove genuine Gradle compilation and strict Google-tool verification.
 *
 * Usage:
 *   tsx scripts/phase17-genuine-build.ts build   # genuine debug build (APK + AAB)
 *   tsx scripts/phase17-genuine-build.ts broken  # Kotlin syntax error must fail honestly
 *
 * Exit code: 0 when the outcome matches the expectation, 1 otherwise.
 * A single RESULT_JSON line is printed for machine-readable evidence.
 */
import { AndroidProjectGenerator } from '../server/android/androidProjectGenerator.js';
import { AndroidBuildPipeline } from '../server/android/androidBuildPipeline.js';

const mode = process.argv[2] || 'build';
const buildId = `phase17_ci_${mode}_${Date.now()}`;

const config = AndroidProjectGenerator.getDefaultConfig('FitTrack', 'com.squadforge.fittrack');
const files = AndroidProjectGenerator.generateProjectFiles(config);
console.log(`Generated ${Object.keys(files).length} project files for ${config.packageName}`);
console.log(
  `Config: compileSdk=${config.compileSdk} targetSdk=${config.targetSdk} minSdk=${config.minSdk} kotlin=${config.kotlinVersion} agp=${config.agpVersion}`
);

if (mode === 'broken') {
  const mainKey = Object.keys(files).find((k) => k.endsWith('MainActivity.kt'));
  if (!mainKey) {
    console.log('RESULT_JSON ' + JSON.stringify({ mode, ok: false, reason: 'no MainActivity.kt generated' }));
    process.exit(1);
  }
  files[mainKey] = files[mainKey] + '\nthis is not valid kotlin {{{\n';
}

const { result, apkBuffer, aabBuffer } = await AndroidBuildPipeline.build(buildId, config, files, {
  mode: 'debug',
  target: 'both'
});

const verifyLogs = result.logs
  .filter((l) => l.step === 'VERIFY' || l.step === 'HARVEST')
  .map((l) => `${l.level} ${l.step}: ${l.message}`);

console.log('=== BUILD RESULT ===');
console.log('status:', result.status);
console.log('durationMs:', result.durationMs);
console.log('error:', result.error || '(none)');
console.log('apkBytes:', apkBuffer?.length || 0);
console.log('aabBytes:', aabBuffer?.length || 0);
for (const line of verifyLogs) console.log(line);
for (const d of result.diagnostics || []) {
  console.log(`DIAG [${d.severity}] ${d.file}: ${d.message}`);
}
console.log('buildId:', buildId);

if (mode === 'broken') {
  const ok = result.status === 'failed' && !apkBuffer && !aabBuffer;
  console.log(
    'RESULT_JSON ' +
      JSON.stringify({ mode, ok, status: result.status, error: (result.error || '').slice(0, 300), buildId })
  );
  process.exit(ok ? 0 : 1);
}

const ok = result.status === 'success' && Boolean(apkBuffer) && Boolean(aabBuffer);
console.log(
  'RESULT_JSON ' +
    JSON.stringify({
      mode,
      ok,
      status: result.status,
      durationMs: result.durationMs,
      apkBytes: apkBuffer?.length || 0,
      aabBytes: aabBuffer?.length || 0,
      buildId
    })
);
process.exit(ok ? 0 : 1);
