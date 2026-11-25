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
}

export type ClipEffect = 'none' | 'grayscale' | 'blur' | 'sharpen' | 'invert';

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
