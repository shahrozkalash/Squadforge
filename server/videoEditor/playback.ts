import * as fs from 'fs';
import * as path from 'path';
import type { MediaAsset, TimelineClip, VideoProject } from './types.js';
import { mediaKind } from './types.js';
import {
  baseVideoTrack,
  clipDuration,
  clipSpeed,
  timelineDuration,
  validateProject
} from './timeline.js';
import {
  EFFECT_FILTERS,
  escapeDrawtext,
  findFontFile,
  overlayTransformChain,
  runFfmpeg
} from './videoExporter.js';
import { detectFfmpeg } from './mediaProbe.js';

/**
 * Phase 27: real-time timeline and playback engine.
 *
 * Playback is a single-clock state machine: the playhead position is
 * derived from one monotonic anchor, so the video position and the
 * audio position are the same number by construction (zero drift).
 * Seeking is frame-accurate — every position is quantized to the
 * project frame grid.
 *
 * Preview frames are REAL decoded frames: for the requested instant
 * the engine resolves which clips are active, seeks each source with
 * input-side `-ss` (streaming decode — whole files are never loaded
 * into memory), and composites exactly one frame through the same
 * transform chain the exporter uses (overlayTransformChain). Missing
 * or corrupted media produces an explicit error result, never a
 * placeholder frame.
 */

// ---------------------------------------------------------------- frame grid

export function frameIndexForTime(timeSec: number, fps: number): number {
  return Math.max(0, Math.round(timeSec * fps));
}

export function timeForFrame(frameIndex: number, fps: number): number {
  return frameIndex / fps;
}

export function frameCountForDuration(durationSec: number, fps: number): number {
  return Math.max(1, Math.round(durationSec * fps));
}

/** Snap a time to the nearest frame boundary of the project grid. */
export function quantizeToFrame(timeSec: number, fps: number): number {
  return timeForFrame(frameIndexForTime(timeSec, fps), fps);
}

// ---------------------------------------------------------------- resolution

export interface ActiveClip {
  trackId: string;
  trackKind: 'video' | 'audio';
  clip: TimelineClip;
  /** Source-media time (seconds) corresponding to the playhead. */
  sourceTimeSec: number;
  /** For the base track during a crossfade: the incoming clip and 0..1 progress. */
  role: 'base' | 'overlay' | 'audio' | 'transition-in';
  transitionProgress?: number;
}

export interface ResolveOptions {
  hiddenTrackIds?: ReadonlySet<string>;
}

/** Output-timeline start of each base clip (trackStart minus preceding crossfades). */
export function baseOutputStarts(project: VideoProject): Map<string, number> {
  const base = baseVideoTrack(project);
  const clips = [...base.clips].sort((a, b) => a.trackStart - b.trackStart);
  const transitionAfter = new Map(project.transitions.map((t) => [t.afterClipId, t.durationSec]));
  const starts = new Map<string, number>();
  let shift = 0;
  for (const clip of clips) {
    starts.set(clip.id, clip.trackStart - shift);
    shift += transitionAfter.get(clip.id) || 0;
  }
  return starts;
}

/**
 * Resolve every clip active at an OUTPUT-timeline instant, with the
 * exact source time each clip contributes. This is the single source
 * of truth used by the session, the preview renderer, and (for A/V
 * sync) the audio position — what you preview is what plays.
 */
export function resolveAtTime(
  project: VideoProject,
  timeSec: number,
  options: ResolveOptions = {}
): ActiveClip[] {
  const hidden = options.hiddenTrackIds ?? new Set<string>();
  const base = baseVideoTrack(project);
  const starts = baseOutputStarts(project);
  const transitionAfter = new Map(project.transitions.map((t) => [t.afterClipId, t.durationSec]));
  const active: ActiveClip[] = [];

  for (const track of project.tracks) {
    if (hidden.has(track.id)) continue;
    const isBase = track.id === base.id;
    for (const clip of track.clips) {
      const start = isBase ? starts.get(clip.id)! : clip.trackStart;
      const end = start + clipDuration(clip);
      if (timeSec < start || timeSec >= end) continue;
      const sourceTimeSec = clip.sourceIn + (timeSec - start) * clipSpeed(clip);
      if (track.kind === 'audio') {
        active.push({ trackId: track.id, trackKind: 'audio', clip, sourceTimeSec, role: 'audio' });
      } else if (isBase) {
        // During a crossfade the OUTGOING clip is still the base; the
        // incoming clip (whose output window overlaps) is transition-in.
        const prevClip = [...base.clips]
          .sort((a, b) => a.trackStart - b.trackStart)
          .find((c) => transitionAfter.has(c.id) && starts.get(c.id)! + clipDuration(c) > timeSec && starts.get(c.id)! <= timeSec && c.id !== clip.id);
        if (prevClip && starts.get(prevClip.id)! + clipDuration(prevClip) > timeSec && start > starts.get(prevClip.id)!) {
          const d = transitionAfter.get(prevClip.id)!;
          const progress = Math.min(1, Math.max(0, (timeSec - start) / d));
          active.push({ trackId: track.id, trackKind: 'video', clip, sourceTimeSec, role: 'transition-in', transitionProgress: progress });
        } else {
          active.push({ trackId: track.id, trackKind: 'video', clip, sourceTimeSec, role: 'base' });
        }
      } else {
        active.push({ trackId: track.id, trackKind: 'video', clip, sourceTimeSec, role: 'overlay' });
      }
    }
  }
  return active;
}

// ---------------------------------------------------------------- view state

export class TimelineView {
  pxPerSecond = 80;
  scrollSec = 0;
  readonly hiddenTrackIds = new Set<string>();

  constructor(readonly durationSec: number) {}

  zoomIn(): void {
    this.pxPerSecond = Math.min(400, this.pxPerSecond * 1.5);
  }
  zoomOut(): void {
    this.pxPerSecond = Math.max(4, this.pxPerSecond / 1.5);
  }
  setScroll(sec: number): void {
    this.scrollSec = Math.min(Math.max(0, sec), Math.max(0, this.durationSec));
  }
  timeToX(timeSec: number): number {
    return (timeSec - this.scrollSec) * this.pxPerSecond;
  }
  xToTime(xPx: number): number {
    return this.scrollSec + xPx / this.pxPerSecond;
  }
  visibleRange(viewportWidthPx: number): { startSec: number; endSec: number } {
    return {
      startSec: this.scrollSec,
      endSec: Math.min(this.durationSec, this.scrollSec + viewportWidthPx / this.pxPerSecond)
    };
  }
  toggleTrack(trackId: string): boolean {
    if (this.hiddenTrackIds.has(trackId)) {
      this.hiddenTrackIds.delete(trackId);
      return true;
    }
    this.hiddenTrackIds.add(trackId);
    return false;
  }
  isTrackVisible(trackId: string): boolean {
    return !this.hiddenTrackIds.has(trackId);
  }
}

// ---------------------------------------------------------------- session

export type PlaybackState = 'idle' | 'playing' | 'paused' | 'stopped' | 'error';

export class PlaybackSession {
  private project: VideoProject | null = null;
  private mediaAssets: Map<string, MediaAsset> | null = null;
  private durationSec = 0;
  private state_: PlaybackState = 'idle';
  private error_: string | undefined;
  private anchorPosSec = 0;
  private anchorTimeMs = 0;
  private speed_ = 1;

  /** @param now injectable monotonic clock (ms) — tests drive it deterministically. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  get state(): PlaybackState {
    this.position(); // latch end-of-timeline transitions
    return this.state_;
  }
  get error(): string | undefined {
    return this.error_;
  }
  get speed(): number {
    return this.speed_;
  }
  get duration(): number {
    return this.durationSec;
  }

  load(project: VideoProject, mediaAssets: Map<string, MediaAsset>): boolean {
    const errors = validateProject(project, mediaAssets);
    if (errors.length > 0) {
      this.state_ = 'error';
      this.error_ = `Invalid project: ${errors.join('; ')}`;
      return false;
    }
    for (const asset of mediaAssets.values()) {
      if (!fs.existsSync(asset.path)) {
        this.state_ = 'error';
        this.error_ = `Media file missing: ${asset.path}`;
        return false;
      }
    }
    this.project = project;
    this.mediaAssets = mediaAssets;
    this.durationSec = timelineDuration(project);
    this.anchorPosSec = 0;
    this.speed_ = 1;
    this.error_ = undefined;
    this.state_ = 'idle';
    return true;
  }

  play(): void {
    if (this.state_ === 'error' || !this.project) return;
    if (this.state_ === 'stopped' && this.anchorPosSec >= this.durationSec) this.anchorPosSec = 0;
    this.anchorTimeMs = this.now();
    this.state_ = 'playing';
  }

  pause(): void {
    if (this.state_ !== 'playing') return;
    this.anchorPosSec = this.rawPosition();
    this.state_ = 'paused';
  }

  stop(): void {
    if (this.state_ === 'error') return;
    this.anchorPosSec = 0;
    this.state_ = 'stopped';
  }

  private rawPosition(): number {
    if (!this.project) return 0;
    if (this.state_ !== 'playing') return this.anchorPosSec;
    return this.anchorPosSec + ((this.now() - this.anchorTimeMs) / 1000) * this.speed_;
  }

  /** Current playhead position, frame-quantized. Latches 'stopped' at the end. */
  position(): number {
    if (!this.project) return 0;
    const raw = this.rawPosition();
    if (this.state_ === 'playing' && raw >= this.durationSec) {
      this.anchorPosSec = this.durationSec;
      this.state_ = 'stopped';
      return this.durationSec;
    }
    return quantizeToFrame(Math.min(Math.max(0, raw), this.durationSec), this.project.fps);
  }

  frameIndex(): number {
    if (!this.project) return 0;
    const frames = frameCountForDuration(this.durationSec, this.project.fps);
    return Math.min(frameIndexForTime(this.position(), this.project.fps), frames - 1);
  }

  /** Audio and video share this one clock — the drift is zero by construction. */
  audioPosition(): number {
    return this.position();
  }
  syncDriftMs(): number {
    return Math.abs(this.audioPosition() - this.position()) * 1000;
  }

  seekTo(timeSec: number): number {
    if (!this.project || this.state_ === 'error') return this.anchorPosSec;
    const fps = this.project.fps;
    const quantized = quantizeToFrame(Math.min(Math.max(0, timeSec), this.durationSec), fps);
    this.anchorPosSec = quantized;
    if (this.state_ === 'playing') this.anchorTimeMs = this.now();
    if (this.state_ === 'stopped' || this.state_ === 'idle') this.state_ = 'paused';
    return quantized;
  }

  seekToFrame(frameIndex: number): number {
    if (!this.project) return 0;
    const frames = frameCountForDuration(this.durationSec, this.project.fps);
    const clamped = Math.min(Math.max(0, Math.round(frameIndex)), frames - 1);
    return this.seekTo(timeForFrame(clamped, this.project.fps));
  }

  seekByFrames(delta: number): number {
    return this.seekToFrame(this.frameIndex() + delta);
  }

  setSpeed(speed: number): void {
    if (speed < 0.25 || speed > 4) throw new Error('playback speed must be between 0.25 and 4');
    if (this.state_ === 'playing') {
      this.anchorPosSec = this.rawPosition();
      this.anchorTimeMs = this.now();
    }
    this.speed_ = speed;
  }

  activeClips(options: ResolveOptions = {}): ActiveClip[] {
    if (!this.project) return [];
    return resolveAtTime(this.project, this.position(), options);
  }
}

// ---------------------------------------------------------------- preview frames

export interface PreviewSuccess {
  status: 'success';
  framePath: string;
  timeSec: number;
  frameIndex: number;
  width: number;
  height: number;
  activeClips: { trackId: string; clipId: string; role: string; sourceTimeSec: number }[];
}

export interface PreviewError {
  status: 'error';
  error: string;
  timeSec: number;
  ffmpegLogTail?: string;
}

export type PreviewResult = PreviewSuccess | PreviewError;

export interface PreviewOptions extends ResolveOptions {
  width?: number;
  height?: number;
  timeoutMs?: number;
}

/**
 * Build the exact ffmpeg argument list for one preview frame.
 * Exported so tests (and the UI) can verify the streaming design:
 * every video input is input-seeked with `-ss` BEFORE `-i`, so ffmpeg
 * decodes from the nearest keyframe instead of reading whole files.
 */
export function buildPreviewArgs(
  project: VideoProject,
  mediaAssets: Map<string, MediaAsset>,
  timeSec: number,
  outputPath: string,
  options: PreviewOptions = {}
): { args: string[]; active: ActiveClip[] } {
  const width = options.width ?? project.width;
  const height = options.height ?? project.height;
  const active = resolveAtTime(project, timeSec, options);
  const activeVideo = active.filter((a) => a.trackKind === 'video');
  const baseEntry = activeVideo.find((a) => a.role === 'base');
  const fadeEntry = activeVideo.find((a) => a.role === 'transition-in');
  const overlays = activeVideo.filter((a) => a.role === 'overlay');

  const inputs: { path: string; preArgs: string[] }[] = [];
  const filters: string[] = [];
  const inputFor = (entry: ActiveClip): number => {
    const media = mediaAssets.get(entry.clip.mediaId)!;
    if (mediaKind(media) === 'image') {
      inputs.push({ path: media.path, preArgs: [] });
    } else {
      inputs.push({ path: media.path, preArgs: ['-ss', entry.sourceTimeSec.toFixed(3)] });
    }
    return inputs.length - 1;
  };

  let videoLabel: string;
  if (baseEntry) {
    const media = mediaAssets.get(baseEntry.clip.mediaId)!;
    const idx = inputFor(baseEntry);
    const crop = baseEntry.clip.transform?.crop
      ? `crop=w=iw-${baseEntry.clip.transform.crop.left + baseEntry.clip.transform.crop.right}:h=ih-${baseEntry.clip.transform.crop.top + baseEntry.clip.transform.crop.bottom}:x=${baseEntry.clip.transform.crop.left}:y=${baseEntry.clip.transform.crop.top},`
      : '';
    const effect = baseEntry.clip.effect !== 'none' ? `,${EFFECT_FILTERS[baseEntry.clip.effect]}` : '';
    filters.push(
      `[${idx}:v]${crop}scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p${effect}[vbase]`
    );
    videoLabel = 'vbase';
  } else {
    // Genuine black canvas (a real generated stream, labelled as such
    // in the result's activeClips — never passed off as media).
    inputs.push({ path: `color=c=black:s=${width}x${height}:r=${project.fps}`, preArgs: ['-f', 'lavfi'] });
    filters.push(`[${inputs.length - 1}:v]format=yuv420p[vbase]`);
    videoLabel = 'vbase';
  }

  if (fadeEntry) {
    const media = mediaAssets.get(fadeEntry.clip.mediaId)!;
    const idx = inputFor(fadeEntry);
    const crop = fadeEntry.clip.transform?.crop
      ? `crop=w=iw-${fadeEntry.clip.transform.crop.left + fadeEntry.clip.transform.crop.right}:h=ih-${fadeEntry.clip.transform.crop.top + fadeEntry.clip.transform.crop.bottom}:x=${fadeEntry.clip.transform.crop.left}:y=${fadeEntry.clip.transform.crop.top},`
      : '';
    const effect = fadeEntry.clip.effect !== 'none' ? `,${EFFECT_FILTERS[fadeEntry.clip.effect]}` : '';
    const progress = (fadeEntry.transitionProgress ?? 0).toFixed(3);
    filters.push(
      `[${idx}:v]${crop}scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p${effect},format=rgba,colorchannelmixer=aa=${progress}[vfade]`
    );
    filters.push(`[${videoLabel}][vfade]overlay=x=0:y=0[vfaded]`);
    videoLabel = 'vfaded';
  }

  overlays.forEach((entry, i) => {
    const media = mediaAssets.get(entry.clip.mediaId)!;
    const idx = inputFor(entry);
    const t = entry.clip.transform ?? { x: 0, y: 0, scale: 1, rotationDeg: 0, opacity: 1 };
    // Scale transform coordinates when the preview size differs from the project size.
    const sx = width / project.width;
    const sy = height / project.height;
    const chain = overlayTransformChain(entry.clip, media);
    filters.push(`[${idx}:v]${chain.join(',')}[povl${i}]`);
    filters.push(
      `[${videoLabel}][povl${i}]overlay=x=${Math.round(t.x * sx)}:y=${Math.round(t.y * sy)}[pvc${i}]`
    );
    videoLabel = `pvc${i}`;
  });

  const drawtexts: { text: string; x: number; y: number; fontSize: number; color: string; opacity?: number }[] = [];
  if (baseEntry?.clip.title && baseEntry.clip.title.trim()) {
    drawtexts.push({ text: baseEntry.clip.title, x: -1, y: -1, fontSize: 36, color: 'white' });
  }
  for (const el of project.texts ?? []) {
    if (timeSec >= el.trackStart && timeSec < el.trackStart + el.durationSec && el.text.trim()) {
      const sx = width / project.width;
      const sy = height / project.height;
      drawtexts.push({
        text: el.text,
        x: Math.round(el.x * sx),
        y: Math.round(el.y * sy),
        fontSize: Math.max(8, Math.round(el.fontSize * sy)),
        color: `0x${el.color.replace('#', '')}`,
        opacity: el.opacity
      });
    }
  }
  if (drawtexts.length > 0) {
    const font = findFontFile();
    if (!font) throw new Error('Text is present but no usable font file was found on this host for drawtext.');
    const fontEscaped = font.replace(/\\/g, '/').replace(/:/g, '\\:');
    drawtexts.forEach((d, i) => {
      const pos = d.x === -1 ? `x=(w-text_w)/2:y=h-70` : `x=${d.x}:y=${d.y}`;
      const alpha = d.opacity !== undefined && d.opacity < 1 ? `@${d.opacity}` : '';
      const outLabel = `ptx${i}`;
      filters.push(
        `[${videoLabel}]drawtext=fontfile='${fontEscaped}':text='${escapeDrawtext(d.text)}':fontsize=${d.fontSize}:` +
          `fontcolor=${d.color}${alpha}:borderw=2:box=1:boxcolor=black@0.4:boxborderw=6:${pos}[${outLabel}]`
      );
      videoLabel = outLabel;
    });
  }

  const args: string[] = ['-y'];
  for (const input of inputs) args.push(...input.preArgs, '-i', input.path);
  args.push('-filter_complex', filters.join(';'), '-map', `[${videoLabel}]`, '-frames:v', '1', outputPath);
  return { args, active };
}

/**
 * Render ONE real composited preview frame at an output-timeline
 * instant. Never fabricates: any problem (invalid project, missing or
 * corrupted media, time out of range, ffmpeg failure) returns an
 * explicit error result.
 */
export async function renderPreviewFrame(
  project: VideoProject,
  mediaAssets: Map<string, MediaAsset>,
  timeSec: number,
  outputPath: string,
  options: PreviewOptions = {}
): Promise<PreviewResult> {
  const duration = timelineDuration(project);
  if (timeSec < 0 || timeSec > duration + 1e-6) {
    return { status: 'error', error: `Preview time ${timeSec}s is outside the timeline (0..${duration.toFixed(3)}s)`, timeSec };
  }
  const errors = validateProject(project, mediaAssets);
  if (errors.length > 0) return { status: 'error', error: `Invalid project: ${errors.join('; ')}`, timeSec };
  for (const asset of mediaAssets.values()) {
    if (!fs.existsSync(asset.path)) {
      return { status: 'error', error: `Media file missing: ${asset.path}`, timeSec };
    }
  }
  const ffmpeg = detectFfmpeg();
  if (!ffmpeg) return { status: 'error', error: 'ffmpeg not found on this host; preview requires the ffmpeg engine.', timeSec };

  // Land exactly on the requested frame: quantize, and step one frame
  // back from the very end so a frame exists.
  const frameIndex = Math.min(frameIndexForTime(timeSec, project.fps), frameCountForDuration(duration, project.fps) - 1);
  const frameTime = timeForFrame(frameIndex, project.fps);

  let built: { args: string[]; active: ActiveClip[] };
  try {
    built = buildPreviewArgs(project, mediaAssets, frameTime, outputPath, options);
  } catch (e: any) {
    return { status: 'error', error: e.message, timeSec };
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const { code, log } = await runFfmpeg(ffmpeg, built.args, options.timeoutMs ?? 120_000);
  if (code !== 0 || !fs.existsSync(outputPath)) {
    return {
      status: 'error',
      error: `Preview render failed (ffmpeg exited ${code}); the media may be corrupted or unsupported.`,
      timeSec,
      ffmpegLogTail: log.slice(-1200)
    };
  }
  return {
    status: 'success',
    framePath: outputPath,
    timeSec: frameTime,
    frameIndex,
    width: options.width ?? project.width,
    height: options.height ?? project.height,
    activeClips: built.active.map((a) => ({
      trackId: a.trackId,
      clipId: a.clip.id,
      role: a.role,
      sourceTimeSec: Number(a.sourceTimeSec.toFixed(3))
    }))
  };
}

export function playbackInfo(project: VideoProject): {
  durationSec: number;
  fps: number;
  frameCount: number;
  width: number;
  height: number;
} {
  const durationSec = timelineDuration(project);
  return {
    durationSec,
    fps: project.fps,
    frameCount: frameCountForDuration(durationSec, project.fps),
    width: project.width,
    height: project.height
  };
}
