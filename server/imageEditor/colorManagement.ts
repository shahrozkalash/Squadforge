import type { GrayImage, PixelImage, PixelImage16, RgbaColor } from './types.js';

/**
 * Phase 50: professional color management for the graphics editor —
 * a first-class grayscale working representation, a genuine
 * 16-bit-per-channel workflow, and the conversion rules between
 * them and the Phase 19 8-bit RGBA `PixelImage`.
 *
 * Working assumption, stated plainly: every value in this engine is
 * an sRGB-encoded (gamma-encoded) sample, exactly as stored in the
 * source file or produced by earlier phases. No operation in the
 * engine linearizes gamma — luminance, blending and filtering are
 * all computed on the encoded values, which is the convention
 * Phases 19–49 already follow. This module does not invent a
 * color-managed pipeline on top of that; ICC profiles are carried
 * as data by the PNG codec (see imageCodec.ts), never applied.
 *
 * Luminance is Rec.601 (0.299 / 0.587 / 0.114) — the weights the
 * Phase 19 saturation/grayscale adjustments and the Phase 47
 * `luminance` helper already use — so the grayscale representation
 * agrees with the existing grayscale adjustment by construction.
 *
 * 8↔16 conversion rules (pinned by tests):
 *   upscale:   v16 = v8 * 257            (exact, lossless)
 *   downscale: v8  = round(v16 / 257)    (nearest; the exact inverse
 *              of upscale for every value that came from 8-bit, so
 *              8→16→8 is byte-exact for all 256 levels)
 */

// ---------------------------------------------------------------- grayscale

export function createGrayImage(width: number, height: number, fill = 0): GrayImage {
  if (width <= 0 || height <= 0) throw new Error(`Invalid image size ${width}x${height}`);
  const data = new Uint8ClampedArray(width * height);
  if (fill) data.fill(Math.min(255, Math.max(0, Math.round(fill))));
  return { width, height, data };
}

export function cloneGrayImage(img: GrayImage): GrayImage {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

export function getGray(img: GrayImage, x: number, y: number): number {
  return img.data[y * img.width + x];
}

export function setGray(img: GrayImage, x: number, y: number, v: number): void {
  img.data[y * img.width + x] = v;
}

/** Rec.601 luminance of one RGB triple — the engine's one luminance. */
export function luminance601(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Convert an RGBA image to the grayscale working representation:
 * one Rec.601 luminance sample per pixel, rounded with Math.round
 * (the same rounding the Phase 19 adjustments apply via clamp255).
 * Alpha is discarded — GrayImage has no alpha channel; the RGB
 * values are used exactly as stored, not premultiplied by alpha.
 */
export function rgbaToGrayscale(img: PixelImage): GrayImage {
  const out = createGrayImage(img.width, img.height);
  for (let i = 0, j = 0; i < img.data.length; i += 4, j++) {
    out.data[j] = Math.round(luminance601(img.data[i], img.data[i + 1], img.data[i + 2]));
  }
  return out;
}

/** Convert a grayscale image back to RGBA: channels replicate, alpha is opaque. */
export function grayscaleToRgba(img: GrayImage): PixelImage {
  const out: PixelImage = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.width * img.height * 4) };
  for (let j = 0, i = 0; j < img.data.length; j++, i += 4) {
    const v = img.data[j];
    out.data[i] = v;
    out.data[i + 1] = v;
    out.data[i + 2] = v;
    out.data[i + 3] = 255;
  }
  return out;
}

// ---------------------------------------------------------------- 16-bit

const clamp16 = (v: number) => Math.min(65535, Math.max(0, Math.round(v)));

/** 8→16 upscale of one sample: v * 257 (exact for all 256 levels). */
export function upscaleValueTo16(v: number): number {
  return Math.min(255, Math.max(0, Math.round(v))) * 257;
}

/** 16→8 downscale of one sample: round(v / 257), the exact inverse of upscaleValueTo16. */
export function downscaleValueTo8(v: number): number {
  return Math.min(255, Math.max(0, Math.round(Math.min(65535, Math.max(0, v)) / 257)));
}

/** `fill` channels are 16-bit samples (0..65535), despite the shared RgbaColor shape. */
export function createPixelImage16(width: number, height: number, fill?: RgbaColor): PixelImage16 {
  if (width <= 0 || height <= 0) throw new Error(`Invalid image size ${width}x${height}`);
  const data = new Uint16Array(width * height * 4);
  if (fill) {
    const px = [fill.r, fill.g, fill.b, fill.a];
    for (const v of px) {
      if (!Number.isFinite(v) || v < 0 || v > 65535) throw new Error(`Invalid 16-bit channel value: ${v}`);
    }
    for (let i = 0; i < data.length; i += 4) {
      data[i] = px[0];
      data[i + 1] = px[1];
      data[i + 2] = px[2];
      data[i + 3] = px[3];
    }
  }
  return { width, height, data };
}

export function clonePixelImage16(img: PixelImage16): PixelImage16 {
  return { width: img.width, height: img.height, data: new Uint16Array(img.data) };
}

/** Lossless 8→16 conversion: every sample is multiplied by 257. */
export function upscaleTo16(img: PixelImage): PixelImage16 {
  const out = createPixelImage16(img.width, img.height);
  for (let i = 0; i < img.data.length; i++) out.data[i] = img.data[i] * 257;
  return out;
}

/**
 * 16→8 conversion: every sample becomes round(v / 257). For samples
 * that came from `upscaleTo16` this is byte-exact; for genuinely
 * 16-bit samples it is a nearest-level quantization (the discarded
 * precision is the documented cost of returning to 8-bit).
 */
export function downscaleTo8(img: PixelImage16): PixelImage {
  const out: PixelImage = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.width * img.height * 4) };
  for (let i = 0; i < img.data.length; i++) out.data[i] = Math.round(img.data[i] / 257);
  return out;
}

/**
 * A real operation performed in 16-bit: multiply the RGB channels
 * by `gain`, computed and stored at 16-bit precision (alpha is
 * carried unchanged). Fractional results keep their sub-8-bit
 * precision in the returned image — e.g. 25957 × 0.5 = 12979, a
 * value no 8-bit upscale can represent (it is not a multiple of
 * 257). Results are rounded with Math.round and clamped to
 * 0..65535. The input is not mutated.
 */
export function applyGain16(img: PixelImage16, gain: number): PixelImage16 {
  if (!Number.isFinite(gain) || gain < 0) throw new Error(`Invalid gain: ${gain}`);
  const out = clonePixelImage16(img);
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = clamp16(out.data[i] * gain);
    out.data[i + 1] = clamp16(out.data[i + 1] * gain);
    out.data[i + 2] = clamp16(out.data[i + 2] * gain);
  }
  return out;
}

/**
 * A second operation performed in 16-bit: a separable box blur over
 * all four channels, accumulated in float at 16-bit precision and
 * rounded once at the end (edge pixels replicate — the Phase 47 box
 * blur's convention). Averaging two neighbouring 16-bit samples can
 * land between 8-bit levels (e.g. 25700 and 25957 average to 25786),
 * which is exactly the precision the 8-bit pipeline cannot hold.
 * The input is not mutated.
 */
export function boxBlur16(img: PixelImage16, radius: number): PixelImage16 {
  if (!Number.isInteger(radius) || radius < 0) throw new Error(`Invalid blur radius: ${radius}`);
  const out = clonePixelImage16(img);
  if (radius === 0) return out;
  const { width, height } = img;
  const taps = 2 * radius + 1;
  const clampIdx = (v: number, size: number) => Math.min(size - 1, Math.max(0, v));
  // Horizontal pass into float.
  const tmp = new Float64Array(img.data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          sum += img.data[(y * width + clampIdx(x + k, width)) * 4 + c];
        }
        tmp[(y * width + x) * 4 + c] = sum / taps;
      }
    }
  }
  // Vertical pass, rounding once at the end.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          sum += tmp[(clampIdx(y + k, height) * width + x) * 4 + c];
        }
        out.data[(y * width + x) * 4 + c] = clamp16(sum / taps);
      }
    }
  }
  return out;
}
