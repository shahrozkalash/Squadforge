import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createProject, addTrack, addClip } from '../server/videoEditor/timeline.js';
import { applyEditOperation } from '../server/videoEditor/editingOps.js';
import { exportVideo, defaultExportSettings } from '../server/videoEditor/videoExporter.js';
import { renderPreviewFrame } from '../server/videoEditor/playback.js';
import { importMedia } from '../server/videoEditor/mediaProbe.js';
import { computeWaveform } from '../server/videoEditor/waveform.js';
import { analyzeMedia } from '../server/videoEditor/aiEditing.js';
import {
  captionsToSrt,
  captionsToVtt,
  parseSrt,
  parseVtt,
  activeCaptionAt
} from '../server/videoEditor/captions.js';
import {
  captionProviderConfigFromEnv,
  generateCaptionsWithProvider
} from '../server/videoEditor/captionProviders.js';
import type { MediaAsset, VideoProject } from '../server/videoEditor/types.js';
import { decodePng } from '../server/imageEditor/imageCodec.js';

const BASE = path.join(process.cwd(), '.tmp_p29_tests');
const assets = new Map<string, MediaAsset>();
const byName = (name: string): MediaAsset => [...assets.values()].find((a) => a.path.endsWith(name))!;

function ff(args: string[]): void {
  execFileSync('ffmpeg', ['-y', ...args], { stdio: 'pipe' });
}

/** Decode a media file's audio to mono PCM and return RMS over [t0, t1]. */
function rmsBetween(mediaPath: string, t0: number, t1: number): number {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', mediaPath, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { maxBuffer: 64 * 1024 * 1024 });
  const start = Math.floor(t0 * 8000);
  const end = Math.min(Math.floor(t1 * 8000), raw.length / 2);
  let sum = 0;
  let count = 0;
  for (let i = start; i < end; i++) {
    const v = raw.readInt16LE(i * 2) / 32768;
    sum += v * v;
    count++;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

function px(frame: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number] {
  const i = (y * frame.width + x) * 4;
  return [frame.data[i], frame.data[i + 1], frame.data[i + 2]];
}

async function exportOk(project: VideoProject, name: string, settings = defaultExportSettings(project)): Promise<string> {
  const out = path.join(BASE, name);
  const result = await exportVideo(project, assets, settings, out);
  assert.equal(result.status, 'success', `${name}: ${result.error} | ${(result.ffmpegLogTail || '').slice(-300)}`);
  return out;
}

function toneProject(): { project: VideoProject; clipId: string } {
  const project = createProject('p29', 320, 240, 30);
  const clip = addClip(project, assets, project.tracks[0].id, { mediaId: byName('tone.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 3 });
  return { project, clipId: clip.id };
}

describe('SquadForge Phase 29: Audio, Captions and AI Editing Engine Test Suite', () => {
  before(async () => {
    fs.mkdirSync(BASE, { recursive: true });
    ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=3:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440:d=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(BASE, 'tone.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=3:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(BASE, 'silent.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=2:r=30', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=2:r=30', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(BASE, 'twotone.mp4')]);
    // 1s tone + 1.5s silence + 1s tone (audio only)
    ff(['-f', 'lavfi', '-i', 'sine=frequency=440:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=1.5', '-f', 'lavfi', '-i', 'sine=frequency=440:d=1', '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]', '-map', '[a]', path.join(BASE, 'gap.wav')]);
    ff(['-f', 'lavfi', '-i', 'sine=frequency=880:d=2', path.join(BASE, 'voice.wav')]);
    for (const f of ['tone.mp4', 'silent.mp4', 'twotone.mp4', 'gap.wav', 'voice.wav']) {
      const a = await importMedia(path.join(BASE, f));
      assets.set(a.id, a);
    }
  });
  after(() => fs.rmSync(BASE, { recursive: true, force: true }));

  describe('1. Audio tracks, fades, gain and mute', () => {
    test('1.1 Fade-in and fade-out shape the exported audio envelope', { timeout: 300_000 }, async () => {
      const { project, clipId } = toneProject();
      applyEditOperation(project, assets, { type: 'setFades', clipId, fadeInSec: 1, fadeOutSec: 1 });
      const out = await exportOk(project, 'faded.mp4');
      const mid = rmsBetween(out, 1.4, 1.6);
      const start = rmsBetween(out, 0.02, 0.2);
      const end = rmsBetween(out, 2.8, 2.98);
      // ffmpeg's sine source peaks at 0.125 (RMS 0.088) — the fade
      // proof is in the RATIOS against the unfaded middle.
      assert.ok(mid > 0.07, `mid-clip tone should be at source strength, RMS ${mid}`);
      assert.ok(start < mid * 0.35, `fade-in start RMS ${start} must be well below mid ${mid}`);
      assert.ok(end < mid * 0.35, `fade-out end RMS ${end} must be well below mid ${mid}`);
      assert.throws(
        () => applyEditOperation(project, assets, { type: 'setFades', clipId, fadeInSec: 2, fadeOutSec: 2 }),
        /exceed the clip duration/
      );
    });

    test('1.2 Independent track gain and mute change the mix measurably', { timeout: 300_000 }, async () => {
      const build = (secondGain: number, muted: boolean): VideoProject => {
        const project = createProject('mix', 320, 240, 30);
        addClip(project, assets, project.tracks[0].id, { mediaId: byName('tone.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 3 });
        const t2 = addTrack(project, 'audio', 'Second tone');
        addClip(project, assets, t2.id, { mediaId: byName('tone.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 3 });
        applyEditOperation(project, assets, { type: 'setTrackVolume', trackId: t2.id, volume: secondGain });
        applyEditOperation(project, assets, { type: 'setTrackMuted', trackId: t2.id, muted });
        return project;
      };
      const single = rmsBetween(await exportOk(build(1, true), 'mix_muted.mp4'), 1.4, 1.6);
      const doubled = rmsBetween(await exportOk(build(1, false), 'mix_both.mp4'), 1.4, 1.6);
      const halved = rmsBetween(await exportOk(build(0.5, false), 'mix_half.mp4'), 1.4, 1.6);
      assert.ok(doubled > single * 1.6, `two in-phase tones must be much louder (${single} -> ${doubled})`);
      assert.ok(halved > single * 1.25 && halved < doubled * 0.9, `half-gain track must sit between (${single}, ${halved}, ${doubled})`);
    });

    test('1.3 Audio import (voiceover path) probes as an audio asset', async () => {
      const voice = byName('voice.wav');
      assert.equal(voice.kind, 'audio');
      assert.equal(voice.hasAudio, true);
      assert.equal(voice.hasVideo, false);
    });
  });

  describe('2. Waveform from real audio', () => {
    test('2.1 Peaks track the actual signal: loud, silent gap, loud', async () => {
      const tone = await computeWaveform(path.join(BASE, 'tone.mp4'), { bucketsPerSecond: 10 });
      assert.equal(tone.status, 'success', tone.error);
      assert.ok(tone.peaks!.length >= 28 && tone.peaks!.length <= 32, `~30 buckets expected, got ${tone.peaks!.length}`);
      // The sine source peaks at exactly 0.125 (AAC decode can ring a
      // little above it); a constant tone must peak at source level in
      // every FULL bucket — not near 1, not near 0, roughly constant.
      // (The final bucket is a partial AAC-padding tail and is excluded.)
      const fullBuckets = tone.peaks!.slice(0, 30);
      assert.ok(fullBuckets.every((p) => p > 0.09 && p < 0.25), `constant sine must peak at ~0.125 everywhere: ${fullBuckets.slice(0, 5)}`);
      assert.ok(Math.max(...fullBuckets) / Math.min(...fullBuckets) < 1.2, 'constant tone peaks must be constant');

      const gap = await computeWaveform(path.join(BASE, 'gap.wav'), { bucketsPerSecond: 10 });
      assert.equal(gap.status, 'success', gap.error);
      const peaks = gap.peaks!;
      const at = (sec: number): number => peaks[Math.min(peaks.length - 1, Math.floor(sec * 10))];
      assert.ok(at(0.5) > 0.1, 'first tone segment at source level');
      assert.ok(at(1.7) < 0.01, `silent gap must be ~0, got ${at(1.7)}`);
      assert.ok(at(3.0) > 0.1, 'final tone segment at source level');

      const noAudio = await computeWaveform(path.join(BASE, 'silent.mp4'));
      assert.equal(noAudio.status, 'error');
      assert.match(noAudio.error!, /no audio/);
    });
  });

  describe('3. Captions: SRT/VTT, editing, burn-in', () => {
    const cues = [
      { id: 'c1', startSec: 0.5, endSec: 2.25, text: 'Hello world' },
      { id: 'c2', startSec: 3, endSec: 4.75, text: 'Second line\nwith a break' },
      { id: 'c3', startSec: 65.5, endSec: 67, text: 'Over a minute in' }
    ];

    test('3.1 SRT and VTT round-trip losslessly; malformed input fails honestly', () => {
      const srt = captionsToSrt(cues);
      assert.match(srt, /00:01:05,500 --> 00:01:07,000/);
      const parsedSrt = parseSrt(srt);
      assert.equal(parsedSrt.length, 3);
      assert.ok(Math.abs(parsedSrt[2].startSec - 65.5) < 0.001);
      assert.equal(parsedSrt[1].text, 'Second line\nwith a break');
      const vtt = captionsToVtt(cues);
      assert.ok(vtt.startsWith('WEBVTT'));
      const parsedVtt = parseVtt(vtt);
      assert.equal(parsedVtt.length, 3);
      assert.ok(Math.abs(parsedVtt[0].endSec - 2.25) < 0.001);
      assert.throws(() => parseSrt('1\nnot a timing line\ntext\n'), /Malformed SRT/);
      assert.throws(() => parseVtt('no header here'), /WEBVTT/);
      assert.throws(() => parseSrt('1\n00:00:02,000 --> 00:00:01,000\nBackwards\n'), /endSec/);
    });

    test('3.2 Caption operations validate and stay sorted; active cue resolves', () => {
      const { project } = toneProject();
      const late = applyEditOperation(project, assets, { type: 'addCaption', caption: { startSec: 2, endSec: 3, text: 'Late' } }).caption!;
      applyEditOperation(project, assets, { type: 'addCaption', caption: { startSec: 0, endSec: 1, text: 'Early' } });
      assert.deepEqual(project.captions!.map((c) => c.text), ['Early', 'Late']);
      assert.equal(activeCaptionAt(project, 0.5)?.text, 'Early');
      assert.equal(activeCaptionAt(project, 1.5), null);
      applyEditOperation(project, assets, { type: 'updateCaption', cueId: late.id, patch: { text: 'Later' } });
      assert.equal(activeCaptionAt(project, 2.5)?.text, 'Later');
      assert.throws(
        () => applyEditOperation(project, assets, { type: 'addCaption', caption: { startSec: 2, endSec: 1, text: 'Bad' } }),
        /endSec/
      );
    });

    test('3.3 Captions burn into the export and appear in preview frames', { timeout: 300_000 }, async () => {
      const { project } = toneProject();
      applyEditOperation(project, assets, { type: 'addCaption', caption: { startSec: 0, endSec: 2, text: 'HELLO WORLD' } });
      const out = await exportOk(project, 'captioned.mp4');
      const brightBottom = (frame: ReturnType<typeof decodePng>): boolean => {
        for (let y = 180; y < 238; y++) for (let x = 60; x < 260; x++) {
          const [r, g, b] = px(frame, x, y);
          if (r > 190 && g > 190 && b > 190) return true;
        }
        return false;
      };
      const framePath = path.join(BASE, 'cap_frame.png');
      execFileSync('ffmpeg', ['-y', '-ss', '1', '-i', out, '-frames:v', '1', framePath], { stdio: 'pipe' });
      assert.ok(brightBottom(decodePng(fs.readFileSync(framePath))), 'exported frame must contain the caption text');
      const plain = toneProject();
      const plainOut = await exportOk(plain.project, 'plain.mp4');
      const plainPath = path.join(BASE, 'plain_frame.png');
      execFileSync('ffmpeg', ['-y', '-ss', '1', '-i', plainOut, '-frames:v', '1', plainPath], { stdio: 'pipe' });
      assert.ok(!brightBottom(decodePng(fs.readFileSync(plainPath))), 'control export must have no caption pixels');
      const noBurn = await exportOk(project, 'noburn.mp4', { ...defaultExportSettings(project), burnInCaptions: false });
      const noBurnPath = path.join(BASE, 'noburn_frame.png');
      execFileSync('ffmpeg', ['-y', '-ss', '1', '-i', noBurn, '-frames:v', '1', noBurnPath], { stdio: 'pipe' });
      assert.ok(!brightBottom(decodePng(fs.readFileSync(noBurnPath))), 'burnInCaptions=false must skip burn-in');
      const prev = await renderPreviewFrame(project, assets, 1.0, path.join(BASE, 'cap_prev.png'));
      assert.equal(prev.status, 'success');
      assert.ok(brightBottom(decodePng(fs.readFileSync(path.join(BASE, 'cap_prev.png')))), 'preview must show the active caption');
    });
  });

  describe('4. AI-assisted suggestions from real analysis', () => {
    test('4.1 Scene detection finds the real cut; silence detection finds the real gap', { timeout: 300_000 }, async () => {
      const scenes = await analyzeMedia(path.join(BASE, 'twotone.mp4'));
      assert.equal(scenes.status, 'success', scenes.error);
      assert.ok(
        scenes.sceneChangesSec!.some((t) => Math.abs(t - 2) < 0.35),
        `a scene change near 2s must be detected, got ${scenes.sceneChangesSec}`
      );
      const gap = await analyzeMedia(path.join(BASE, 'gap.wav'));
      assert.equal(gap.status, 'success', gap.error);
      assert.equal(gap.silences!.length, 1, `exactly one silent span expected, got ${JSON.stringify(gap.silences)}`);
      assert.ok(Math.abs(gap.silences![0].startSec - 1) < 0.3, `silence starts ~1s, got ${gap.silences![0].startSec}`);
      assert.ok(Math.abs(gap.silences![0].endSec - 2.5) < 0.3, `silence ends ~2.5s, got ${gap.silences![0].endSec}`);
      assert.ok(gap.suggestedCuts!.some((c) => c.reason === 'silence'), 'a silence cut must be suggested');
      const missing = await analyzeMedia(path.join(BASE, 'nope.mp4'));
      assert.equal(missing.status, 'error');
    });
  });

  describe('5. Caption provider adapter', () => {
    test('5.1 No provider configured -> unavailable, never fabricated cues', async () => {
      const config = captionProviderConfigFromEnv({});
      assert.equal(config.provider, 'none');
      const result = await generateCaptionsWithProvider(path.join(BASE, 'tone.mp4'), config);
      assert.equal(result.status, 'unavailable');
      assert.equal(result.cues, undefined);
      const missingBin = await generateCaptionsWithProvider(path.join(BASE, 'tone.mp4'), {
        provider: 'whisper-cli',
        whisperBin: path.join(BASE, 'no-such-whisper')
      });
      assert.equal(missingBin.status, 'unavailable');
      assert.match(missingBin.error!, /no whisper binary/);
    });

    test('5.2 A working whisper-compatible CLI yields parsed cues; a failing one errors', { timeout: 120_000 }, async () => {
      // A stand-in for the external whisper binary: writes a canned
      // SRT for its input, exactly like the real CLI's contract. The
      // adapter, process handling and SRT parsing under test are real.
      const fakeBin = path.join(BASE, 'fake-whisper.sh');
      const script = [
        '#!/bin/sh',
        'out=""; prev=""',
        'for a in "$@"; do if [ "$prev" = "--output_dir" ]; then out="$a"; fi; prev="$a"; done',
        'in=""; for a in "$@"; do case "$a" in --*) break;; *) in="$a";; esac; done',
        'name=$(basename "$in" | sed "s/\\.[^.]*$//")',
        'printf "1\\n00:00:00,000 --> 00:00:01,500\\nTranscribed by the stand-in\\n\\n2\\n00:00:01,500 --> 00:00:03,000\\nSecond cue\\n" > "$out/$name.srt"',
        'exit 0'
      ].join('\n');
      fs.writeFileSync(fakeBin, script, { mode: 0o755 });
      const ok = await generateCaptionsWithProvider(path.join(BASE, 'tone.mp4'), { provider: 'whisper-cli', whisperBin: fakeBin });
      assert.equal(ok.status, 'success', ok.error);
      assert.equal(ok.cues!.length, 2);
      assert.equal(ok.cues![0].text, 'Transcribed by the stand-in');
      assert.ok(Math.abs(ok.cues![1].endSec - 3) < 0.001);

      const failBin = path.join(BASE, 'fail-whisper.sh');
      fs.writeFileSync(failBin, '#!/bin/sh\necho "model exploded" >&2\nexit 3\n', { mode: 0o755 });
      const failed = await generateCaptionsWithProvider(path.join(BASE, 'tone.mp4'), { provider: 'whisper-cli', whisperBin: failBin });
      assert.equal(failed.status, 'error');
      assert.match(failed.error!, /exit 3/);
      assert.equal(failed.cues, undefined);
    });
  });
});
