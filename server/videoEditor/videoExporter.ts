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
import { mediaKind } from './types.js';
import { baseVideoTrack, clipDuration, clipSpeed, timelineDuration, validateProject, writeJournal } from './timeline.js';
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

/**
 * Phase 26: rotate filter with an EXACT bounding box computed in JS.
 * (ffmpeg's hypot(iw,ih) cannot be used here — the comma inside the
 * expression is a filtergraph separator.) When the source dimensions
 * are unknown the filter keeps the input frame size and corners crop.
 */
function rotateFilter(rotationDeg: number, media: MediaAsset): string {
  const rad = (rotationDeg * Math.PI) / 180;
  if (media.width && media.height) {
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const ow = Math.ceil(media.width * cos + media.height * sin);
    const oh = Math.ceil(media.width * sin + media.height * cos);
    return `rotate=${rad.toFixed(6)}:ow=${ow}:oh=${oh}:c=none`;
  }
  return `rotate=${rad.toFixed(6)}:c=none`;
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
  const notes: string[] = [];
  const fail = async (error: string, logTail: string = ''): Promise<ExportResult> => {
    if (options.journalDir) {
      await writeJournal(options.journalDir, 'export-failed', error).catch(() => undefined);
    }
    return {
      status: 'failed',
      expectedDurationSec,
      ffmpegLogTail: logTail.slice(-1500),
      error,
      notes
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

  // Unique inputs in first-use order. Phase 26: inputs carry optional
  // pre-input args — still images get a dedicated looped input per clip
  // so trim/speed semantics match video clips.
  const inputIndex = new Map<string, number>();
  const inputs: { path: string; preArgs: string[] }[] = [];
  const useMedia = (mediaId: string): number => {
    if (!inputIndex.has(mediaId)) {
      inputIndex.set(mediaId, inputs.length);
      inputs.push({ path: mediaAssets.get(mediaId)!.path, preArgs: [] });
    }
    return inputIndex.get(mediaId)!;
  };
  const useLoopedImage = (mediaId: string, loopSeconds: number): number => {
    inputs.push({ path: mediaAssets.get(mediaId)!.path, preArgs: ['-loop', '1', '-t', loopSeconds.toFixed(3)] });
    return inputs.length - 1;
  };
  const inputForClip = (clip: TimelineClip): number => {
    const media = mediaAssets.get(clip.mediaId)!;
    return mediaKind(media) === 'image' ? useLoopedImage(clip.mediaId, Math.max(clip.sourceOut, 0.1)) : useMedia(clip.mediaId);
  };
  /** atempo only accepts 0.5..2 per instance on older ffmpeg; chain factors. */
  const atempoChain = (speed: number): string => {
    if (speed === 1) return '';
    const parts: string[] = [];
    let remaining = speed;
    while (remaining > 2) { parts.push('atempo=2'); remaining /= 2; }
    while (remaining < 0.5) { parts.push('atempo=0.5'); remaining /= 0.5; }
    parts.push(`atempo=${remaining.toFixed(4)}`);
    return parts.join(',');
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
    const idx = inputForClip(clip);
    const label = `vseg${segCount++}`;
    const effect = clip.effect !== 'none' ? `,${EFFECT_FILTERS[clip.effect]}` : '';
    // Phase 26: crop (source edges) applies on the base track too; speed via setpts.
    const crop = clip.transform?.crop
      ? `crop=w=iw-${clip.transform.crop.left + clip.transform.crop.right}:h=ih-${clip.transform.crop.top + clip.transform.crop.bottom}:x=${clip.transform.crop.left}:y=${clip.transform.crop.top},`
      : '';
    const speed = clipSpeed(clip);
    const speedFilter = speed !== 1 ? `,setpts=PTS/${speed}` : '';
    if (clip.transform && (clip.transform.x !== 0 || clip.transform.y !== 0 || clip.transform.rotationDeg !== 0 || clip.transform.opacity !== 1 || clip.transform.scale !== 1)) {
      notes.push(`Base clip ${clip.id}: position/scale/rotation/opacity are overlay-track properties and were not applied to the base canvas (crop and speed were).`);
    }
    filters.push(
      `[${idx}:v]trim=start=${clip.sourceIn}:end=${clip.sourceOut},setpts=PTS-STARTPTS${speedFilter},` +
        `${crop}scale=${settings.width}:${settings.height}:force_original_aspect_ratio=decrease,` +
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

  // Phase 26: if overlays or texts extend past the base track's end,
  // extend the canvas with black frames so they have something to
  // composite onto (the expected duration already accounts for them).
  const padSeconds = expectedDurationSec - accDuration;
  if (padSeconds > 0.05) {
    const outLabel = `vpad`;
    filters.push(`[${videoLabel}]tpad=stop_mode=add:stop_duration=${padSeconds.toFixed(3)},fps=${settings.fps}[${outLabel}]`);
    videoLabel = outLabel;
    notes.push(`Canvas extended by ${padSeconds.toFixed(2)}s of black so overlays/texts past the base track remain visible.`);
  }

  // Phase 26: overlay tracks (every video track after the base) are
  // composited in project order — later tracks sit on top. Each clip
  // is trimmed, speed-adjusted, cropped, effected, scaled, rotated,
  // faded by its opacity, timestamp-shifted to its timeline position,
  // and overlaid only during its window.
  const overlayTracks = project.tracks.filter((t) => t.kind === 'video' && t.id !== base.id);
  let overlayCount = 0;
  for (const track of overlayTracks) {
    for (const clip of [...track.clips].sort((a, b) => a.trackStart - b.trackStart)) {
      const media = mediaAssets.get(clip.mediaId)!;
      if (!media.hasVideo) continue;
      const idx = inputForClip(clip);
      const t = clip.transform ?? { x: 0, y: 0, scale: 1, rotationDeg: 0, opacity: 1 };
      const speed = clipSpeed(clip);
      const chain: string[] = [
        `trim=start=${clip.sourceIn}:end=${clip.sourceOut}`,
        'setpts=PTS-STARTPTS',
        ...(speed !== 1 ? [`setpts=PTS/${speed}`] : []),
        ...(t.crop
          ? [`crop=w=iw-${t.crop.left + t.crop.right}:h=ih-${t.crop.top + t.crop.bottom}:x=${t.crop.left}:y=${t.crop.top}`]
          : []),
        ...(clip.effect !== 'none' ? [EFFECT_FILTERS[clip.effect]] : []),
        ...(t.scale !== 1 ? [`scale=iw*${t.scale}:ih*${t.scale}`] : []),
        'format=rgba',
        ...(t.rotationDeg !== 0 ? [rotateFilter(t.rotationDeg, media)] : []),
        ...(t.opacity !== 1 ? [`colorchannelmixer=aa=${t.opacity}`] : []),
        'setsar=1',
        `setpts=PTS+${clip.trackStart.toFixed(3)}/TB`
      ];
      const srcLabel = `ovl${overlayCount}`;
      filters.push(`[${idx}:v]${chain.join(',')}[${srcLabel}]`);
      const outLabel = `vc${overlayCount}`;
      const end = clip.trackStart + clipDuration(clip);
      filters.push(
        `[${videoLabel}][${srcLabel}]overlay=x=${Math.round(t.x)}:y=${Math.round(t.y)}:eof_action=pass:enable='between(t,${clip.trackStart.toFixed(3)},${end.toFixed(3)})'[${outLabel}]`
      );
      videoLabel = outLabel;
      overlayCount++;
    }
  }
  if (overlayCount > 0) notes.push(`Composited ${overlayCount} overlay clip(s) from ${overlayTracks.length} overlay track(s).`);

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

  // Phase 26: text layer elements (drawtext), in layer order.
  const textElements = (project.texts ?? []).filter((t) => t.text && t.text.trim());
  if (textElements.length > 0) {
    const font = findFontFile();
    if (!font) return fail('Text elements are present but no usable font file was found on this host for drawtext.');
    const fontEscaped = font.replace(/\\/g, '/').replace(/:/g, '\\:');
    for (const el of textElements) {
      const outLabel = `vtx${videoLabel}`;
      const hex = el.color.replace('#', '');
      const color = `0x${hex}`;
      const alpha = el.opacity !== undefined && el.opacity < 1 ? `@${el.opacity}` : '';
      filters.push(
        `[${videoLabel}]drawtext=fontfile='${fontEscaped}':text='${escapeDrawtext(el.text)}':fontsize=${Math.round(el.fontSize)}:` +
          `fontcolor=${color}${alpha}:borderw=2:box=1:boxcolor=black@0.35:boxborderw=6:x=${Math.round(el.x)}:y=${Math.round(el.y)}:` +
          `enable='between(t,${el.trackStart.toFixed(3)},${(el.trackStart + el.durationSec).toFixed(3)})'[${outLabel}]`
      );
      videoLabel = outLabel;
    }
    notes.push(`Rendered ${textElements.length} text element(s).`);
  }

  // Audio: base-clip audio + overlay-clip audio + audio-track clips,
  // each placed on the output timeline. Phase 26: speed uses atempo.
  const audioLabels: string[] = [];
  let audioCount = 0;
  const addAudio = (clip: TimelineClip, atSec: number) => {
    const media = mediaAssets.get(clip.mediaId)!;
    if (!media.hasAudio) return;
    const idx = useMedia(clip.mediaId);
    const label = `a${audioCount++}`;
    const delayMs = Math.max(0, Math.round(atSec * 1000));
    const tempo = atempoChain(clipSpeed(clip));
    filters.push(
      `[${idx}:a]atrim=start=${clip.sourceIn}:end=${clip.sourceOut},asetpts=PTS-STARTPTS,` +
        `${tempo ? `${tempo},` : ''}volume=${clip.volume},adelay=${delayMs}:all=1[${label}]`
    );
    audioLabels.push(label);
  };
  for (const clip of baseClips) addAudio(clip, outputStartOf(clip));
  for (const track of overlayTracks) {
    for (const clip of [...track.clips].sort((a, b) => a.trackStart - b.trackStart)) {
      addAudio(clip, clip.trackStart);
    }
  }
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
  for (const input of inputs) args.push(...input.preArgs, '-i', input.path);
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
      notes,
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
