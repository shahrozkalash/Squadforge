import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as crypto from 'crypto';
import type { MediaAsset } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Phase 20: real media probing with ffprobe (the ffmpeg suite's own
 * inspector). Detection never fabricates paths: it checks FFMPEG_PATH /
 * FFPROBE_PATH, PATH, and standard locations, and verifies the file
 * exists.
 */
export function detectTool(envVar: string, name: string): string | null {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates: string[] = [];
  if (process.env[envVar]) candidates.push(process.env[envVar]!);
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) if (dir) candidates.push(path.join(dir, exe));
  if (process.platform !== 'win32') candidates.push(`/usr/bin/${exe}`, `/usr/local/bin/${exe}`);
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

export function detectFfmpeg(): string | null {
  return detectTool('FFMPEG_PATH', 'ffmpeg');
}

export function detectFfprobe(): string | null {
  return detectTool('FFPROBE_PATH', 'ffprobe');
}

export interface ProbeResult {
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  fps?: number;
  /** Phase 26: probed video codec name (drives image-kind detection). */
  videoCodec?: string;
  /** Video Editor Roadmap Phase 4: probed audio codec name (e.g. 'aac'). */
  audioCodec?: string;
  /** Video Editor Roadmap Phase 4: probed audio sample rate in Hz. */
  audioSampleRateHz?: number;
}

const IMAGE_CODECS = new Set(['png', 'mjpeg', 'bmp', 'webp', 'gif', 'tiff', 'jpeg2000', 'avif', 'heic', 'heif']);

export async function probeMedia(filePath: string): Promise<ProbeResult> {
  const ffprobe = detectFfprobe();
  if (!ffprobe) throw new Error('ffprobe not found on this host; cannot probe media honestly');
  if (!fs.existsSync(filePath)) throw new Error(`Media file not found: ${filePath}`);
  const { stdout } = await execFileAsync(
    ffprobe,
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath],
    { timeout: 30_000 }
  );
  const parsed = JSON.parse(stdout);
  const streams: any[] = parsed.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  let fps: number | undefined;
  if (video?.avg_frame_rate && video.avg_frame_rate !== '0/0') {
    const [n, d] = video.avg_frame_rate.split('/').map(Number);
    if (d) fps = Math.round((n / d) * 100) / 100;
  }
  let durationSec = parseFloat(parsed.format?.duration || video?.duration || audio?.duration || '0');
  // Still images carry no intrinsic duration — that is not an error;
  // the clip's source span defines how long they show (they loop).
  const isImage = Boolean(video?.codec_name && IMAGE_CODECS.has(video.codec_name) && !audio);
  if (isImage && (Number.isNaN(durationSec) || durationSec <= 0)) durationSec = 0;
  if (Number.isNaN(durationSec) || (!isImage && !durationSec)) throw new Error(`Could not determine duration of ${filePath}`);
  return {
    durationSec,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width,
    height: video?.height,
    fps,
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    audioSampleRateHz: audio?.sample_rate ? Number(audio.sample_rate) : undefined
  };
}

export async function importMedia(filePath: string): Promise<MediaAsset> {
  const probe = await probeMedia(filePath);
  const isImage = Boolean(probe.videoCodec && IMAGE_CODECS.has(probe.videoCodec) && !probe.hasAudio);
  return {
    id: crypto.randomUUID(),
    path: filePath,
    durationSec: probe.durationSec,
    hasVideo: probe.hasVideo,
    hasAudio: probe.hasAudio,
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    // Phase 26: still images are first-class media (they loop in the exporter).
    kind: isImage ? 'image' : probe.hasVideo ? 'video' : 'audio'
  };
}
