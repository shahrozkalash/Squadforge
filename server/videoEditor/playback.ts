import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { MediaAsset, TimelineClip, TransitionType, VideoProject } from './types.js';
import { mediaKind } from './types.js';
import {
  baseVideoTrack,
  clipDuration,
  clipSpeed,
  serializeVideoProject,
  timelineDuration,
  validateProject
} from './timeline.js';
import {
  escapeDrawtext,
  findFontFile,
  overlayTransformChain,
  runFfmpeg
} from './videoExporter.js';
import { effectChainFor, hasKeyframedProperty, sampleKeyframes } from './effects.js';
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
 *
 * Phase 3 (Video Editor Roadmap) adds, in this module: aspect-ratio
 * helpers and aspect-preserving preview sizing (fitWithinBox /
 * previewSizeFor — before this, preview knew only raw pixel sizes),
 * overlay-image scaling at non-project preview sizes (before this,
 * only overlay positions scaled and the preview diverged from the
 * export geometry), and a bounded PreviewFrameCache so identical
 * repeat preview requests skip the ffmpeg decode (invalidation is by
 * full project + media-file fingerprint, so edits always show).
 *
 * Phase 5 (Video Editor Roadmap) closes the preview/export parity
 * gaps the editing-tools audit found in this module: transitions now
 * composite the way the exporter's xfade does for all eight types
 * (before this, every transition previewed as a plain crossfade —
 * a wipe showed as a blend, a slide did not move), the title drawn
 * during a transition is the incoming clip's (the exporter's title
 * window for the outgoing clip ends where the junction starts), the
 * drawtext box styling matches the exporter's per-kind constants,
 * and a rotation-keyframed overlay rotates into the same union
 * canvas the exporter's segments share (before this, the per-angle
 * box put the content centre somewhere else entirely).
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

// ---------------------------------------------------------------- aspect ratio & preview sizing

/**
 * Phase 3 (Video Editor Roadmap): aspect-ratio awareness for preview.
 *
 * Before this phase the preview knew only raw pixel sizes: a caller
 * passed width/height (or got the project size) and nothing anywhere
 * could answer "what size shows this 16:9 project inside a 640x360
 * box without distorting it?". These helpers are the missing layer.
 * They are pure geometry over the project size — the render itself
 * still runs through the one shared chain in buildPreviewArgs, so a
 * fitted preview is the export geometry scaled, never an approximation
 * of it.
 */

/** Standard aspect ratios by name, as width/height. */
export const ASPECT_RATIOS: Readonly<Record<string, number>> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
  '21:9': 21 / 9
};

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Reduced "W:H" name of a pixel size, e.g. (1920, 1080) -> "16:9". */
export function aspectRatioString(width: number, height: number): string {
  if (!(width > 0) || !(height > 0)) throw new Error(`aspect ratio needs positive dimensions, got ${width}x${height}`);
  const w = Math.round(width);
  const h = Math.round(height);
  const d = gcd(w, h);
  return `${w / d}:${h / d}`;
}

/** Parse "16:9" (or a standard name) into a numeric width/height ratio. */
export function parseAspectRatio(input: string | number): number {
  if (typeof input === 'number') {
    if (!(input > 0)) throw new Error(`aspect ratio must be positive, got ${input}`);
    return input;
  }
  const named = ASPECT_RATIOS[input.trim()];
  if (named !== undefined) return named;
  const m = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(input.trim());
  if (!m || Number(m[2]) === 0) {
    throw new Error(`unrecognized aspect ratio '${input}' (expected e.g. '16:9' or one of ${Object.keys(ASPECT_RATIOS).join(', ')})`);
  }
  return Number(m[1]) / Number(m[2]);
}

/**
 * The largest size with the source's aspect ratio that fits inside a
 * box — never upscaled (a preview larger than the project would invent
 * pixels the export does not have). Dimensions are floored to even
 * numbers, minimum 2: the preview chain passes through yuv420p, whose
 * chroma subsampling requires even dimensions.
 */
export function fitWithinBox(
  srcWidth: number,
  srcHeight: number,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  if (!(srcWidth > 0) || !(srcHeight > 0)) throw new Error(`fit source must be positive, got ${srcWidth}x${srcHeight}`);
  if (!(maxWidth > 0) || !(maxHeight > 0)) throw new Error(`fit box must be positive, got ${maxWidth}x${maxHeight}`);
  const scale = Math.min(maxWidth / srcWidth, maxHeight / srcHeight, 1);
  const evenFloor = (v: number): number => Math.max(2, Math.floor(v / 2) * 2);
  return { width: evenFloor(srcWidth * scale), height: evenFloor(srcHeight * scale) };
}

export interface PreviewSizeOptions {
  width?: number;
  height?: number;
  maxWidth?: number;
  maxHeight?: number;
}

/**
 * Resolve the concrete pixel size of a preview frame. Precedence:
 * explicit width/height (each defaulting to the project's, the
 * pre-Phase-3 behaviour, verbatim) > aspect-preserving fit inside
 * maxWidth/maxHeight > the project size itself.
 */
export function previewSizeFor(project: VideoProject, options: PreviewSizeOptions = {}): { width: number; height: number } {
  if (options.width !== undefined || options.height !== undefined) {
    return { width: options.width ?? project.width, height: options.height ?? project.height };
  }
  if (options.maxWidth !== undefined || options.maxHeight !== undefined) {
    return fitWithinBox(project.width, project.height, options.maxWidth ?? Number.POSITIVE_INFINITY, options.maxHeight ?? Number.POSITIVE_INFINITY);
  }
  return { width: project.width, height: project.height };
}

// ---------------------------------------------------------------- preview frame cache

/**
 * Phase 3 (Video Editor Roadmap): bounded cache of rendered preview
 * frames. Before this phase every preview request re-ran ffmpeg —
 * scrubbing back over the same frame re-decoded the same sources every
 * time. The cache key fingerprints everything a frame depends on: the
 * full serialized project (so ANY edit invalidates), each media file's
 * path + size + mtime (so replacing a file in place invalidates), the
 * frame index, the resolved size, and the hidden-track set. A hit
 * still resolves the timeline through the same code path — only the
 * ffmpeg decode is skipped — so a cached frame can never diverge from
 * what a fresh render would report.
 */
export function previewCacheKey(
  project: VideoProject,
  mediaAssets: Map<string, MediaAsset>,
  frameIndex: number,
  width: number,
  height: number,
  hiddenTrackIds?: ReadonlySet<string>
): string {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(serializeVideoProject(project, mediaAssets)));
  const assets = [...mediaAssets.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const asset of assets) {
    let stat = 'missing';
    try {
      const s = fs.statSync(asset.path);
      stat = `${s.size}:${s.mtimeMs}`;
    } catch {
      /* missing media errors out before the cache is consulted */
    }
    hash.update(`|${asset.id}:${asset.path}:${stat}`);
  }
  hash.update(`|f${frameIndex}|${width}x${height}|h${[...(hiddenTrackIds ?? [])].sort().join(',')}`);
  return hash.digest('hex');
}

export class PreviewFrameCache {
  private readonly entries = new Map<string, string>();

  constructor(
    readonly dir: string,
    readonly maxEntries: number = 60
  ) {
    if (!(maxEntries >= 1)) throw new Error('preview cache maxEntries must be at least 1');
  }

  get size(): number {
    return this.entries.size;
  }

  /** Path of the cached frame for a key, or null (missing/evicted/file gone). */
  get(key: string): string | null {
    const p = this.entries.get(key);
    if (!p) return null;
    if (!fs.existsSync(p)) {
      this.entries.delete(key);
      return null;
    }
    // Refresh recency: eviction removes the least recently used entry.
    this.entries.delete(key);
    this.entries.set(key, p);
    return p;
  }

  /** Store a rendered frame under a key (copied into the cache dir). Returns the cached path. */
  put(key: string, sourcePath: string): string {
    fs.mkdirSync(this.dir, { recursive: true });
    const dest = path.join(this.dir, `${key}.png`);
    if (path.resolve(sourcePath) !== path.resolve(dest)) fs.copyFileSync(sourcePath, dest);
    this.entries.delete(key);
    this.entries.set(key, dest);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      const oldPath = this.entries.get(oldest)!;
      this.entries.delete(oldest);
      fs.rmSync(oldPath, { force: true });
    }
    return dest;
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

export interface PreviewOptions extends ResolveOptions, PreviewSizeOptions {
  timeoutMs?: number;
  /** Phase 3: bounded preview-frame cache; identical repeat requests skip the ffmpeg decode. */
  cache?: PreviewFrameCache;
}

/** The smoothstep curve (0 at x<=0, 1 at x>=1) the xfade fades are built from. */
function smoothstep01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
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
    const bChain = effectChainFor(baseEntry.clip);
    const effect = bChain.length > 0 ? `,${bChain.join(',')}` : '';
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

  if (fadeEntry && baseEntry) {
    const idx = inputFor(fadeEntry);
    const crop = fadeEntry.clip.transform?.crop
      ? `crop=w=iw-${fadeEntry.clip.transform.crop.left + fadeEntry.clip.transform.crop.right}:h=ih-${fadeEntry.clip.transform.crop.top + fadeEntry.clip.transform.crop.bottom}:x=${fadeEntry.clip.transform.crop.left}:y=${fadeEntry.clip.transform.crop.top},`
      : '';
    const fChain = effectChainFor(fadeEntry.clip);
    const effect = fChain.length > 0 ? `,${fChain.join(',')}` : '';
    const p = Math.min(1, Math.max(0, fadeEntry.transitionProgress ?? 0));
    // Phase 5: composite the junction the way the exporter's xfade
    // renders this transition TYPE. Before this, every type previewed
    // as an alpha crossfade, so seven of the eight types showed
    // something materially different from the export. The single-frame
    // forms below implement the same per-pixel definitions xfade uses
    // (verified against real xfade renders in the Phase 5 suite).
    const transition = project.transitions.find((tr) => tr.afterClipId === baseEntry.clip.id);
    const fadeType: TransitionType = transition?.type ?? 'crossfade';
    /** The incoming clip rendered to canvas size; `alpha` appends the rgba fade suffix when given. */
    const incomingChain = (label: string, alpha?: number): void => {
      const a = alpha !== undefined ? `,format=rgba,colorchannelmixer=aa=${alpha.toFixed(3)}` : '';
      filters.push(
        `[${idx}:v]${crop}scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p${effect}${a}[${label}]`
      );
    };
    /** A solid-colour canvas input (the wipe/slide/fade background), labelled rgba. */
    const solidCanvas = (color: string, label: string): void => {
      inputs.push({ path: `color=c=${color}:s=${width}x${height}:r=${project.fps}`, preArgs: ['-f', 'lavfi'] });
      filters.push(`[${inputs.length - 1}:v]format=rgba[${label}]`);
    };

    if (fadeType === 'crossfade') {
      incomingChain('vfade', p);
      filters.push(`[${videoLabel}][vfade]overlay=x=0:y=0[vfaded]`);
      videoLabel = 'vfaded';
    } else if (fadeType === 'fade-black' || fadeType === 'fade-white') {
      // xfade fadeblack/fadewhite are NOT two linear half-fades: with
      // q = 1 - p, out = mix(mix(a, bg, smoothstep(0.8, 1, q)),
      // mix(bg, b, smoothstep(0.2, 1, q)), q) — a convex combination
      // out = a*aa + b*ab + bg*abg with the coefficients below.
      const s1 = smoothstep01(1 - p / 0.2);
      const s2 = smoothstep01(1 - p / 0.8);
      const aa = (1 - p) * s1;
      const ab = p * (1 - s2);
      const abg = 1 - aa - ab;
      if (aa < 0.999) {
        solidCanvas(fadeType === 'fade-black' ? 'black' : 'white', 'vbg');
        incomingChain('vfade', ab / (ab + abg));
        filters.push(`[vbg][vfade]overlay=x=0:y=0[vfx]`);
        if (aa < 0.001) {
          videoLabel = 'vfx';
        } else {
          filters.push(`[${videoLabel}]format=rgba,colorchannelmixer=aa=${aa.toFixed(3)}[vbasea]`);
          filters.push(`[vfx][vbasea]overlay=x=0:y=0[vfaded]`);
          videoLabel = 'vfaded';
        }
      }
    } else if (fadeType === 'wipe-left' || fadeType === 'wipe-right') {
      // xfade wipes are hard-edged: wipe-left reveals the incoming
      // clip from the RIGHT edge (its boundary sits at (1-p) of the
      // width), wipe-right from the left.
      const cover = Math.round(width * p);
      if (cover > 0) {
        incomingChain('vfade');
        if (fadeType === 'wipe-left') {
          filters.push(`[vfade]crop=w=${cover}:h=${height}:x=${width - cover}:y=0[vwipe]`);
          filters.push(`[${videoLabel}][vwipe]overlay=x=${width - cover}:y=0[vfaded]`);
        } else {
          filters.push(`[vfade]crop=w=${cover}:h=${height}:x=0:y=0[vwipe]`);
          filters.push(`[${videoLabel}][vwipe]overlay=x=0:y=0[vfaded]`);
        }
        videoLabel = 'vfaded';
      }
    } else if (fadeType === 'slide-left' || fadeType === 'slide-right') {
      // Both frames move: the outgoing slides out in the named
      // direction, the incoming follows it in from the other side.
      const dir = fadeType === 'slide-left' ? -1 : 1;
      solidCanvas('black', 'vbg');
      filters.push(`[vbg][${videoLabel}]overlay=x=${dir * Math.round(width * p)}:y=0[vslide]`);
      incomingChain('vfade');
      filters.push(`[vslide][vfade]overlay=x=${-dir * Math.round(width * (1 - p))}:y=0[vfaded]`);
      videoLabel = 'vfaded';
    } else {
      // zoom-in: the outgoing frame zooms into its own centre over
      // the first half (sampling window = smoothstep(1-2p) of the
      // frame, centred); over the second half that centre pixel's
      // colour blends out to the incoming frame.
      const zf = smoothstep01(1 - 2 * p);
      if (p < 0.5 && zf >= 0.02) {
        const cw = Math.max(2, Math.round(width * zf));
        const ch = Math.max(2, Math.round(height * zf));
        filters.push(`[${videoLabel}]crop=w=${cw}:h=${ch},scale=${width}:${height}[vfaded]`);
        videoLabel = 'vfaded';
      } else {
        const k = smoothstep01(2 - 2 * p);
        incomingChain('vfade');
        if (k < 0.001) {
          videoLabel = 'vfade';
        } else {
          const cx = Math.ceil((width - 1) / 2);
          const cy = Math.ceil((height - 1) / 2);
          filters.push(
            `[${videoLabel}]crop=w=1:h=1:x=${cx}:y=${cy},scale=${width}:${height}:flags=neighbor,format=rgba,colorchannelmixer=aa=${k.toFixed(3)}[vcen]`
          );
          filters.push(`[vfade][vcen]overlay=x=0:y=0[vfaded]`);
          videoLabel = 'vfaded';
        }
      }
    }
  }

  overlays.forEach((entry, i) => {
    const media = mediaAssets.get(entry.clip.mediaId)!;
    const idx = inputFor(entry);
    const baseTransform = entry.clip.transform ?? { x: 0, y: 0, scale: 1, rotationDeg: 0, opacity: 1 };
    // Phase 28: keyframed clips are sampled at this instant with the
    // same interpolation the exporter compiles — preview == export.
    const localT = Math.max(0, timeSec - entry.clip.trackStart);
    const t = entry.clip.keyframes?.length
      ? sampleKeyframes(entry.clip.keyframes, baseTransform, localT)
      : baseTransform;
    // Scale transform coordinates when the preview size differs from the project size.
    const sx = width / project.width;
    const sy = height / project.height;
    // Phase 5: when rotation is KEYFRAMED, the exporter rotates into
    // a UNION canvas over every keyframed angle and scale (its
    // segments must share one frame size, and the content sits
    // centred in it). Rotating into the per-angle box instead — what
    // overlayTransformChain does — put the content centre somewhere
    // else entirely, so a rotating overlay sat at a different canvas
    // position in preview and export. Mirror the exporter's geometry:
    // same chain, but the rotate step targets the union box. (The
    // scale VALUE still differs by the exporter's documented
    // per-segment step approximation; the sampled value here is the
    // instant's own.)
    const kfs = entry.clip.keyframes ?? [];
    let chain: string[];
    if (kfs.length > 0 && hasKeyframedProperty(kfs, 'rotationDeg') && media.width && media.height) {
      const angles = [baseTransform.rotationDeg, ...kfs.map((kf) => kf.rotationDeg).filter((v): v is number => v !== undefined)];
      const scales = [baseTransform.scale, ...kfs.map((kf) => kf.scale).filter((v): v is number => v !== undefined)];
      const maxScale = Math.max(...scales);
      let ow = 0;
      let oh = 0;
      for (const deg of angles) {
        const rad = (deg * Math.PI) / 180;
        ow = Math.max(ow, Math.ceil(maxScale * (media.width * Math.abs(Math.cos(rad)) + media.height * Math.abs(Math.sin(rad)))));
        oh = Math.max(oh, Math.ceil(maxScale * (media.width * Math.abs(Math.sin(rad)) + media.height * Math.abs(Math.cos(rad)))));
      }
      const rad = (t.rotationDeg * Math.PI) / 180;
      chain = [
        ...(t.crop
          ? [`crop=w=iw-${t.crop.left + t.crop.right}:h=ih-${t.crop.top + t.crop.bottom}:x=${t.crop.left}:y=${t.crop.top}`]
          : []),
        ...effectChainFor(entry.clip),
        ...(t.scale !== 1 ? [`scale=iw*${t.scale}:ih*${t.scale}`] : []),
        'format=rgba',
        `rotate=${rad.toFixed(6)}:ow=${ow}:oh=${oh}:c=none`,
        ...(t.opacity !== 1 ? [`colorchannelmixer=aa=${t.opacity}`] : []),
        'setsar=1'
      ];
    } else {
      chain = overlayTransformChain({ ...entry.clip, transform: t }, media);
    }
    // Phase 3: the overlay IMAGE scales with the preview size too.
    // Before this, only its position was scaled — at any preview size
    // other than the project's, the overlay kept its natural pixel
    // size and the preview diverged from the export geometry.
    if (sx !== 1 || sy !== 1) chain.push(`scale=iw*${sx}:ih*${sy}`);
    filters.push(`[${idx}:v]${chain.join(',')}[povl${i}]`);
    filters.push(
      `[${videoLabel}][povl${i}]overlay=x=${Math.round(t.x * sx)}:y=${Math.round(t.y * sy)}[pvc${i}]`
    );
    videoLabel = `pvc${i}`;
  });

  const drawtexts: { text: string; x: number; y: number; fontSize: number; color: string; opacity?: number; boxAlpha: number; boxBorder: number }[] = [];
  // Phase 5: the box styling is per-kind and matches the exporter's
  // constants (title 0.5/8, caption 0.55/8, text element 0.35/6) —
  // before this, the preview used 0.4/6 for all three and the boxes
  // rendered visibly lighter than the export's.
  // Phase 5: during a transition the drawn title is the INCOMING
  // clip's — the exporter's window for the outgoing clip's title ends
  // where the junction starts, and the incoming clip's title runs
  // through it. Before this, the preview always drew the outgoing
  // clip's title during a junction.
  const titleClip = fadeEntry ? fadeEntry.clip : baseEntry?.clip;
  if (titleClip?.title && titleClip.title.trim()) {
    drawtexts.push({ text: titleClip.title, x: -1, y: -1, fontSize: 36, color: 'white', boxAlpha: 0.5, boxBorder: 8 });
  }
  // Phase 29: the caption cue active at this instant, bottom-centre
  // exactly as the exporter burns it in.
  const activeCue = (project.captions ?? []).find((c) => timeSec >= c.startSec && timeSec < c.endSec && c.text.trim());
  if (activeCue) {
    drawtexts.push({ text: activeCue.text, x: -1, y: height - 52, fontSize: 28, color: 'white', boxAlpha: 0.55, boxBorder: 8 });
  }
  for (const el of project.texts ?? []) {
    if (timeSec >= el.trackStart && timeSec < el.trackStart + el.durationSec && el.text.trim()) {
      const sx = width / project.width;
      const sy = height / project.height;
      // Phase 28: sample text position keyframes at this instant.
      let ex = el.x;
      let ey = el.y;
      if (el.keyframes?.length) {
        const sampled = sampleKeyframes(
          el.keyframes,
          { x: el.x, y: el.y, scale: 1, rotationDeg: 0, opacity: el.opacity ?? 1 },
          timeSec - el.trackStart
        );
        ex = sampled.x;
        ey = sampled.y;
      }
      drawtexts.push({
        text: el.text,
        x: Math.round(ex * sx),
        y: Math.round(ey * sy),
        fontSize: Math.max(8, Math.round(el.fontSize * sy)),
        color: `0x${el.color.replace('#', '')}`,
        opacity: el.opacity,
        boxAlpha: 0.35,
        boxBorder: 6
      });
    }
  }
  if (drawtexts.length > 0) {
    const font = findFontFile();
    if (!font) throw new Error('Text is present but no usable font file was found on this host for drawtext.');
    const fontEscaped = font.replace(/\\/g, '/').replace(/:/g, '\\:');
    drawtexts.forEach((d, i) => {
      const pos = d.x === -1 ? `x=(w-text_w)/2:y=${d.y >= 0 ? d.y : 'h-70'}` : `x=${d.x}:y=${d.y}`;
      const alpha = d.opacity !== undefined && d.opacity < 1 ? `@${d.opacity}` : '';
      const outLabel = `ptx${i}`;
      filters.push(
        `[${videoLabel}]drawtext=fontfile='${fontEscaped}':text='${escapeDrawtext(d.text)}':fontsize=${d.fontSize}:` +
          `fontcolor=${d.color}${alpha}:borderw=2:box=1:boxcolor=black@${d.boxAlpha}:boxborderw=${d.boxBorder}:${pos}[${outLabel}]`
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
  // Phase 3: one resolved size for the whole render — explicit size,
  // aspect-preserving fit, or the project size (previewSizeFor).
  const size = previewSizeFor(project, options);
  const sizedOptions: PreviewOptions = { ...options, width: size.width, height: size.height };

  let built: { args: string[]; active: ActiveClip[] };
  try {
    built = buildPreviewArgs(project, mediaAssets, frameTime, outputPath, sizedOptions);
  } catch (e: any) {
    return { status: 'error', error: e.message, timeSec };
  }
  const success = (): PreviewSuccess => ({
    status: 'success',
    framePath: outputPath,
    timeSec: frameTime,
    frameIndex,
    width: size.width,
    height: size.height,
    activeClips: built.active.map((a) => ({
      trackId: a.trackId,
      clipId: a.clip.id,
      role: a.role,
      sourceTimeSec: Number(a.sourceTimeSec.toFixed(3))
    }))
  });

  // Phase 3: a cache hit skips only the decode — resolution above has
  // already run through the same code path, so the reported frame is
  // identical to a fresh render's.
  const cacheKey = options.cache
    ? previewCacheKey(project, mediaAssets, frameIndex, size.width, size.height, options.hiddenTrackIds)
    : null;
  if (options.cache && cacheKey) {
    const hit = options.cache.get(cacheKey);
    if (hit) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.copyFileSync(hit, outputPath);
      return success();
    }
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
  if (options.cache && cacheKey) options.cache.put(cacheKey, outputPath);
  return success();
}

export function playbackInfo(project: VideoProject): {
  durationSec: number;
  fps: number;
  frameCount: number;
  width: number;
  height: number;
  /** Phase 3: the project's aspect ratio as a reduced "W:H" name. */
  aspectRatio: string;
} {
  const durationSec = timelineDuration(project);
  return {
    durationSec,
    fps: project.fps,
    frameCount: frameCountForDuration(durationSec, project.fps),
    width: project.width,
    height: project.height,
    aspectRatio: aspectRatioString(project.width, project.height)
  };
}
