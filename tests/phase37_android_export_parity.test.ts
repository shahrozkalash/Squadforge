/**
 * Phase 37 — Android Video Editor Export Parity tests.
 *
 * The generated ClipForge export is upgraded from the Phase 34
 * base-track-only render to full timeline parity with the server
 * engine, using only Media3 1.6.1 APIs verified against the
 * published AARs: a pure ExportPlanner (sequence segmentation,
 * gap positioning, crossfade heads, transform windows) drives
 * the Transformer exporter; SpeedChangeEffect + SonicAudioProcessor
 * render clip speed; a sample-level ClipAudioProcessor renders
 * gain and audio fades; DefaultVideoCompositor with a custom
 * VideoCompositorSettings composites overlay video/image tracks
 * and crossfade dissolves; TextOverlay burns text in at its
 * project position, size and colour.
 *
 * These tests verify the generated project structurally. The
 * planner's behaviour is verified by the generated app's own JVM
 * tests (ExportPlannerTest, run by the Phase 34/37 CI workflows),
 * and the genuine on-device render — synthetic media exported on
 * an emulator and measured with ffprobe — by the Phase 37 CI
 * workflow (scripts/phase37-genuine-export.ts).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  generateVideoEditorProject,
  getVideoEditorConfig
} from '../server/android/videoEditorGenerator.js';

const files = generateVideoEditorProject(getVideoEditorConfig());
const kt = (suffix: string): string => {
  const key = Object.keys(files).find(k => k.endsWith(suffix));
  assert.ok(key, `generated file ${suffix} missing`);
  return files[key!];
};

describe('Phase 37: export parity structure', () => {
  test('generator emits the planner, its JVM tests and the on-device parity test', () => {
    kt('/export/ExportPlan.kt');
    kt('/ExportPlannerTest.kt');
    kt('/ExportParityTest.kt');
    const gradle = files['app/build.gradle.kts'];
    assert.ok(gradle.includes('androidTestImplementation("androidx.test.ext:junit:1.2.1")'));
    assert.ok(gradle.includes('androidTestImplementation("androidx.test:runner:1.6.2")'));
    assert.ok(gradle.includes('testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"'));
  });

  test('planner renders crossfade for real and states the rest as cuts', () => {
    const plan = kt('/export/ExportPlan.kt');
    assert.ok(plan.includes('REAL_TRANSITIONS = setOf("crossfade")'));
    assert.ok(plan.includes('render as cuts in the app export'));
    assert.ok(plan.includes('object ExportPlanner'));
    // Crossfade heads are separate gap-positioned items whose
    // window ramps alpha over the junction.
    assert.ok(plan.includes('HeadEntry'));
    assert.ok(plan.includes('fadeInSec = head.durationSec'));
    // Export time accounts for crossfade shrinkage.
    assert.ok(plan.includes('exportStart'));
    assert.ok(plan.includes('fun exportTime'));
  });

  test('planner gap-positions overlay and audio sequences with transform windows', () => {
    const plan = kt('/export/ExportPlan.kt');
    assert.ok(plan.includes('PlanWindow'));
    assert.ok(plan.includes('PlanElement.Gap'));
    // Transform geometry: scaled size and centre anchor as
    // fractions of the project frame (server overlay semantics).
    assert.ok(plan.includes('scaledW / projW'));
    assert.ok(plan.includes('anchorX = (tr.x + scaledW / 2.0) / projW * 2.0 - 1.0'));
    assert.ok(plan.includes('alpha = tr.opacity'));
    assert.ok(plan.includes('rotationDeg = tr.rotationDeg'));
  });

  test('exporter uses genuine Media3 speed, fade, compositing and text APIs', () => {
    const exporter = kt('/export/VideoExporter.kt');
    assert.ok(exporter.includes('SpeedChangeEffect'));
    assert.ok(exporter.includes('SonicAudioProcessor'));
    assert.ok(exporter.includes('sonic.setSpeed'));
    assert.ok(exporter.includes('class ClipAudioProcessor'));
    assert.ok(exporter.includes('class ExportCompositorSettings'));
    assert.ok(exporter.includes('VideoCompositorSettings'));
    assert.ok(exporter.includes('setVideoCompositorSettings'));
    // Media3 binds the Transformer to the application thread: build, start
    // and cancel are all marshalled onto the main looper (Phase 37 run #2
    // failed on the emulator with "Transformer is accessed on the wrong
    // thread" before this was pinned).
    assert.ok(exporter.includes("Media3's Transformer is bound to the application (main) thread"));
    assert.ok(exporter.includes('handler.post { transformer?.cancel() }'));
    assert.ok(exporter.includes('builder.addGap'));
    assert.ok(exporter.includes('setImageDurationMs'));
    // Text burn-in carries position, size and colour from the model.
    assert.ok(exporter.includes('TextOverlay.createStaticTextOverlay'));
    assert.ok(exporter.includes('ForegroundColorSpan'));
    assert.ok(exporter.includes('setOverlayFrameAnchor(-1f, 1f)'));
    // The Phase 34 limitation notes are gone.
    assert.ok(!exporter.includes('preview-only and were not composited'));
    assert.ok(!exporter.includes('not baked into the app export'));
  });

  test('audio processor envelope mirrors the server afade semantics', () => {
    const exporter = kt('/export/VideoExporter.kt');
    // Fades are measured in clip time (segment offset applied),
    // crossfade ramps in segment time.
    assert.ok(exporter.includes('val clipT = segmentOffsetSec + localT'));
    assert.ok(exporter.includes('clipDurationSec - fadeOutSec'));
    assert.ok(exporter.includes('extraFadeInSec'));
    assert.ok(exporter.includes('extraFadeOutSec'));
  });

  test('planner JVM tests cover every parity feature', () => {
    const tests = kt('/ExportPlannerTest.kt');
    for (const name of [
      'crossfadeSplitsIncomingClipIntoCompositedHead',
      'unsupportedTransitionTypeRendersAsCutWithNote',
      'speedHalvesTimelineDurationAndIsCarriedOnItem',
      'fadesAreCarriedWithClipRelativeOffsetsAfterTextSplit',
      'overlayTrackIsPreRollPositionedWithTransformWindow',
      'imageClipOnOverlayTrackBecomesImageItem',
      'imageClipOnBaseTrackIsExportedAsImageItem',
      'audioTrackClipsAreGapPositionedWithCombinedGainAndMuteRespected',
      'textAttachesOnlyToOverlappingSegmentsWithProjectFractions',
      'emptyProjectYieldsNoSequences',
      'crossfadeLongerThanHalfTheShorterClipIsClamped'
    ]) {
      assert.ok(tests.includes(name), `planner test ${name} missing`);
    }
    const count = (tests.match(/@Test/g) || []).length;
    assert.equal(count, 11, 'ExportPlannerTest must contain exactly 11 tests');
  });

  test('on-device parity test exercises every feature and leaves an artifact', () => {
    const t = kt('/ExportParityTest.kt');
    assert.ok(t.includes('exporttest/'));
    assert.ok(t.includes('"crossfade"'));
    assert.ok(t.includes('speed = 2.0'));
    assert.ok(t.includes('fadeInSec = 1.0'));
    assert.ok(t.includes('ClipTransform(400.0, 200.0'));
    assert.ok(t.includes('"HELLO"'));
    assert.ok(t.includes('export_parity_output.mp4'));
    assert.ok(t.includes('VideoExporter'));
  });

  test('project model and JSON compatibility are preserved', () => {
    const models = kt('/editor/EditorModels.kt');
    for (const field of ['fadeInSec', 'fadeOutSec', 'transform', 'speed', 'trackStart', 'sourceIn', 'sourceOut']) {
      assert.ok(models.includes(field), `model field ${field} missing`);
    }
    const readme = files['VIDEO_EDITOR_README.md'];
    assert.ok(readme.includes('crossfade transitions'));
    assert.ok(readme.includes('render as cuts in the app export'));
    assert.ok(!readme.includes('Overlay (PiP) video tracks are preview-only'));
  });
});
