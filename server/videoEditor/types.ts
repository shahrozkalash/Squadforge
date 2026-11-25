/**
 * Phase 20: Video Editing Engine — shared types.
 *
 * A project is a multitrack timeline. Clips reference probed media
 * assets by id; all times are seconds. The exporter turns this model
 * into a real ffmpeg filter graph — nothing is simulated.
 */

export interface MediaAsset {
  id: string;
  /** Absolute or workspace-relative path of the real media file. */
  path: string;
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  fps?: number;
  /**
   * Phase 26: media kind. Optional for Phase 20 compatibility —
   * when absent it is inferred (image codecs report hasVideo with a
   * near-zero duration; importMedia sets it explicitly).
   */
  kind?: 'video' | 'audio' | 'image';
}

/** Phase 26: media kind inference for assets that predate the field. */
export function mediaKind(asset: MediaAsset): 'video' | 'audio' | 'image' {
  if (asset.kind) return asset.kind;
  if (!asset.hasVideo) return 'audio';
  return 'video';
}

export type ClipEffect = 'none' | 'grayscale' | 'blur' | 'sharpen' | 'invert';

/**
 * Phase 26: spatial transform for a clip. Applies to overlay-track
 * clips (picture-in-picture / compositing). On the base video track
 * only crop and speed are applied (the base fills the canvas by
 * definition); this is documented behaviour, not a silent no-op —
 * the exporter reports base-track transforms in its result notes.
 */
export interface ClipTransform {
  /** Top-left position in output-canvas pixels (may be negative). */
  x: number;
  y: number;
  /** Scale relative to the (cropped) source size. 0.05..4 */
  scale: number;
  /** Clockwise rotation in degrees. -360..360 */
  rotationDeg: number;
  /** 0 (transparent) .. 1 (opaque) */
  opacity: number;
  /** Pixels cropped from each edge of the source before scaling. */
  crop?: { left: number; top: number; right: number; bottom: number };
}

export const DEFAULT_TRANSFORM: ClipTransform = { x: 0, y: 0, scale: 1, rotationDeg: 0, opacity: 1 };

export interface TimelineClip {
  id: string;
  mediaId: string;
  /** Position on the timeline (seconds). */
  trackStart: number;
  /** Source trim points (seconds into the media asset). */
  sourceIn: number;
  sourceOut: number;
  /** 0..1 for audio-bearing clips */
  volume: number;
  effect: ClipEffect;
  /** Optional title text rendered over this clip's span. */
  title?: string;
  /** Phase 26: playback speed of the source. 0.25..4, default 1. Timeline duration = source span / speed. */
  speed?: number;
  /** Phase 26: spatial transform (overlay tracks). Absent = DEFAULT_TRANSFORM. */
  transform?: ClipTransform;
}

/**
 * Phase 26: a text layer element, rendered over the composited video
 * with drawtext during its window. The project's `texts` array order
 * is the layer (z) order.
 */
export interface TextElement {
  id: string;
  text: string;
  trackStart: number;
  durationSec: number;
  /** Top-left position in output-canvas pixels. */
  x: number;
  y: number;
  fontSize: number;
  /** #RRGGBB */
  color: string;
  /** 0..1, default 1 */
  opacity?: number;
}

export interface TimelineTrack {
  id: string;
  kind: 'video' | 'audio';
  name: string;
  clips: TimelineClip[];
}

export interface Transition {
  /** Id of the outgoing clip on the base video track. */
  afterClipId: string;
  type: 'crossfade';
  durationSec: number;
}

export interface VideoProject {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  tracks: TimelineTrack[];
  transitions: Transition[];
  /** Phase 26: text layer elements (optional in Phase 20 projects). */
  texts?: TextElement[];
}

export interface ExportSettings {
  width: number;
  height: number;
  fps: number;
  format: 'mp4';
  videoCodec: 'libx264';
  audioCodec: 'aac';
  videoBitrateKbps: number;
}

export interface ExportResult {
  status: 'success' | 'failed';
  outputPath?: string;
  outputBytes?: number;
  durationSec?: number;
  expectedDurationSec: number;
  ffmpegLogTail: string;
  error?: string;
  /** Phase 26: honest notes about what was applied (overlays, texts, ignored base transforms). */
  notes?: string[];
  /** ffprobe facts about the produced file, when it exists. */
  probe?: {
    durationSec: number;
    width?: number;
    height?: number;
    fps?: number;
    hasVideo: boolean;
    hasAudio: boolean;
  };
}

export interface SerializedVideoProject {
  format: 'squadforge-video-project';
  version: 1;
  project: VideoProject;
  media: MediaAsset[];
}
