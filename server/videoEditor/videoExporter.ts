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
import { firstVerifiedHardwareEncoder, verifyEncoder } from './hwAccel.js';

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

import {
  LEGACY_EFFECT_FILTERS,
  buildTimeExpression,
  effectChainFor,
  hasKeyframedProperty,
  sampleKeyframes,
  sortedKeyframes,
  xfadeName
} from './effects.js';

/** Kept as a re-export: the registry lives in effects.ts (Phase 28). */
export const EFFECT_FILTERS: Record<string, string> = LEGACY_EFFECT_FILTERS;

export function findFontFile(): string | null {
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

export function escapeDrawtext(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/%/g, '\\%');
}

/**
 * Phase 26: rotate filter with an EXACT bounding box computed in JS.
 * (ffmpeg's hypot(iw,ih) cannot be used here — the comma inside the
 * expression is a filtergraph separator.) When the source dimensions
 * are unknown the filter keeps the input frame size and corners crop.
 */
export function rotateFilter(rotationDeg: number, media: MediaAsset): string {
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

export interface RunFfmpegOptions {
  /** Phase 30: called with ffmpeg's reported elapsed output seconds. */
  onProgress?: (elapsedSec: number) => void;
  /** Phase 30: aborting kills the process and resolves as cancelled. */
  signal?: AbortSignal;
}

const TIME_RE = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/;
const LOG_CAP = 512 * 1024;

export function runFfmpeg(
  ffmpeg: string,
  args: string[],
  timeoutMs: number,
  options: RunFfmpegOptions = {}
): Promise<{ code: number; log: string; cancelled?: boolean }> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ code: -2, log: 'cancelled before start', cancelled: true });
      return;
    }
    // With stderr piped (not a TTY), ffmpeg suppresses its periodic
    // stats lines — only the final summary appears. The documented
    // machine-readable channel is `-progress pipe:1`, which emits
    // out_time_us blocks on stdout throughout the render.
    const effectiveArgs = options.onProgress ? ['-progress', 'pipe:1', ...args] : args;
    const child = spawn(ffmpeg, effectiveArgs, { shell: false });
    let log = '';
    let rolling = '';
    let lastProgress = -1;
    let cancelled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const onAbort = (): void => {
      cancelled = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1500).unref?.();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const reportElapsed = (elapsed: number): void => {
      if (elapsed > lastProgress) {
        lastProgress = elapsed;
        options.onProgress?.(elapsed);
      }
    };
    const consume = (d: Buffer, isStdout: boolean): void => {
      const text = d.toString();
      log += text;
      // The log is evidence, not storage: keep a bounded tail so a
      // multi-hour render cannot grow memory without limit.
      if (log.length > LOG_CAP) log = log.slice(-LOG_CAP / 2);
      if (!options.onProgress) return;
      if (isStdout) {
        // -progress blocks: out_time_us=<microseconds> per block.
        rolling = (rolling + text).slice(-4096);
        for (const m of rolling.matchAll(/out_time_(?:us|ms)=(\d+)/g)) {
          reportElapsed(Number(m[1]) / 1_000_000);
        }
      } else {
        // Fallback: the stderr stats/summary time= token.
        rolling = (rolling + text).slice(-4096);
        for (const m of rolling.matchAll(new RegExp(TIME_RE.source, 'g'))) {
          reportElapsed(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
        }
      }
    };
    child.stderr?.on('data', (d) => consume(d, false));
    child.stdout?.on('data', (d) => consume(d, true));
    child.on('error', (err) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ code: -1, log: log + String(err), cancelled });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ code: cancelled ? -2 : code ?? -1, log, cancelled });
    });
  });
}

/**
 * Phase 27: the spatial transform chain for one clip (crop → effect →
 * scale → rgba → rotate → opacity → SAR), shared verbatim between the
 * stream exporter below and the single-frame preview renderer in
 * playback.ts — preview and export can never drift apart.
 */
export function overlayTransformChain(clip: TimelineClip, media: MediaAsset): string[] {
  const t = clip.transform ?? { x: 0, y: 0, scale: 1, rotationDeg: 0, opacity: 1 };
  return [
    ...(t.crop
      ? [`crop=w=iw-${t.crop.left + t.crop.right}:h=ih-${t.crop.top + t.crop.bottom}:x=${t.crop.left}:y=${t.crop.top}`]
      : []),
    ...effectChainFor(clip),
    ...(t.scale !== 1 ? [`scale=iw*${t.scale}:ih*${t.scale}`] : []),
    'format=rgba',
    ...(t.rotationDeg !== 0 ? [rotateFilter(t.rotationDeg, media)] : []),
    ...(t.opacity !== 1 ? [`colorchannelmixer=aa=${t.opacity}`] : []),
    'setsar=1'
  ];
}

/** atempo only accepts 0.5..2 per instance on older ffmpeg; chain factors. */
export function atempoChain(speed: number): string {
  if (speed === 1) return '';
  const parts: string[] = [];
  let remaining = speed;
  while (remaining > 2) { parts.push('atempo=2'); remaining /= 2; }
  while (remaining < 0.5) { parts.push('atempo=0.5'); remaining /= 0.5; }
  parts.push(`atempo=${remaining.toFixed(4)}`);
  return parts.join(',');
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
  options: {
    journalDir?: string;
    timeoutMs?: number;
    /** Phase 30: render progress as a 0..1 fraction of the expected duration. */
    onProgress?: (fraction: number, elapsedSec: number) => void;
    /** Phase 30: aborting cancels the render; the partial file is removed. */
    signal?: AbortSignal;
  } = {}
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
    const chain = effectChainFor(clip);
    const effect = chain.length > 0 ? `,${chain.join(',')}` : '';
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
    const junction = project.transitions.find((t) => t.afterClipId === junctionClip.id);
    const outLabel = `vx${gi}`;
    filters.push(`[${videoLabel}][${groupLabels[gi]}]xfade=transition=${xfadeName(junction?.type)}:duration=${d}:offset=${(accDuration - d).toFixed(3)}[${outLabel}]`);
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
  /** Emit one overlay pass: a prepared stream composited over the current canvas. */
  const emitPass = (idx: number, chain: string[], x: string, y: string, windowStart: number, windowEnd: number): void => {
    const srcLabel = `ovl${overlayCount}`;
    filters.push(`[${idx}:v]${chain.join(',')}[${srcLabel}]`);
    const outLabel = `vc${overlayCount}`;
    filters.push(
      `[${videoLabel}][${srcLabel}]overlay=x=${x}:y=${y}:eof_action=pass:enable='between(t,${windowStart.toFixed(3)},${windowEnd.toFixed(3)})'[${outLabel}]`
    );
    videoLabel = outLabel;
    overlayCount++;
  };
  for (const track of overlayTracks) {
    for (const clip of [...track.clips].sort((a, b) => a.trackStart - b.trackStart)) {
      const media = mediaAssets.get(clip.mediaId)!;
      if (!media.hasVideo) continue;
      const idx = inputForClip(clip);
      const t = clip.transform ?? { x: 0, y: 0, scale: 1, rotationDeg: 0, opacity: 1 };
      const speed = clipSpeed(clip);
      const kfs = clip.keyframes ?? [];
      const end = clip.trackStart + clipDuration(clip);
      if (kfs.length === 0) {
        emitPass(
          idx,
          [
            `trim=start=${clip.sourceIn}:end=${clip.sourceOut}`,
            'setpts=PTS-STARTPTS',
            ...(speed !== 1 ? [`setpts=PTS/${speed}`] : []),
            ...overlayTransformChain(clip, media),
            `setpts=PTS+${clip.trackStart.toFixed(3)}/TB`
          ],
          String(Math.round(t.x)),
          String(Math.round(t.y)),
          clip.trackStart,
          end
        );
        continue;
      }
      // Phase 28: keyframed clip. Position compiles into the overlay
      // filter over OUTPUT time; rotation/opacity compile into stream
      // expressions — all implementing sampleKeyframes' interpolation.
      // SCALE is the exception: ffmpeg's scale filter negotiates its
      // output size once and cannot resize mid-stream (verified), so
      // scale keyframes render as per-segment steps — the clip is
      // split at keyframe times (each interval subdivided into steps
      // of at most ~0.75s) and each segment is scaled statically to
      // the value sampled at its midpoint. All other properties stay
      // exact within every segment.
      const overlayX = hasKeyframedProperty(kfs, 'x') ? `'${buildTimeExpression(kfs, 'x', t.x, clip.trackStart)}'` : String(Math.round(t.x));
      const overlayY = hasKeyframedProperty(kfs, 'y') ? `'${buildTimeExpression(kfs, 'y', t.y, clip.trackStart)}'` : String(Math.round(t.y));
      const dur = clipDuration(clip);
      const boundaries = new Set<number>([0, dur]);
      if (hasKeyframedProperty(kfs, 'scale')) {
        for (const kf of sortedKeyframes(kfs)) if (kf.scale !== undefined) boundaries.add(Math.min(Math.max(kf.timeSec, 0), dur));
      }
      const sortedBounds = [...boundaries].sort((a, b) => a - b);
      const scaleKeyframed = hasKeyframedProperty(kfs, 'scale');
      const segments: { a: number; b: number }[] = [];
      for (let i = 0; i < sortedBounds.length - 1; i++) {
        const a = sortedBounds[i];
        const b = sortedBounds[i + 1];
        // Only scale needs steps; other properties are exact expressions.
        const steps = scaleKeyframed ? Math.min(4, Math.max(1, Math.ceil((b - a) / 0.75))) : 1;
        for (let s = 0; s < steps; s++) {
          segments.push({ a: a + ((b - a) * s) / steps, b: a + ((b - a) * (s + 1)) / steps });
        }
      }
      if (segments.length > 32) {
        notes.push(`Clip ${clip.id}: scale animation used ${segments.length} segments.`);
      }
      // Union rotation canvas for the whole clip (centre-anchored).
      let rotationBbox = '';
      if (media.width && media.height && (hasKeyframedProperty(kfs, 'rotationDeg') || t.rotationDeg !== 0)) {
        const angles = [t.rotationDeg, ...kfs.map((k) => k.rotationDeg).filter((v): v is number => v !== undefined)];
        const scales = [t.scale, ...kfs.map((k) => k.scale).filter((v): v is number => v !== undefined)];
        const maxScale = Math.max(...scales);
        let ow = 0;
        let oh = 0;
        for (const deg of angles) {
          const rad = (deg * Math.PI) / 180;
          ow = Math.max(ow, Math.ceil(maxScale * (media.width * Math.abs(Math.cos(rad)) + media.height * Math.abs(Math.sin(rad)))));
          oh = Math.max(oh, Math.ceil(maxScale * (media.width * Math.abs(Math.sin(rad)) + media.height * Math.abs(Math.cos(rad)))));
        }
        rotationBbox = `:ow=${ow}:oh=${oh}`;
      }
      for (const seg of segments) {
        const segIdx = inputForClip(clip);
        const mid = (seg.a + seg.b) / 2;
        const segScale = sampleKeyframes(kfs, t, mid).scale;
        const chain: string[] = [
          `trim=start=${(clip.sourceIn + seg.a * speed).toFixed(3)}:end=${(clip.sourceIn + seg.b * speed).toFixed(3)}`,
          'setpts=PTS-STARTPTS',
          ...(speed !== 1 ? [`setpts=PTS/${speed}`] : []),
          ...(t.crop
            ? [`crop=w=iw-${t.crop.left + t.crop.right}:h=ih-${t.crop.top + t.crop.bottom}:x=${t.crop.left}:y=${t.crop.top}`]
            : []),
          ...effectChainFor(clip)
        ];
        if (segScale !== 1) chain.push(`scale=iw*${segScale}:ih*${segScale}`);
        chain.push('format=rgba');
        if (hasKeyframedProperty(kfs, 'rotationDeg')) {
          // Stream t is segment-local here: shift keyframe times by -seg.a.
          const degExpr = buildTimeExpression(kfs, 'rotationDeg', t.rotationDeg, -seg.a);
          chain.push(`rotate=a='((${degExpr})*PI/180)'${rotationBbox}:c=none`);
        } else if (t.rotationDeg !== 0) {
          chain.push(rotateFilter(t.rotationDeg, media));
        }
        if (hasKeyframedProperty(kfs, 'opacity')) {
          // NOTE: geq names the timestamp constant T, not t.
          const expr = buildTimeExpression(kfs, 'opacity', t.opacity, -seg.a, 'T');
          chain.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${expr})'`);
        } else if (t.opacity !== 1) {
          chain.push(`colorchannelmixer=aa=${t.opacity}`);
        }
        chain.push('setsar=1', `setpts=PTS+${(clip.trackStart + seg.a).toFixed(3)}/TB`);
        emitPass(segIdx, chain, overlayX, overlayY, clip.trackStart + seg.a, clip.trackStart + seg.b);
      }
      notes.push(
        `Clip ${clip.id}: rendered with ${kfs.length} keyframe(s) in ${segments.length} segment(s)` +
          (hasKeyframedProperty(kfs, 'scale') ? ' (scale animates in per-segment steps; other properties are exact).' : ' (animated transform).')
      );
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
      // Phase 28: text position keyframes compile to drawtext time
      // expressions over output time (drawtext evaluates per frame).
      const kfs = el.keyframes ?? [];
      const xExpr = hasKeyframedProperty(kfs, 'x') ? `'${buildTimeExpression(kfs, 'x', el.x, el.trackStart)}'` : String(Math.round(el.x));
      const yExpr = hasKeyframedProperty(kfs, 'y') ? `'${buildTimeExpression(kfs, 'y', el.y, el.trackStart)}'` : String(Math.round(el.y));
      filters.push(
        `[${videoLabel}]drawtext=fontfile='${fontEscaped}':text='${escapeDrawtext(el.text)}':fontsize=${Math.round(el.fontSize)}:` +
          `fontcolor=${color}${alpha}:borderw=2:box=1:boxcolor=black@0.35:boxborderw=6:x=${xExpr}:y=${yExpr}:` +
          `enable='between(t,${el.trackStart.toFixed(3)},${(el.trackStart + el.durationSec).toFixed(3)})'[${outLabel}]`
      );
      videoLabel = outLabel;
    }
    notes.push(`Rendered ${textElements.length} text element(s).`);
  }

  // Phase 29: caption burn-in (drawtext per cue, bottom-centre),
  // above text elements. Disable with settings.burnInCaptions=false.
  const captionCues = (project.captions ?? []).filter((c) => c.text && c.text.trim());
  if (captionCues.length > 0 && settings.burnInCaptions !== false) {
    const font = findFontFile();
    if (!font) return fail('Captions are present but no usable font file was found on this host for drawtext.');
    const fontEscaped = font.replace(/\\/g, '/').replace(/:/g, '\\:');
    for (const cue of captionCues) {
      const outLabel = `vcap${videoLabel}`;
      filters.push(
        `[${videoLabel}]drawtext=fontfile='${fontEscaped}':text='${escapeDrawtext(cue.text)}':fontsize=28:` +
          `fontcolor=white:borderw=2:box=1:boxcolor=black@0.55:boxborderw=8:x=(w-text_w)/2:y=h-52:` +
          `enable='between(t,${cue.startSec.toFixed(3)},${cue.endSec.toFixed(3)})'[${outLabel}]`
      );
      videoLabel = outLabel;
    }
    notes.push(`Burned in ${captionCues.length} caption cue(s).`);
  }

  // Audio: base-clip audio + overlay-clip audio + audio-track clips,
  // each placed on the output timeline. Phase 26: speed uses atempo.
  // Phase 29: per-track gain and mute, per-clip fade-in/fade-out.
  const audioLabels: string[] = [];
  let audioCount = 0;
  const addAudio = (clip: TimelineClip, atSec: number, track?: { volume?: number; muted?: boolean }) => {
    const media = mediaAssets.get(clip.mediaId)!;
    if (!media.hasAudio) return;
    if (track?.muted) return;
    const idx = useMedia(clip.mediaId);
    const label = `a${audioCount++}`;
    const delayMs = Math.max(0, Math.round(atSec * 1000));
    const tempo = atempoChain(clipSpeed(clip));
    const effectiveVolume = Math.min(2, Math.max(0, clip.volume * (track?.volume ?? 1)));
    const dur = clipDuration(clip);
    const fades: string[] = [];
    if (clip.fadeInSec && clip.fadeInSec > 0) fades.push(`afade=t=in:st=0:d=${clip.fadeInSec.toFixed(3)}`);
    if (clip.fadeOutSec && clip.fadeOutSec > 0) {
      fades.push(`afade=t=out:st=${Math.max(0, dur - clip.fadeOutSec).toFixed(3)}:d=${clip.fadeOutSec.toFixed(3)}`);
    }
    filters.push(
      `[${idx}:a]atrim=start=${clip.sourceIn}:end=${clip.sourceOut},asetpts=PTS-STARTPTS,` +
        `${tempo ? `${tempo},` : ''}${fades.length > 0 ? `${fades.join(',')},` : ''}volume=${effectiveVolume.toFixed(3)},adelay=${delayMs}:all=1[${label}]`
    );
    audioLabels.push(label);
  };
  for (const clip of baseClips) addAudio(clip, outputStartOf(clip), base);
  for (const track of overlayTracks) {
    for (const clip of [...track.clips].sort((a, b) => a.trackStart - b.trackStart)) {
      addAudio(clip, clip.trackStart, track);
    }
  }
  for (const track of project.tracks) {
    if (track.kind !== 'audio') continue;
    for (const clip of [...track.clips].sort((a, b) => a.trackStart - b.trackStart)) {
      addAudio(clip, clip.trackStart, track);
    }
  }
  let audioLabel: string | null = null;
  if (audioLabels.length === 1) {
    audioLabel = audioLabels[0];
  } else if (audioLabels.length > 1) {
    filters.push(`${audioLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[aout]`);
    audioLabel = 'aout';
  }

  const buildArgs = (codec: string): string[] => {
    const a: string[] = ['-y'];
    for (const input of inputs) a.push(...input.preArgs, '-i', input.path);
    a.push('-filter_complex', filters.join(';'));
    a.push('-map', `[${videoLabel}]`);
    if (audioLabel) a.push('-map', `[${audioLabel}]`);
    a.push('-c:v', codec, '-pix_fmt', 'yuv420p', '-r', String(settings.fps), '-b:v', `${settings.videoBitrateKbps}k`);
    if (audioLabel) a.push('-c:a', settings.audioCodec, '-b:a', `${settings.audioBitrateKbps ?? 160}k`);
    a.push(outputPath);
    return a;
  };

  // Phase 30: resolve the encoder honestly. 'software' is libx264;
  // 'auto' picks the first probe-verified hardware encoder; a specific
  // name is used only if it verifies. Anything else falls back to
  // software with a note — never a silent or fake "GPU render".
  let encoderUsed = 'libx264';
  const preference = settings.encoderPreference ?? 'software';
  if (preference === 'auto') {
    const hw = await firstVerifiedHardwareEncoder(ffmpeg);
    if (hw) {
      encoderUsed = hw;
      notes.push(`Hardware encoder ${hw} selected (verified by a real encode probe).`);
    } else {
      notes.push('No verified hardware encoder available on this host; rendered with software libx264.');
    }
  } else if (preference !== 'software' && preference !== 'libx264') {
    if (await verifyEncoder(ffmpeg, preference)) {
      encoderUsed = preference;
      notes.push(`Hardware encoder ${preference} selected (verified by a real encode probe).`);
    } else {
      notes.push(`Requested encoder ${preference} is not available on this host; fell back to software libx264.`);
    }
  }

  if (options.journalDir) {
    await writeJournal(options.journalDir, 'exporting', `ffmpeg export to ${path.basename(outputPath)} started`);
  }
  const runOptions: RunFfmpegOptions = {
    signal: options.signal,
    onProgress: options.onProgress
      ? (elapsedSec) => options.onProgress!(expectedDurationSec > 0 ? Math.min(1, elapsedSec / expectedDurationSec) : 0, elapsedSec)
      : undefined
  };
  let attempt = await runFfmpeg(ffmpeg, buildArgs(encoderUsed), options.timeoutMs ?? 600_000, runOptions);
  if (attempt.cancelled) {
    fs.rmSync(outputPath, { force: true });
    if (options.journalDir) await writeJournal(options.journalDir, 'export-cancelled', 'render cancelled by request; partial output removed');
    return {
      status: 'cancelled',
      expectedDurationSec,
      ffmpegLogTail: attempt.log.slice(-1500),
      error: 'Export cancelled; the partial output file was removed.',
      notes,
      encoderUsed
    };
  }
  if (attempt.code !== 0 && encoderUsed !== 'libx264') {
    // A verified encoder can still fail on a real graph (driver,
    // format negotiation). Fall back to software once, honestly.
    notes.push(`Hardware encoder ${encoderUsed} failed on this render (exit ${attempt.code}); retried with software libx264.`);
    encoderUsed = 'libx264';
    attempt = await runFfmpeg(ffmpeg, buildArgs(encoderUsed), options.timeoutMs ?? 600_000, runOptions);
    if (attempt.cancelled) {
      fs.rmSync(outputPath, { force: true });
      if (options.journalDir) await writeJournal(options.journalDir, 'export-cancelled', 'render cancelled by request; partial output removed');
      return {
        status: 'cancelled',
        expectedDurationSec,
        ffmpegLogTail: attempt.log.slice(-1500),
        error: 'Export cancelled; the partial output file was removed.',
        notes,
        encoderUsed
      };
    }
  }
  const { code, log } = attempt;
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
      encoderUsed,
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
