import { spawn } from 'child_process';

/**
 * Phase 30: hardware encoder detection. An encoder merely being LISTED
 * by ffmpeg proves nothing (the binary can be built with nvenc support
 * on a machine with no GPU), so every listed hardware encoder is
 * verified with a real 1-frame encode probe before it is reported as
 * available. Results are cached per ffmpeg path for the process
 * lifetime — probing is honest but not free.
 */

export interface EncoderInfo {
  encoder: string;
  kind: 'nvenc' | 'qsv' | 'amf' | 'videotoolbox' | 'vaapi' | 'software';
  /** Present in `ffmpeg -encoders` output. */
  listed: boolean;
  /** Passed a real encode probe (software: always probed too). */
  verified: boolean;
  detail: string;
}

const HW_CANDIDATES: Array<{ encoder: string; kind: EncoderInfo['kind'] }> = [
  { encoder: 'h264_nvenc', kind: 'nvenc' },
  { encoder: 'h264_qsv', kind: 'qsv' },
  { encoder: 'h264_amf', kind: 'amf' },
  { encoder: 'h264_videotoolbox', kind: 'videotoolbox' },
  { encoder: 'h264_vaapi', kind: 'vaapi' }
];

const cache = new Map<string, Promise<EncoderInfo[]>>();

function runProbe(ffmpeg: string, args: string[], timeoutMs: number): Promise<{ code: number; log: string }> {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, args, { shell: false });
    let log = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    // `ffmpeg -encoders` prints its table to stdout; diagnostics go to stderr. Both count.
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

async function probeEncoder(ffmpeg: string, encoder: string): Promise<{ ok: boolean; detail: string }> {
  const { code, log } = await runProbe(
    ffmpeg,
    ['-y', '-f', 'lavfi', '-i', 'color=black:s=64x64:d=0.1:r=10', '-c:v', encoder, '-f', 'null', '-'],
    20_000
  );
  if (code === 0) return { ok: true, detail: 'passed a real 1-frame encode probe' };
  const tail = log.trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 220);
  return { ok: false, detail: `encode probe failed (exit ${code})${tail ? `: ${tail}` : ''}` };
}

async function detect(ffmpeg: string): Promise<EncoderInfo[]> {
  const listing = await runProbe(ffmpeg, ['-hide_banner', '-encoders'], 15_000);
  const listed = (name: string): boolean => new RegExp(`\\b${name}\\b`).test(listing.log);
  const results: EncoderInfo[] = [];
  const softwareListed = listed('libx264');
  const softwareProbe = softwareListed
    ? await probeEncoder(ffmpeg, 'libx264')
    : { ok: false, detail: 'libx264 not listed by this ffmpeg build' };
  results.push({
    encoder: 'libx264',
    kind: 'software',
    listed: softwareListed,
    verified: softwareProbe.ok,
    detail: softwareProbe.detail
  });
  for (const candidate of HW_CANDIDATES) {
    if (!listed(candidate.encoder)) {
      results.push({
        encoder: candidate.encoder,
        kind: candidate.kind,
        listed: false,
        verified: false,
        detail: 'not listed by this ffmpeg build'
      });
      continue;
    }
    const probe = await probeEncoder(ffmpeg, candidate.encoder);
    results.push({
      encoder: candidate.encoder,
      kind: candidate.kind,
      listed: true,
      verified: probe.ok,
      detail: probe.detail
    });
  }
  return results;
}

export function detectEncoders(ffmpeg: string): Promise<EncoderInfo[]> {
  let pending = cache.get(ffmpeg);
  if (!pending) {
    pending = detect(ffmpeg);
    cache.set(ffmpeg, pending);
  }
  return pending;
}

/** The first hardware encoder that is listed AND probe-verified, or null. */
export async function firstVerifiedHardwareEncoder(ffmpeg: string): Promise<string | null> {
  const encoders = await detectEncoders(ffmpeg);
  const hw = encoders.find((e) => e.kind !== 'software' && e.verified);
  return hw ? hw.encoder : null;
}

/** Verify one named encoder (listed + real probe). */
export async function verifyEncoder(ffmpeg: string, encoder: string): Promise<boolean> {
  if (encoder === 'libx264') {
    const encoders = await detectEncoders(ffmpeg);
    return encoders.find((e) => e.encoder === 'libx264')?.verified ?? false;
  }
  const listing = await runProbe(ffmpeg, ['-hide_banner', '-encoders'], 15_000);
  if (!new RegExp(`\\b${encoder}\\b`).test(listing.log)) return false;
  const probe = await probeEncoder(ffmpeg, encoder);
  return probe.ok;
}

/** Test hook: forget cached detection results. */
export function clearEncoderCache(): void {
  cache.clear();
}
