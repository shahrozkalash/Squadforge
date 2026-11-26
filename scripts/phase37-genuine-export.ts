/**
 * Phase 37 genuine export-parity verification harness.
 *
 * Proves the Phase 37 ClipForge export upgrade end to end on a
 * host with a real Android toolchain and a running emulator:
 *   1. Generates the editor project and builds it with SquadForge's
 *      own AndroidBuildPipeline (Gradle assembleDebug +
 *      testDebugUnitTest — EditorOpsTest + ExportPlannerTest).
 *   2. Synthesizes known media with ffmpeg (solid-colour clips of
 *      known geometry, a sine tone) into the generated project's
 *      androidTest assets and builds the instrumented test APK.
 *   3. Installs both APKs on the emulator and runs ExportParityTest,
 *      which drives the app's real Media3 export of a project that
 *      exercises a crossfade, a 2x speed clip, a PiP overlay with
 *      a transform, an image overlay, audio fades and a burned-in
 *      text element.
 *   4. Pulls the exported MP4 and verifies it on the host with
 *      ffprobe (duration / streams / size) and ffmpeg frame and
 *      audio measurements (overlay presence and position, crossfade
 *      blend colour, text pixels, fade envelopes).
 *
 * Usage: tsx scripts/phase37-genuine-export.ts all
 * Exit code: 0 only when every stage genuinely passed.
 * A single RESULT_JSON line is printed for machine-readable evidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AndroidBuildPipeline } from '../server/android/androidBuildPipeline.js';
import {
  generateVideoEditorProject,
  getVideoEditorConfig
} from '../server/android/videoEditorGenerator.js';

const PACKAGE_NAME = 'com.squadforge.clipforge';
const outDir = path.resolve(process.cwd(), 'phase37-output');
fs.mkdirSync(outDir, { recursive: true });

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? 600000,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    env: process.env
  });
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function ffmpeg(args: string[]): void {
  const r = run('ffmpeg', ['-y', '-v', 'error', ...args]);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')} :: ${r.stderr.slice(0, 300)}`);
}

const evidence: Record<string, unknown> = { mode: 'all' };
let ok = false;

try {
  // ---- 1. Generate + genuine Gradle build with JVM unit tests ----
  const config = getVideoEditorConfig();
  const files = generateVideoEditorProject(config);
  const buildId = `phase37_ci_${Date.now()}`;
  evidence.buildId = buildId;
  const { result, apkBuffer } = await AndroidBuildPipeline.build(buildId, config, files, {
    mode: 'debug',
    target: 'apk',
    runTests: true
  });
  console.log('build status:', result.status, 'apkBytes:', apkBuffer?.length || 0);
  if (result.status !== 'success' || !apkBuffer) {
    // Print the pipeline's full diagnostics: result.error alone is only the
    // first Gradle error line, which hid the cause of the run #4 failure.
    for (const d of result.diagnostics || []) console.log('BUILD_DIAGNOSTIC ' + d.severity + ' ' + d.file + ': ' + d.message);
    for (const l of (result.logs || []).slice(-15)) console.log('BUILD_LOG ' + l.level + ' ' + l.step + ': ' + String(l.message).slice(0, 300));
    throw new Error(`genuine build failed: ${result.error || 'unknown'}`);
  }
  evidence.apkBytes = apkBuffer.length;

  const workspace = path.resolve(process.cwd(), '.android_workspaces', buildId);
  const resultsDir = path.join(workspace, 'app', 'build', 'test-results', 'testDebugUnitTest');
  let tests = 0, failures = 0, errors = 0, skipped = 0;
  for (const f of fs.readdirSync(resultsDir).filter((x) => x.endsWith('.xml'))) {
    const xml = fs.readFileSync(path.join(resultsDir, f), 'utf-8');
    const head = xml.match(/<testsuite[^>]*>/);
    if (!head) continue;
    const attr = (n: string) => Number(head[0].match(new RegExp(`${n}="(\\d+)"`))?.[1] || 0);
    tests += attr('tests'); failures += attr('failures'); errors += attr('errors'); skipped += attr('skipped');
  }
  console.log(`UNIT_TESTS tests=${tests} failures=${failures} errors=${errors} skipped=${skipped}`);
  evidence.unitTests = { tests, failures, errors, skipped };
  if (tests === 0) throw new Error('no unit test results found');

  // ---- 2. Synthesize known media into androidTest assets ----
  const assetsDir = path.join(workspace, 'app', 'src', 'androidTest', 'assets', 'exporttest');
  fs.mkdirSync(assetsDir, { recursive: true });
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xFF0000:s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(assetsDir, 'clipA.mp4')]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x0000FF:s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(assetsDir, 'clipB.mp4')]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x00FF00:s=160x120:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(assetsDir, 'overlay.mp4')]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xFFFF00:s=200x100:d=0.1', '-frames:v', '1', path.join(assetsDir, 'image.png')]);
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-c:a', 'aac', path.join(assetsDir, 'music.mp4')]);
  console.log('synthetic media written to androidTest assets');

  // ---- 3. Build the instrumented test APK ----
  const gradle = run('sh', ['gradlew', 'assembleDebugAndroidTest', '--console=plain'], { cwd: workspace, timeoutMs: 1200000 });
  fs.writeFileSync(path.join(outDir, 'androidtest-gradle.log'), gradle.stdout + gradle.stderr);
  if (gradle.status !== 0) throw new Error(`assembleDebugAndroidTest failed (see phase37-output/androidtest-gradle.log)`);
  const appApk = path.join(workspace, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  const testApk = path.join(workspace, 'app', 'build', 'outputs', 'apk', 'androidTest', 'debug', 'app-debug-androidTest.apk');
  if (!fs.existsSync(appApk) || !fs.existsSync(testApk)) throw new Error('APK outputs missing after Gradle builds');
  console.log('app APK:', fs.statSync(appApk).size, 'bytes; test APK:', fs.statSync(testApk).size, 'bytes');

  // ---- 4. Install + run the instrumented export test ----
  const adb = path.join(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '', 'platform-tools', 'adb');
  run(adb, ['wait-for-device'], { timeoutMs: 120000 });
  for (let i = 0; i < 60; i++) {
    const boot = run(adb, ['shell', 'getprop', 'sys.boot_completed']);
    if (boot.stdout.trim() === '1') break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  const inst1 = run(adb, ['install', '-r', '-t', appApk], { timeoutMs: 300000 });
  if (inst1.status !== 0) throw new Error(`app install failed: ${inst1.stdout} ${inst1.stderr}`);
  const inst2 = run(adb, ['install', '-r', '-t', testApk], { timeoutMs: 300000 });
  if (inst2.status !== 0) throw new Error(`test install failed: ${inst2.stdout} ${inst2.stderr}`);
  const instrument = run(adb, [
    'shell', 'am', 'instrument', '-w', '-r',
    '-e', 'class', `${PACKAGE_NAME}.ExportParityTest`,
    `${PACKAGE_NAME}.test/androidx.test.runner.AndroidJUnitRunner`
  ], { timeoutMs: 900000 });
  fs.writeFileSync(path.join(outDir, 'instrument.log'), instrument.stdout + instrument.stderr);
  // Capture logcat either way: Media3 logs the real ExportException cause
  // (asset loader / codec) there, which the test's summary cannot show.
  try {
    const logcat = run(adb, ['logcat', '-d'], { timeoutMs: 60000 });
    fs.writeFileSync(path.join(outDir, 'logcat.txt'), logcat.stdout + logcat.stderr);
    const interesting = (logcat.stdout + logcat.stderr).split('\n')
      .filter((l) => /ExportException|AssetLoader|Transformer|MediaCodec|Decoder|ExportParity/i.test(l))
      .slice(0, 40);
    for (const line of interesting) console.log('LOGCAT ' + line.slice(0, 300));
  } catch { /* logcat is diagnostic only */ }
  const instrumentOk = /OK \(1 test\)/.test(instrument.stdout);
  console.log('INSTRUMENTED status=' + (instrumentOk ? 'pass' : 'fail'));
  evidence.instrumented = instrumentOk ? 'pass' : 'fail';
  if (!instrumentOk) throw new Error('instrumented export test did not report OK (1 test) — see phase37-output/instrument.log');

  // ---- 5. Pull the exported MP4 and verify with ffprobe/ffmpeg ----
  const remoteDir = `/sdcard/Android/data/${PACKAGE_NAME}/files`;
  const localMp4 = path.join(outDir, 'export_parity_output.mp4');
  const pull = run(adb, ['pull', `${remoteDir}/export_parity_output.mp4`, localMp4], { timeoutMs: 300000 });
  if (pull.status !== 0 || !fs.existsSync(localMp4)) throw new Error('could not pull exported MP4 from the emulator');
  run(adb, ['pull', `${remoteDir}/export_parity_result.txt`, path.join(outDir, 'export_parity_result.txt')]);
  console.log('exported MP4 pulled:', fs.statSync(localMp4).size, 'bytes');

  const probe = run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', localMp4]);
  const probeJson = JSON.parse(probe.stdout);
  const vStream = probeJson.streams.find((s: any) => s.codec_type === 'video');
  const aStream = probeJson.streams.find((s: any) => s.codec_type === 'audio');
  const duration = Number(probeJson.format.duration);
  console.log(`FFPROBE duration=${duration.toFixed(2)} video=${vStream?.width}x${vStream?.height} audio=${aStream ? aStream.codec_name : 'none'}`);

  const pixel = (t: number, x: number, y: number): [number, number, number] => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', localMp4, '-ss', String(t), '-frames:v', '1', '-vf', `crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1024 * 1024 });
    const b = r.stdout as unknown as Buffer;
    if (!b || b.length < 3) throw new Error(`pixel read failed at t=${t} (${x},${y})`);
    return [b[0], b[1], b[2]];
  };
  const regionWhiteCount = (t: number, x: number, y: number, w: number, h: number): number => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', localMp4, '-ss', String(t), '-frames:v', '1', '-vf', `crop=${w}:${h}:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 16 * 1024 * 1024 });
    const b = r.stdout as unknown as Buffer;
    let count = 0;
    for (let i = 0; i + 2 < b.length; i += 3) {
      if (b[i] > 200 && b[i + 1] > 200 && b[i + 2] > 200) count++;
    }
    return count;
  };
  const rms = (start: number, dur: number): number => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(start), '-t', String(dur), '-i', localMp4, '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { maxBuffer: 16 * 1024 * 1024 });
    const b = r.stdout as unknown as Buffer;
    const view = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
    let sum = 0;
    for (const v of view) sum += v * v;
    return Math.sqrt(sum / Math.max(1, view.length));
  };

  const checks: Record<string, boolean> = {};
  checks.duration = duration >= 4.6 && duration <= 5.4;
  checks.resolution = vStream?.width === 640 && vStream?.height === 360;
  checks.audioStream = Boolean(aStream);
  const pip = pixel(2.0, 470, 260);
  checks.pipGreen = pip[1] > 140 && pip[0] < 120 && pip[2] < 120;
  const basePx = pixel(2.0, 60, 300);
  checks.baseRed = basePx[0] > 140 && basePx[1] < 120 && basePx[2] < 120;
  const blend = pixel(3.5, 60, 300);
  checks.crossfadeBlend = blend[0] > 80 && blend[2] > 80 && blend[1] < 100 && Math.abs(blend[0] - blend[2]) < 80;
  const img = pixel(4.6, 100, 270);
  checks.imageYellow = img[0] > 140 && img[1] > 140 && img[2] < 130;
  const afterPip = pixel(4.6, 470, 260);
  checks.pipGoneBlueBase = afterPip[2] > 140 && afterPip[1] < 120;
  checks.textWhitePixels = regionWhiteCount(1.0, 40, 30, 260, 80) > 30;
  const rmsStart = rms(0.1, 0.3);
  const rmsMid = rms(2.0, 0.5);
  const rmsEnd = rms(4.55, 0.35);
  checks.audioFadeIn = rmsStart < 0.55 * rmsMid;
  checks.audioFadeOut = rmsEnd < 0.55 * rmsMid;
  console.log('pixels: pip=' + pip.join(',') + ' base=' + basePx.join(',') + ' blend=' + blend.join(',') + ' image=' + img.join(',') + ' afterPip=' + afterPip.join(','));
  console.log(`audio RMS: start=${rmsStart.toFixed(4)} mid=${rmsMid.toFixed(4)} end=${rmsEnd.toFixed(4)}`);
  for (const [name, passed] of Object.entries(checks)) {
    console.log(`EXPORT_VERIFY ${name}=${passed ? 'pass' : 'fail'}`);
  }
  evidence.verify = checks;
  evidence.probe = { duration, width: vStream?.width, height: vStream?.height, audioCodec: aStream?.codec_name };
  ok = Object.values(checks).every(Boolean);
  if (!ok) throw new Error('one or more EXPORT_VERIFY checks failed');
} catch (e) {
  evidence.error = e instanceof Error ? e.message : String(e);
  console.error('PHASE37 HARNESS ERROR:', evidence.error);
}

console.log('RESULT_JSON ' + JSON.stringify({ ...evidence, ok }));
process.exit(ok ? 0 : 1);
