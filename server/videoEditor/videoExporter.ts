import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import type {
  ExportResult,
  ExportSettings,
  MediaAsset,
  TimelineClip,
  VideoProject
} from './types.js';
import { baseVideoTrack, clipDuration, timelineDuration, validateProject, writeJournal } from './timeline.js';
import { detectFfmpeg, probeMedia } from './mediaProbe.js';

/**
 * Phase 20: real video export through ffmpeg.
 *
 * The timeline is compiled into an ffmpeg filter graph: per-clip
 * trim/scale/pad/fps normalization, hard-cut groups joined with the
 * concat filter, groups joined by real crossfades (xfade) where the
 * project defines transitions, per-clip effects, drawtext titles, and
 * per-clip audio (trim + volume + delay) mixed with amix. The output
 * is then validated with ffprobe against the export settings and the
 * expected timeline duration. Any failure — missing ffmpeg, missing
 * media, non-zero exit, or a probe mismatch — returns an honest
 * failure; a success is only reported for a real, validated file.
 */

const EFFECT_FILTERS: Record<string, string> = {
  grayscale: 'hue=s=0',
  blur: 'boxblur=5',
  sharpen: 'unsharp=5:5:1.0',
  invert: 'negate'
};

function findFontFile(): string | null {
  const candidates =
    process.platform === 'win32'
      ? ['C:\\Windows\\Fonts\\arial.ttf', 'C:\\Windows\\Fonts\\segoeui.ttf']
      : process.platform === 'darwin'
        ? ['/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf']
        : [
            '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
            '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
            '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
          ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function escapeDrawtext(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/%/g, '\\%');
}

function runFfmpeg(ffmpeg: string, args: string[], timeoutMs: number): Promise<{ code: number; log: string }> {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, args, { shell: false });
    let log = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr?.on('data', (d) => (log += d.toString()));
    child.stdout?.on('data', (d) => (log += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, log: log + String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, log });
    });
  });
}

export function defaultExportSettings(project: VideoProject): ExportSettings {
  return {
    width: project.width,
    height: project.height,
    fps: project.fps,
    format: 'mp4',
    videoCodec: 'libx264',
    audioCodec: 'aac',
    videoBitrateKbps: 4000
  };
}

export async function exportVideo(
  project: VideoProject,
  mediaAssets: Map<string, MediaAsset>,
  settings: ExportSettings,
  outputPath: string,
  options: { journalDir?: string; timeoutMs?: number } = {}
): Promise<ExportResult> {
  const expectedDurationSec = timelineDuration(project);
  const fail = async (error: string, logTail: string = ''): Promise<ExportResult> => {
    if (options.journalDir) {
      await writeJournal(options.journalDir, 'export-failed', error).catch(() => undefined);
    }
    return {
      status: 'failed',
      expectedDurationSec,
      ffmpegLogTail: logTail.slice(-1500),
      error
    };
  };

  if (options.journalDir) {
    await writeJournal(options.journalDir, 'exporting', `ffmpeg export to ${path.basename(outputPath)} started`);
  }

  const validationErrors = validateProject(project, mediaAssets);
  if (validationErrors.length > 0) return fail(`Invalid project: ${validationErrors.join('; ')}`);

  const ffmpeg = detectFfmpeg();
  if (!ffmpeg) return fail('ffmpeg not found on this host; video export requires the ffmpeg engine. Nothing was rendered.');

  const base = baseVideoTrack(project);
  const baseClips = [...base.clips].sort((a, b) => a.trackStart - b.trackStart);
  if (baseClips.length === 0) return fail('Base video track is empty; nothing to export.');

  for (const asset of mediaAssets.values()) {
    if (!fs.existsSync(asset.path)) return fail(`Media file missing at export time: ${asset.path}`);
  }

  // Unique inputs in first-use order
  const inputIndex = new Map<string, number>();
  const inputs: string[] = [];
  const useMedia = (mediaId: string): number => {
    if (!inputIndex.has(mediaId)) {
      inputIndex.set(mediaId, inputs.length);
      inputs.push(mediaAssets.get(mediaId)!.path);
    }
    return inputIndex.get(mediaId)!;
  };

  const transitionAfter = new Map(project.transitions.map((t) => [t.afterClipId, t.durationSec]));
  /** Output-timeline start of a base clip = trackStart minus crossfades before it. */
  const outputStartOf = (clip: TimelineClip): number => {
    let shift = 0;
    for (const c of baseClips) {
      if (c.id === clip.id) break;
      shift += transitionAfter.get(c.id) || 0;
    }
    return clip.trackStart - shift;
  };

  const filters: string[] = [];
  let segCount = 0;
  const segLabel = (clip: TimelineClip): string => {
    const idx = useMedia(clip.mediaId);
    const label = `vseg${segCount++}`;
    const effect = clip.effect !== 'none' ? `,${EFFECT_FILTERS[clip.effect]}` : '';
    filters.push(
      `[${idx}:v]trim=start=${clip.sourceIn}:end=${clip.sourceOut},setpts=PTS-STARTPTS,` +
        `scale=${settings.width}:${settings.height}:force_original_aspect_ratio=decrease,` +
        `pad=${settings.width}:${settings.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
        `fps=${settings.fps},format=yuv420p${effect}[${label}]`
    );
    return label;
  };

  // Group consecutive clips: a crossfade junction starts a new group.
  const groups: { labels: string[]; duration: number }[] = [];
  let current: { labels: string[]; duration: number } = { labels: [], duration: 0 };
  baseClips.forEach((clip, i) => {
    current.labels.push(segLabel(clip));
    current.duration += clipDuration(clip);
    const isLast = i === baseClips.length - 1;
    if (!isLast && transitionAfter.has(clip.id)) {
      groups.push(current);
      current = { labels: [], duration: 0 };
    }
  });
  if (current.labels.length > 0) groups.push(current);

  const groupLabels: string[] = [];
  groups.forEach((group, gi) => {
    const label = `vg${gi}`;
    if (group.labels.length === 1) {
      filters.push(`[${group.labels[0]}]null[${label}]`);
    } else {
      filters.push(`${group.labels.map((l) => `[${l}]`).join('')}concat=n=${group.labels.length}:v=1:a=0[${label}]`);
    }
    groupLabels.push(label);
  });

  // Join groups with xfade.
  let videoLabel = groupLabels[0];
  let accDuration = groups[0].duration;
  for (let gi = 1; gi < groups.length; gi++) {
    const junctionClip = baseClips.filter((c) => transitionAfter.has(c.id))[gi - 1];
    const d = transitionAfter.get(junctionClip.id)!;
    const outLabel = `vx${gi}`;
    filters.push(`[${videoLabel}][${groupLabels[gi]}]xfade=transition=fade:duration=${d}:offset=${(accDuration - d).toFixed(3)}[${outLabel}]`);
    accDuration = accDuration + groups[gi].duration - d;
    videoLabel = outLabel;
  }

  // Titles (drawtext) over the joined video.
  const titledClips = baseClips.filter((c) => c.title && c.title.trim());
  if (titledClips.length > 0) {
    const font = findFontFile();
    if (!font) return fail('Titles are present but no usable font file was found on this host for drawtext.');
    const fontEscaped = font.replace(/\\/g, '/').replace(/:/g, '\\:');
    for (const clip of titledClips) {
      const start = outputStartOf(clip);
      const end = start + clipDuration(clip) - (transitionAfter.get(clip.id) || 0);
      const outLabel = `vt${videoLabel}`;
      filters.push(
        `[${videoLabel}]drawtext=fontfile='${fontEscaped}':text='${escapeDrawtext(clip.title!)}':fontsize=36:` +
          `fontcolor=white:borderw=2:box=1:boxcolor=black@0.5:boxborderw=8:x=(w-text_w)/2:y=h-70:` +
          `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'[${outLabel}]`
      );
      videoLabel = outLabel;
    }
  }

  // Audio: base-clip audio + audio-track clips, each placed on the output timeline.
  const audioLabels: string[] = [];
  let audioCount = 0;
  const addAudio = (clip: TimelineClip, atSec: number) => {
    const media = mediaAssets.get(clip.mediaId)!;
    if (!media.hasAudio) return;
    const idx = useMedia(clip.mediaId);
    const label = `a${audioCount++}`;
    const delayMs = Math.max(0, Math.round(atSec * 1000));
    filters.push(
      `[${idx}:a]atrim=start=${clip.sourceIn}:end=${clip.sourceOut},asetpts=PTS-STARTPTS,` +
        `volume=${clip.volume},adelay=${delayMs}:all=1[${label}]`
    );
    audioLabels.push(label);
  };
  for (const clip of baseClips) addAudio(clip, outputStartOf(clip));
  for (const track of project.tracks) {
    if (track.kind !== 'audio') continue;
    for (const clip of [...track.clips].sort((a, b) => a.trackStart - b.trackStart)) {
      addAudio(clip, clip.trackStart);
    }
  }
  let audioLabel: string | null = null;
  if (audioLabels.length === 1) {
    audioLabel = audioLabels[0];
  } else if (audioLabels.length > 1) {
    filters.push(`${audioLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[aout]`);
    audioLabel = 'aout';
  }

  const args: string[] = ['-y'];
  for (const input of inputs) args.push('-i', input);
  args.push('-filter_complex', filters.join(';'));
  args.push('-map', `[${videoLabel}]`);
  if (audioLabel) args.push('-map', `[${audioLabel}]`);
  args.push('-c:v', settings.videoCodec, '-pix_fmt', 'yuv420p', '-r', String(settings.fps), '-b:v', `${settings.videoBitrateKbps}k`);
  if (audioLabel) args.push('-c:a', settings.audioCodec, '-b:a', '160k');
  args.push(outputPath);

  if (options.journalDir) {
    await writeJournal(options.journalDir, 'exporting', `ffmpeg export to ${path.basename(outputPath)} started`);
  }
  const { code, log } = await runFfmpeg(ffmpeg, args, options.timeoutMs ?? 600_000);
  if (code !== 0) {
    if (options.journalDir) await writeJournal(options.journalDir, 'export-failed', `ffmpeg exited ${code}`);
    return fail(`ffmpeg exited with code ${code}`, log);
  }
  if (!fs.existsSync(outputPath)) {
    if (options.journalDir) await writeJournal(options.journalDir, 'export-failed', 'ffmpeg exited 0 but produced no file');
    return fail('ffmpeg exited 0 but produced no output file', log);
  }

  // Validate the produced file with ffprobe before claiming success.
  try {
    const probe = await probeMedia(outputPath);
    const tolerance = Math.max(1.0, expectedDurationSec * 0.05);
    if (!probe.hasVideo) throw new Error('output has no video stream');
    if (Math.abs(probe.durationSec - expectedDurationSec) > tolerance) {
      throw new Error(`output duration ${probe.durationSec.toFixed(2)}s differs from expected ${expectedDurationSec.toFixed(2)}s`);
    }
    if (probe.width !== settings.width || probe.height !== settings.height) {
      throw new Error(`output dimensions ${probe.width}x${probe.height} != requested ${settings.width}x${settings.height}`);
    }
    if (audioLabels.length > 0 && !probe.hasAudio) throw new Error('output is missing the expected audio stream');
    if (options.journalDir) await writeJournal(options.journalDir, 'exported', `validated ${path.basename(outputPath)}`);
    return {
      status: 'success',
      outputPath,
      outputBytes: fs.statSync(outputPath).size,
      durationSec: probe.durationSec,
      expectedDurationSec,
      ffmpegLogTail: log.slice(-1500),
      probe: {
        durationSec: probe.durationSec,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        hasVideo: probe.hasVideo,
        hasAudio: probe.hasAudio
      }
    };
  } catch (e: any) {
    if (options.journalDir) await writeJournal(options.journalDir, 'export-failed', `validation failed: ${e.message}`);
    return fail(`Export validation failed: ${e.message}`, log);
  }
}
