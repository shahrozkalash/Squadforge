import type { PixelImage } from './types.js';
import { createPixelImage } from './imageCore.js';

/**
 * Factory Phase F8 — the photo (Lightroom-class) develop engine.
 *
 * Until F8 the platform had no photo workflow at all: the image
 * engine (Phases 19, 44–60) edits layered projects destructively or
 * through per-layer effect stacks, but nothing modelled what a photo
 * editor actually is — a catalog of originals plus, per photo, a set
 * of *develop settings as data* that are applied non-destructively
 * at export time. This module is that develop layer, built on the
 * image engine's `PixelImage` and codecs (photoProject.ts carries
 * the catalog/batch side).
 *
 * Develop settings model (all fields optional on input; resolution
 * fills the neutral defaults and validates strictly):
 *
 *   exposure     stops, -5..5 — a 2^EV gain
 *   contrast     -100..100 — tan-curve contrast around mid-gray
 *   highlights   -100..100 — luma-weighted lift/cut of bright tones
 *   shadows      -100..100 — luma-weighted lift/cut of dark tones
 *   temperature  -100..100 — white balance: warm (+) / cool (−)
 *   tint         -100..100 — white balance: magenta (+) / green (−)
 *   saturation   -100..100 — the engine's luma-mix saturation ×100
 *   vibrance     -100..100 — saturation that spares already-saturated
 *                pixels (boosts the muted ones most)
 *   hsl          per-channel adjustments for the 8 standard hue
 *                ranges (red, orange, yellow, green, aqua, blue,
 *                purple, magenta), each { hue: -30..30 degrees,
 *                saturation: -100..100, luminance: -100..100 },
 *                applied with smooth hue-proximity weights
 *
 * The pipeline is a pure function PixelImage -> PixelImage in float,
 * in this fixed order: white balance → exposure → contrast →
 * highlights/shadows → vibrance → saturation → HSL. It never mutates
 * its input and never touches alpha. Like the rest of the engine it
 * works on sRGB-encoded values as stored (the Phase 50 documented
 * working assumption — no gamma linearization is claimed), and it is
 * fully deterministic: the same settings applied to the same pixels
 * produce byte-identical output, which is what makes develop a
 * non-destructive *data* workflow rather than an edit history.
 *
 * Honest scope: input formats are exactly the engine's verified flat
 * codecs — PNG, JPEG, BMP, TIFF (photoProject.ts enforces this and
 * refuses camera RAW by name). There is no lens correction, no local
 * adjustment brushing, no noise reduction, and no highlight/shadow
 * *recovery* from clipped data — clipped channels stay clipped, as
 * the math below makes plain.
 */

export const HSL_CHANNELS = [
  'red',
  'orange',
  'yellow',
  'green',
  'aqua',
  'blue',
  'purple',
  'magenta'
] as const;

export type HslChannel = (typeof HSL_CHANNELS)[number];

/** Centre hue (degrees) of each HSL channel range. */
export const HSL_CHANNEL_CENTERS: Record<HslChannel, number> = {
  red: 0,
  orange: 30,
  yellow: 60,
  green: 120,
  aqua: 180,
  blue: 240,
  purple: 275,
  magenta: 315
};

export interface HslChannelAdjustment {
  /** Hue shift in degrees, -30..30. */
  hue: number;
  /** Saturation scale, -100..100 (multiplies by 1 + v/100). */
  saturation: number;
  /** Luminance scale, -100..100 (multiplies by 1 + v/100). */
  luminance: number;
}

export interface DevelopSettings {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  temperature: number;
  tint: number;
  saturation: number;
  vibrance: number;
  hsl: Record<HslChannel, HslChannelAdjustment>;
}

/** Caller-facing partial form: any subset of settings/channels/fields. */
export interface DevelopSettingsInput {
  exposure?: number;
  contrast?: number;
  highlights?: number;
  shadows?: number;
  temperature?: number;
  tint?: number;
  saturation?: number;
  vibrance?: number;
  hsl?: Partial<Record<HslChannel, Partial<HslChannelAdjustment>>>;
}

const SCALAR_RANGES: Record<string, [number, number]> = {
  exposure: [-5, 5],
  contrast: [-100, 100],
  highlights: [-100, 100],
  shadows: [-100, 100],
  temperature: [-100, 100],
  tint: [-100, 100],
  saturation: [-100, 100],
  vibrance: [-100, 100]
};

const HSL_RANGES: Record<keyof HslChannelAdjustment, [number, number]> = {
  hue: [-30, 30],
  saturation: [-100, 100],
  luminance: [-100, 100]
};

function neutralChannel(): HslChannelAdjustment {
  return { hue: 0, saturation: 0, luminance: 0 };
}

function neutralHsl(): Record<HslChannel, HslChannelAdjustment> {
  const out = {} as Record<HslChannel, HslChannelAdjustment>;
  for (const channel of HSL_CHANNELS) out[channel] = neutralChannel();
  return out;
}

/** The neutral develop settings: every adjustment at zero. */
export function neutralDevelopSettings(): DevelopSettings {
  return {
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    temperature: 0,
    tint: 0,
    saturation: 0,
    vibrance: 0,
    hsl: neutralHsl()
  };
}

function checkNumber(name: string, value: unknown, range: [number, number]): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Develop setting "${name}" must be a finite number (got ${String(value)})`);
  }
  if (value < range[0] || value > range[1]) {
    throw new Error(`Develop setting "${name}" must be in the range [${range[0]}, ${range[1]}] (got ${value})`);
  }
  return value;
}

/**
 * Validates partial develop settings and returns the complete,
 * resolved settings object (a fresh deep copy — mutating the result
 * never mutates the input or any shared default). Unknown keys,
 * unknown HSL channels, non-finite values and out-of-range values
 * all throw named errors: bad develop data fails at definition time,
 * never mid-export.
 */
export function resolveDevelopSettings(input?: DevelopSettingsInput | null): DevelopSettings {
  const out = neutralDevelopSettings();
  if (input === undefined || input === null) return out;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Develop settings must be an object');
  }
  for (const key of Object.keys(input)) {
    if (key !== 'hsl' && !(key in SCALAR_RANGES)) {
      throw new Error(`Unknown develop setting: "${key}"`);
    }
  }
  for (const key of Object.keys(SCALAR_RANGES) as Array<keyof typeof SCALAR_RANGES>) {
    const value = (input as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = checkNumber(key, value, SCALAR_RANGES[key]);
  }
  if (input.hsl !== undefined) {
    if (typeof input.hsl !== 'object' || input.hsl === null || Array.isArray(input.hsl)) {
      throw new Error('Develop setting "hsl" must be an object keyed by channel name');
    }
    for (const channel of Object.keys(input.hsl)) {
      if (!(HSL_CHANNELS as readonly string[]).includes(channel)) {
        throw new Error(`Unknown HSL channel in develop settings: "${channel}" (expected one of ${HSL_CHANNELS.join(', ')})`);
      }
    }
    for (const channel of HSL_CHANNELS) {
      const partial = input.hsl[channel];
      if (partial === undefined) continue;
      if (typeof partial !== 'object' || partial === null || Array.isArray(partial)) {
        throw new Error(`Develop HSL channel "${channel}" must be an object`);
      }
      for (const field of Object.keys(partial)) {
        if (!(field in HSL_RANGES)) {
          throw new Error(`Unknown develop HSL field: "${channel}.${field}"`);
        }
      }
      for (const field of Object.keys(HSL_RANGES) as Array<keyof HslChannelAdjustment>) {
        const value = partial[field];
        if (value !== undefined) {
          out.hsl[channel][field] = checkNumber(`hsl.${channel}.${field}`, value, HSL_RANGES[field]);
        }
      }
    }
  }
  return out;
}

/** True when the settings change no pixel (all adjustments zero). */
export function isNeutralDevelopSettings(settings: DevelopSettings): boolean {
  for (const key of Object.keys(SCALAR_RANGES) as Array<keyof typeof SCALAR_RANGES>) {
    if (settings[key] !== 0) return false;
  }
  for (const channel of HSL_CHANNELS) {
    const adj = settings.hsl[channel];
    if (adj.hue !== 0 || adj.saturation !== 0 || adj.luminance !== 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------- pipeline

/** Rec.601 luminance, the weights the image engine's saturation uses. */
function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Standard RGB (0..1) -> HSL conversion (h in degrees, s/l in 0..1). */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  if (s === 0) return [l, l, l];
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
}

function circularHueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Applies develop settings to an image and returns the developed
 * image. The input is never mutated; alpha is carried through
 * untouched. Neutral settings return a byte-identical copy.
 */
export function applyDevelopSettings(img: PixelImage, settingsInput?: DevelopSettingsInput | null): PixelImage {
  const settings = resolveDevelopSettings(settingsInput ?? undefined);
  const out = createPixelImage(img.width, img.height);
  const src = img.data;
  const dst = out.data;

  const tempGainR = 1 + 0.3 * (settings.temperature / 100);
  const tempGainB = 1 - 0.3 * (settings.temperature / 100);
  const tintGainG = 1 - 0.2 * (settings.tint / 100);
  const tintGainRB = 1 + 0.1 * (settings.tint / 100);
  const exposureGain = Math.pow(2, settings.exposure);
  const contrastFactor = Math.tan(((settings.contrast / 100) + 1) * (Math.PI / 4));
  const shadowLift = settings.shadows / 100;
  const highlightLift = settings.highlights / 100;
  const vibranceAmount = settings.vibrance / 100;
  const saturationAmount = settings.saturation / 100;
  const hasHsl = HSL_CHANNELS.some((channel) => {
    const adj = settings.hsl[channel];
    return adj.hue !== 0 || adj.saturation !== 0 || adj.luminance !== 0;
  });

  for (let i = 0; i < src.length; i += 4) {
    let r = src[i] / 255;
    let g = src[i + 1] / 255;
    let b = src[i + 2] / 255;

    // 1. White balance.
    r *= tempGainR * tintGainRB;
    g *= tintGainG;
    b *= tempGainB * tintGainRB;

    // 2. Exposure.
    r *= exposureGain;
    g *= exposureGain;
    b *= exposureGain;

    // 3. Contrast around mid-gray.
    if (settings.contrast !== 0) {
      r = (r - 0.5) * contrastFactor + 0.5;
      g = (g - 0.5) * contrastFactor + 0.5;
      b = (b - 0.5) * contrastFactor + 0.5;
    }

    // 4. Highlights / shadows: a luma-weighted lift applied equally
    // to all channels, so hue is preserved while tones move.
    if (shadowLift !== 0 || highlightLift !== 0) {
      const lum = clamp01(luminance(r, g, b));
      const delta = shadowLift * 0.35 * (1 - lum) * (1 - lum) + highlightLift * 0.35 * lum * lum;
      r += delta;
      g += delta;
      b += delta;
    }

    // 5. Vibrance, then saturation — both luma-mix adjustments in
    // the engine's saturation style; vibrance scales its amount by
    // how unsaturated the pixel already is.
    if (vibranceAmount !== 0 || saturationAmount !== 0) {
      const gray = luminance(r, g, b);
      if (vibranceAmount !== 0) {
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max <= 0 ? 0 : (max - min) / max;
        const eff = vibranceAmount >= 0 ? vibranceAmount * (1 - sat) : vibranceAmount;
        const f = 1 + eff;
        r = gray + (r - gray) * f;
        g = gray + (g - gray) * f;
        b = gray + (b - gray) * f;
      }
      if (saturationAmount !== 0) {
        const gray2 = luminance(r, g, b);
        const f = 1 + saturationAmount;
        r = gray2 + (r - gray2) * f;
        g = gray2 + (g - gray2) * f;
        b = gray2 + (b - gray2) * f;
      }
    }

    // 6. Per-channel HSL, weighted by hue proximity to each
    // channel's centre. Near-gray pixels (undefined hue) are left
    // alone, as in real develop tools.
    if (hasHsl) {
      const [h, s, l] = rgbToHsl(clamp01(r), clamp01(g), clamp01(b));
      if (s >= 0.02) {
        let weightSum = 0;
        let hueShift = 0;
        let satAdj = 0;
        let lumAdj = 0;
        for (const channel of HSL_CHANNELS) {
          const w = Math.max(0, 1 - circularHueDistance(h, HSL_CHANNEL_CENTERS[channel]) / 60);
          if (w === 0) continue;
          const adj = settings.hsl[channel];
          weightSum += w;
          hueShift += w * adj.hue;
          satAdj += w * (adj.saturation / 100);
          lumAdj += w * (adj.luminance / 100);
        }
        if (weightSum > 0) {
          const denom = Math.max(1, weightSum);
          const [nr, ng, nb] = hslToRgb(
            h + hueShift / denom,
            clamp01(s * (1 + satAdj / denom)),
            clamp01(l * (1 + lumAdj / denom))
          );
          r = nr;
          g = ng;
          b = nb;
        }
      }
    }

    dst[i] = Math.round(clamp01(r) * 255);
    dst[i + 1] = Math.round(clamp01(g) * 255);
    dst[i + 2] = Math.round(clamp01(b) * 255);
    dst[i + 3] = src[i + 3];
  }
  return out;
}
