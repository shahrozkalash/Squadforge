/**
 * Phase 25 genuine-build verification harness.
 *
 * Drives SquadForge's own IosProjectGenerator + IosBuildPipeline exactly
 * as the HTTP routes do, on a host that has a real Xcode toolchain
 * (macOS). Used by the Phase 25 CI workflow
 * (.github/workflows/phase25-ios-verify.yml) to prove genuine
 * xcodebuild compilation of the generated Swift/SwiftUI project.
 *
 * Usage:
 *   tsx scripts/phase25-genuine-build.ts build   # genuine unsigned simulator build
 *   tsx scripts/phase25-genuine-build.ts deps    # same, with an SPM dependency (swift-algorithms)
 *   tsx scripts/phase25-genuine-build.ts broken  # Swift syntax error must fail honestly
 *
 * Exit code: 0 when the outcome matches the expectation, 1 otherwise.
 * A single RESULT_JSON line is printed for machine-readable evidence.
 * On a non-macOS host every mode reports environment-unavailable and
 * exits 1 — Linux cannot compile native iOS apps, and this harness
 * will not pretend otherwise.
 */
import { IosProjectGenerator } from '../server/ios/iosProjectGenerator.js';
import { IosProjectValidator } from '../server/ios/iosProjectValidator.js';
import { IosBuildPipeline } from '../server/ios/iosBuildPipeline.js';
import type { IosProjectConfig } from '../server/ios/types.js';

const mode = process.argv[2] || 'build';
const buildId = `phase25_ci_${mode}_${Date.now()}`;

const config: IosProjectConfig = IosProjectGenerator.getDefaultConfig('FitTrack', 'com.squadforge.fittrack');
if (mode === 'deps') {
  config.dependencies = [
    {
      url: 'https://github.com/apple/swift-algorithms.git',
      product: 'Algorithms',
      requirement: { kind: 'upToNextMajor', minimumVersion: '1.2.0' }
    }
  ];
  config.permissions = ['camera', 'photoLibrary'];
}

const files = IosProjectGenerator.generateProjectFiles(config);
console.log(`Generated ${Object.keys(files).length} project files for ${config.bundleId}`);
console.log(
  `Config: deploymentTarget=${config.deploymentTarget} swift=${config.swiftVersion} deps=${config.dependencies.length} permissions=${config.permissions.join(',') || 'none'}`
);

const structural = IosProjectValidator.validateProjectFiles(files, config);
console.log(`Structural validation: valid=${structural.valid} errors=[${structural.errors.join('; ')}]`);
if (!structural.valid) {
  console.log('RESULT_JSON ' + JSON.stringify({ mode, ok: false, reason: 'structural validation failed', errors: structural.errors }));
  process.exit(1);
}

if (mode === 'broken') {
  const key = Object.keys(files).find((k) => k.endsWith('ContentView.swift'));
  if (!key) {
    console.log('RESULT_JSON ' + JSON.stringify({ mode, ok: false, reason: 'no ContentView.swift generated' }));
    process.exit(1);
  }
  files[key] = files[key] + '\nthis is not valid swift {{{\n';
}

const result = await IosBuildPipeline.build(buildId, config, files, { destination: 'simulator' });

console.log('=== BUILD RESULT ===');
console.log('status:', result.status);
console.log('durationMs:', result.durationMs);
console.log('environment:', result.environment.xcodeVersion ?? result.environment.reason);
console.log('error:', result.error || '(none)');
for (const a of result.artifacts) console.log(`ARTIFACT ${a.filename} kind=${a.kind} exeBytes=${a.sizeBytes} sha256=${a.sha256}`);
for (const d of result.diagnostics.slice(0, 10)) {
  console.log(`DIAG [${d.severity}] ${d.file}:${d.line ?? ''} ${d.message}`);
}
if (result.outputTail) {
  console.log('=== XCODEBUILD OUTPUT TAIL ===');
  console.log(result.outputTail);
}
console.log('buildId:', buildId);

if (result.status === 'environment-unavailable') {
  console.log('RESULT_JSON ' + JSON.stringify({ mode, ok: false, reason: 'environment-unavailable', detail: result.environment.reason }));
  process.exit(1);
}

if (mode === 'broken') {
  const ok = result.status === 'failed' && result.artifacts.length === 0 && result.diagnostics.some((d) => d.severity === 'error');
  console.log('RESULT_JSON ' + JSON.stringify({ mode, ok, status: result.status, artifacts: result.artifacts.length, errors: result.diagnostics.filter((d) => d.severity === 'error').length }));
  process.exit(ok ? 0 : 1);
}

const app = result.artifacts.find((a) => a.kind === 'app');
const ok = result.status === 'success' && !!app && app.sizeBytes > 0;
console.log('RESULT_JSON ' + JSON.stringify({ mode, ok, status: result.status, appBytes: app?.sizeBytes ?? 0, appSha256: app?.sha256 ?? null }));
process.exit(ok ? 0 : 1);
