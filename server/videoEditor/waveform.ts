import { spawn } from 'child_process';
import { detectFfmpeg, probeMedia } from './mediaProbe.js';

/**
 * Phase 29: waveform visualization from the ACTUAL audio signal.
 *
 * The media is decoded by ffmpeg to mono 16-bit PCM at a low sample
 * rate and consumed as a stream — chunks are folded into per-bucket
 * peak values as they arrive, so arbitrarily long files never sit in
 * memory. Peaks are absolute sample peaks normalized to 0..1.
 */

export interface WaveformResult {
  status: 'success' | 'error';
  error?: string;
  /** One peak (0..1) per bucket. */
  peaks?: number[];
  durationSec?: number;
  bucketSec?: number;
  sampleRate?: number;
}

export async function computeWaveform(
  mediaPath: string,
  options: { bucketsPerSecond?: number; sampleRate?: number; timeoutMs?: number } = {}
): Promise<WaveformResult> {
  const ffmpeg = detectFfmpeg();
  if (!ffmpeg) return { status: 'error', error: 'ffmpeg not found on this host; waveform generation requires ffmpeg.' };
  let probe;
  try {
    probe = await probeMedia(mediaPath);
  } catch (e: any) {
    return { status: 'error', error: `Could not probe media: ${e.message}` };
  }
  if (!probe.hasAudio) return { status: 'error', error: 'Media has no audio stream; there is no waveform to compute.' };

  const sampleRate = options.sampleRate ?? 8000;
  const bucketsPerSecond = options.bucketsPerSecond ?? 20;
  const samplesPerBucket = Math.max(1, Math.round(sampleRate / bucketsPerSecond));
  const peaks: number[] = [];
  let bucketPeak = 0;
  let bucketCount = 0;
  let leftover: Buffer | null = null;

  const code = await new Promise<number>((resolve) => {
    const child = spawn(
      ffmpeg,
      ['-v', 'error', '-i', mediaPath, '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', '-acodec', 'pcm_s16le', '-'],
      { shell: false }
    );
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 300_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      const data = leftover ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = data.length - (data.length % 2);
      leftover = usable < data.length ? data.subarray(usable) : null;
      for (let i = 0; i < usable; i += 2) {
        const sample = Math.abs(data.readInt16LE(i)) / 32768;
        if (sample > bucketPeak) bucketPeak = sample;
        bucketCount++;
        if (bucketCount >= samplesPerBucket) {
          peaks.push(Number(bucketPeak.toFixed(4)));
          bucketPeak = 0;
          bucketCount = 0;
        }
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(-1);
    });
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve(c ?? -1);
    });
  });
  if (code !== 0) {
    return { status: 'error', error: `ffmpeg failed to decode the audio (exit ${code}); the file may be corrupted.` };
  }
  if (bucketCount > 0) peaks.push(Number(bucketPeak.toFixed(4)));
  return {
    status: 'success',
    peaks,
    durationSec: probe.durationSec,
    bucketSec: samplesPerBucket / sampleRate,
    sampleRate
  };
}
