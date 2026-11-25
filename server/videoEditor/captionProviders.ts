import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import type { CaptionCue } from './types.js';
import { parseSrt } from './captions.js';

/**
 * Phase 29: automatic caption generation through a CONFIGURABLE
 * provider adapter.
 *
 * Rules enforced by design:
 * - No provider is required. The default is 'none': caption
 *   generation reports itself unavailable and the manual caption
 *   workflow remains fully functional.
 * - No paid APIs. The only implemented provider shells out to a
 *   locally installed Whisper-compatible CLI (`whisper` /
 *   `whisper-cpp` style: `<bin> <file> --output_format srt
 *   --output_dir <dir>`), fully offline.
 * - A provider that is missing, misconfigured, or failing produces
 *   an explicit error result. Captions are NEVER fabricated.
 * - Configuration is server-side only (explicit options or
 *   environment variables); nothing secret is accepted from or
 *   returned to clients.
 */

export type CaptionProviderName = 'none' | 'whisper-cli';

export interface CaptionProviderConfig {
  provider: CaptionProviderName;
  /** Path to the whisper-compatible binary (whisper-cli only). */
  whisperBin?: string;
  /** Model name passed through to the CLI (whisper-cli only). */
  whisperModel?: string;
  /** Language hint passed through to the CLI. */
  language?: string;
  timeoutMs?: number;
}

export interface CaptionGenerationResult {
  status: 'success' | 'unavailable' | 'error';
  provider: CaptionProviderName;
  cues?: CaptionCue[];
  error?: string;
}

export function captionProviderConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CaptionProviderConfig {
  const name = (env.SQUADFORGE_CAPTION_PROVIDER || 'none') as CaptionProviderName;
  return {
    provider: name === 'whisper-cli' ? 'whisper-cli' : 'none',
    whisperBin: env.SQUADFORGE_WHISPER_BIN || undefined,
    whisperModel: env.SQUADFORGE_WHISPER_MODEL || undefined,
    language: env.SQUADFORGE_CAPTION_LANGUAGE || undefined
  };
}

function findOnPath(binary: string): string | null {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    const candidate = path.join(dir, binary);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveWhisperBinary(config: CaptionProviderConfig): string | null {
  if (config.whisperBin) return fs.existsSync(config.whisperBin) ? config.whisperBin : null;
  return findOnPath('whisper') ?? findOnPath('whisper-cpp') ?? findOnPath('whisper-cli');
}

export async function generateCaptionsWithProvider(
  mediaPath: string,
  config: CaptionProviderConfig
): Promise<CaptionGenerationResult> {
  if (config.provider === 'none') {
    return {
      status: 'unavailable',
      provider: 'none',
      error: 'No caption provider is configured. Automatic captions are off; manual caption editing works without a provider.'
    };
  }
  if (!fs.existsSync(mediaPath)) {
    return { status: 'error', provider: config.provider, error: `Media file missing: ${mediaPath}` };
  }
  const bin = resolveWhisperBinary(config);
  if (!bin) {
    return {
      status: 'unavailable',
      provider: config.provider,
      error: 'The whisper-cli provider is selected but no whisper binary was found (set SQUADFORGE_WHISPER_BIN or install whisper on PATH). No captions were generated.'
    };
  }
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squadforge-captions-'));
  try {
    const args = [mediaPath, '--output_format', 'srt', '--output_dir', outDir];
    if (config.whisperModel) args.push('--model', config.whisperModel);
    if (config.language) args.push('--language', config.language);
    const { code, log } = await new Promise<{ code: number; log: string }>((resolve) => {
      const child = spawn(bin, args, { shell: false });
      let log = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), config.timeoutMs ?? 900_000);
      child.stderr?.on('data', (d) => (log += d.toString()));
      child.stdout?.on('data', (d) => (log += d.toString()));
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: -1, log: log + String(err) });
      });
      child.on('close', (c) => {
        clearTimeout(timer);
        resolve({ code: c ?? -1, log });
      });
    });
    if (code !== 0) {
      return {
        status: 'error',
        provider: config.provider,
        error: `Caption provider failed (exit ${code}): ${log.slice(-400)}`
      };
    }
    const srtName = `${path.parse(mediaPath).name}.srt`;
    const srtPath = path.join(outDir, srtName);
    if (!fs.existsSync(srtPath)) {
      return {
        status: 'error',
        provider: config.provider,
        error: `Caption provider exited 0 but produced no SRT file (${srtName}); nothing was imported.`
      };
    }
    const cues = parseSrt(fs.readFileSync(srtPath, 'utf8'));
    return { status: 'success', provider: config.provider, cues };
  } catch (e: any) {
    return { status: 'error', provider: config.provider, error: `Caption generation failed: ${e.message}` };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}
