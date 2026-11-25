import { detectFfmpeg } from './mediaProbe.js';
import { detectEncoders, type EncoderInfo } from './hwAccel.js';
import type { ExportSettings, VideoProject } from './types.js';
import { defaultExportSettings } from './videoExporter.js';

/**
 * Phase 30: export presets and render capabilities. A preset is a
 * resolution + bitrate envelope; the project's frame rate is kept
 * unless explicitly overridden, and "4K" is offered because the
 * pipeline genuinely renders and validates it — on a small project it
 * is an upscale, which the export notes state.
 */

export interface ExportPreset {
  name: string;
  label: string;
  width: number;
  height: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
}

export const EXPORT_PRESETS: ExportPreset[] = [
  { name: 'source', label: 'Source resolution', width: 0, height: 0, videoBitrateKbps: 0, audioBitrateKbps: 160 },
  { name: '480p', label: '480p SD', width: 854, height: 480, videoBitrateKbps: 2500, audioBitrateKbps: 128 },
  { name: '720p', label: '720p HD', width: 1280, height: 720, videoBitrateKbps: 5000, audioBitrateKbps: 160 },
  { name: '1080p', label: '1080p Full HD', width: 1920, height: 1080, videoBitrateKbps: 9000, audioBitrateKbps: 192 },
  { name: '2160p', label: '4K UHD', width: 3840, height: 2160, videoBitrateKbps: 25000, audioBitrateKbps: 192 }
];

export function getPreset(name: string): ExportPreset {
  const preset = EXPORT_PRESETS.find((p) => p.name === name);
  if (!preset) throw new Error(`Unknown export preset '${name}'. Known: ${EXPORT_PRESETS.map((p) => p.name).join(', ')}`);
  return preset;
}

/**
 * Build export settings from a preset plus explicit overrides.
 * Overrides always win over the preset; the preset always wins over
 * the project defaults (except 'source', which IS the project).
 */
export function settingsForPreset(
  project: VideoProject,
  presetName: string,
  overrides: Partial<ExportSettings> = {}
): ExportSettings {
  const preset = getPreset(presetName);
  const base = defaultExportSettings(project);
  const fromPreset: ExportSettings =
    preset.name === 'source'
      ? { ...base, audioBitrateKbps: preset.audioBitrateKbps }
      : {
          ...base,
          width: preset.width,
          height: preset.height,
          videoBitrateKbps: preset.videoBitrateKbps,
          audioBitrateKbps: preset.audioBitrateKbps
        };
  return { ...fromPreset, ...overrides, preset: preset.name, format: 'mp4', audioCodec: 'aac' };
}

export interface RenderCapabilities {
  ffmpegAvailable: boolean;
  presets: ExportPreset[];
  encoders: EncoderInfo[];
  /** The encoder 'auto' would pick right now, or null for software. */
  autoEncoder: string | null;
  notes: string[];
}

export async function renderCapabilities(): Promise<RenderCapabilities> {
  const ffmpeg = detectFfmpeg();
  if (!ffmpeg) {
    return {
      ffmpegAvailable: false,
      presets: EXPORT_PRESETS,
      encoders: [],
      autoEncoder: null,
      notes: ['ffmpeg is not available on this host; rendering is unavailable.']
    };
  }
  const encoders = await detectEncoders(ffmpeg);
  const hw = encoders.find((e) => e.kind !== 'software' && e.verified);
  return {
    ffmpegAvailable: true,
    presets: EXPORT_PRESETS,
    encoders,
    autoEncoder: hw ? hw.encoder : null,
    notes: hw
      ? [`Hardware encoding available via ${hw.encoder} (probe-verified).`]
      : ['No probe-verified hardware encoder on this host; renders use software libx264.']
  };
}
