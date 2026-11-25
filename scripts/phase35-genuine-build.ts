/**
 * Phase 35 genuine-build verification harness.
 *
 * Drives SquadForge's Phase 35 generator (ClipForge native iOS
 * video editor) + the Phase 25 IosBuildPipeline exactly as the HTTP
 * routes do, on a host that has a real Xcode toolchain (macOS).
 * Used by the Phase 35 CI workflow
 * (.github/workflows/phase35-ios-video-editor.yml) to prove genuine
 * xcodebuild compilation of the generated Swift/SwiftUI editor.
 *
 * Usage:
 *   tsx scripts/phase35-genuine-build.ts build   # genuine unsigned simulator build
 *   tsx scripts/phase35-genuine-build.ts ops     # swiftc-compile + run the editor's pure ops tests
 *   tsx scripts/phase35-genuine-build.ts broken  # Swift syntax error must fail honestly
 *
 * Exit code: 0 when the outcome matches the expectation, 1 otherwise.
 * A single RESULT_JSON line is printed for machine-readable evidence.
 * On a non-macOS host every mode reports environment-unavailable and
 * exits 1 — Linux cannot compile native iOS apps, and this harness
 * will not pretend otherwise.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IosProjectValidator } from '../server/ios/iosProjectValidator.js';
import { IosBuildPipeline } from '../server/ios/iosBuildPipeline.js';
import {
  generateVideoEditorProject,
  getVideoEditorConfig
} from '../server/ios/videoEditorGenerator.js';

const mode = process.argv[2] || 'build';
const buildId = `phase35_ci_${mode}_${Date.now()}`;

const config = getVideoEditorConfig();
const files = generateVideoEditorProject(config);
console.log(`Generated ${Object.keys(files).length} ClipForge project files for ${config.bundleId}`);
console.log(
  `Config: deploymentTarget=${config.deploymentTarget} swift=${config.swiftVersion} permissions=${config.permissions.join(',') || 'none'}`
);

const structural = IosProjectValidator.validateProjectFiles(files, config);
console.log(`Structural validation: valid=${structural.valid} errors=[${structural.errors.join('; ')}]`);
if (!structural.valid) {
  console.log('RESULT_JSON ' + JSON.stringify({ mode, ok: false, reason: 'structural validation failed', errors: structural.errors }));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// ops mode: the editor's pure-Foundation core (EditorModels +
// EditorOps) is compiled with the host's real swiftc together with a
// generated test main that exercises the same behaviours the Android
// app's EditorOpsTest covers, and the binary is run. macOS only —
// swiftc here is Xcode's toolchain.
// ---------------------------------------------------------------------------
if (mode === 'ops') {
  if (process.platform !== 'darwin') {
    console.log('RESULT_JSON ' + JSON.stringify({ mode, ok: false, reason: 'environment-unavailable', detail: 'the swiftc ops test runs on macOS (Xcode toolchain) in CI' }));
    process.exit(1);
  }
  const modelsKey = Object.keys(files).find((k) => k.endsWith('/Editor/EditorModels.swift'));
  const opsKey = Object.keys(files).find((k) => k.endsWith('/Editor/EditorOps.swift'));
  if (!modelsKey || !opsKey) {
    console.log('RESULT_JSON ' + JSON.stringify({ mode, ok: false, reason: 'editor core sources missing from the generated project' }));
    process.exit(1);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase35-ops-'));
  const modelsPath = path.join(dir, 'EditorModels.swift');
  const opsPath = path.join(dir, 'EditorOps.swift');
  const mainPath = path.join(dir, 'main.swift');
  const binPath = path.join(dir, 'ops-test');
  fs.writeFileSync(modelsPath, files[modelsKey]);
  fs.writeFileSync(opsPath, files[opsKey]);
  fs.writeFileSync(mainPath, opsTestMainSwift());
  try {
    execFileSync('swiftc', ['-O', modelsPath, opsPath, mainPath, '-o', binPath], { stdio: 'inherit' });
    execFileSync(binPath, [], { stdio: 'inherit' });
    console.log('RESULT_JSON ' + JSON.stringify({ mode, ok: true, detail: 'swiftc compiled EditorModels+EditorOps and all ops checks passed' }));
    process.exit(0);
  } catch (err: any) {
    console.log('RESULT_JSON ' + JSON.stringify({ mode, ok: false, reason: 'ops test failed', detail: String(err?.message ?? err) }));
    process.exit(1);
  }
}

if (mode === 'broken') {
  const key = Object.keys(files).find((k) => k.endsWith('/Editor/EditorOps.swift'));
  if (!key) {
    console.log('RESULT_JSON ' + JSON.stringify({ mode, ok: false, reason: 'no EditorOps.swift generated' }));
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

/**
 * The generated ops test main: the same checks as the Android app's
 * EditorOpsTest (overlap rejection, trim clamping, split math,
 * volume/speed clamps, JSON round-trip, SRT shape), run against the
 * generated Swift EditorModels + EditorOps compiled by swiftc.
 */
function opsTestMainSwift(): string {
  return `import Foundation

var failures = 0
func check(_ condition: Bool, _ name: String) {
    if condition {
        print("PASS " + name)
    } else {
        print("FAIL " + name)
        failures += 1
    }
}
func checkThrows(_ name: String, _ body: () throws -> VideoProject) {
    do {
        _ = try body()
        check(false, name)
    } catch {
        check(true, name)
    }
}

func projectWithClip() -> VideoProject {
    var project = EditorOps.createProject(name: "Test")
    project = EditorOps.addMedia(project, asset: MediaAsset(
        id: "m1", path: "media/import_test.mov", durationSec: 10,
        hasVideo: true, hasAudio: true, kind: "video"
    ))
    let trackId = project.tracks.first { $0.kind == "video" }!.id
    return try! EditorOps.addClip(project, trackId: trackId, mediaId: "m1", trackStart: 0)
}

// Overlap rejection
do {
    let project = projectWithClip()
    let trackId = project.tracks.first { $0.kind == "video" }!.id
    checkThrows("addClipRejectsOverlap") { try EditorOps.addClip(project, trackId: trackId, mediaId: "m1", trackStart: 5) }
}

// Trim clamps to the media duration
do {
    let project = projectWithClip()
    let clip = project.tracks.first { $0.kind == "video" }!.clips[0]
    let trimmed = try! EditorOps.trimClip(project, clipId: clip.id, sourceIn: -5, sourceOut: 99)
    let result = trimmed.tracks.first { $0.kind == "video" }!.clips[0]
    check(result.sourceIn == 0 && result.sourceOut == 10, "trimClampsToMediaDuration")
}

// Split math: sourceIn + offset x speed, spans preserved
do {
    let project = projectWithClip()
    let clip = project.tracks.first { $0.kind == "video" }!.clips[0]
    let split = try! EditorOps.splitClip(project, clipId: clip.id, atTimelineSec: 4)
    let clips = split.tracks.first { $0.kind == "video" }!.clips.sorted { $0.trackStart < $1.trackStart }
    check(clips.count == 2, "splitProducesTwoClips")
    check(clips[0].duration() == 4 && clips[1].duration() == 6 && clips[1].sourceIn == 4, "splitCoversTheOriginalSpan")
}

// Volume and speed clamps
do {
    let project = projectWithClip()
    let clip = project.tracks.first { $0.kind == "video" }!.clips[0]
    let loud = try! EditorOps.setClipVolume(project, clipId: clip.id, volume: 7)
    check(loud.tracks.first { $0.kind == "video" }!.clips[0].volume == 1, "volumeIsClamped")
    let fast = try! EditorOps.setClipSpeed(project, clipId: clip.id, speed: 99)
    check(fast.tracks.first { $0.kind == "video" }!.clips[0].speedOrDefault() == 4, "speedIsClamped")
}

// JSON round-trip preserves the project
do {
    var project = projectWithClip()
    project = EditorOps.addText(project, text: "Hello", trackStart: 1, durationSec: 2)
    project = try! EditorOps.addCaption(project, startSec: 0.5, endSec: 2.5, text: "First line")
    let restored = try! VideoProject.fromJSON(project.toJSON())
    check(restored.id == project.id, "jsonRoundTripId")
    check(restored.tracks.first { $0.kind == "video" }!.clips.count == 1, "jsonRoundTripClips")
    check(restored.texts.first?.text == "Hello", "jsonRoundTripText")
    check(restored.captions.first?.text == "First line", "jsonRoundTripCaption")
    check(restored.duration() == project.duration(), "jsonRoundTripDuration")
}

// SRT shape matches the server format
do {
    var project = EditorOps.createProject(name: "Caps")
    project = try! EditorOps.addCaption(project, startSec: 0.5, endSec: 2.5, text: "First line")
    let srt = EditorOps.captionsToSrt(project)
    check(srt.contains("1\\n00:00:00,500 --> 00:00:02,500\\nFirst line"), "srtFormattingMatchesTheServerShape")
}

print(failures == 0 ? "OPS_ALL_PASS" : "OPS_FAILURES \\(failures)")
exit(failures == 0 ? 0 : 1)
`;
}
