import type {
  ClipEffect,
  ClipEffectInstance,
  ClipTransform,
  EffectType,
  Keyframe,
  TimelineClip,
  TransitionType
} from './types.js';

/**
 * Phase 28: modular effects, transitions and keyframe animation.
 *
 * One registry (EFFECT_DEFS) defines every adjustable effect: its
 * valid range, its neutral value, and the ffmpeg filter it renders
 * to. The exporter and the preview renderer both build their chains
 * through effectChainFor(), so a control can never change one output
 * without the other — no fake sliders.
 *
 * Keyframes animate a clip's transform. sampleKeyframes() is the
 * single interpolation implementation: the preview renderer samples
 * it directly, and the exporter compiles the same piecewise segments
 * into ffmpeg time expressions (buildTimeExpression), so both paths
 * agree at every instant.
 */

// ---------------------------------------------------------------- effects registry

export const LEGACY_EFFECT_FILTERS: Record<Exclude<ClipEffect, 'none'>, string> = {
  grayscale: 'hue=s=0',
  blur: 'boxblur=5',
  sharpen: 'unsharp=5:5:1.0',
  invert: 'negate'
};

interface EffectDef {
  min: number;
  max: number;
  /** Value that renders as a no-op (the filter is omitted). */
  neutral: number;
  filter: (value: number) => string;
}

const f3 = (v: number): string => String(Number(v.toFixed(3)));

export const EFFECT_DEFS: Record<EffectType, EffectDef> = {
  brightness: { min: -1, max: 1, neutral: 0, filter: (v) => `eq=brightness=${f3(v)}` },
  contrast: { min: 0, max: 3, neutral: 1, filter: (v) => `eq=contrast=${f3(v)}` },
  saturation: { min: 0, max: 3, neutral: 1, filter: (v) => `eq=saturation=${f3(v)}` },
  // -1 (cool) .. +1 (warm). ffmpeg's colortemperature names the
  // illuminant being corrected: a LOWER Kelvin warms the image.
  temperature: { min: -1, max: 1, neutral: 0, filter: (v) => `colortemperature=temperature=${Math.round(6500 - v * 3000)}` },
  blur: { min: 0, max: 20, neutral: 0, filter: (v) => `boxblur=${f3(v)}` },
  sharpen: { min: 0, max: 3, neutral: 0, filter: (v) => `unsharp=5:5:${f3(v)}` }
};

export function validateEffectInstance(instance: ClipEffectInstance): void {
  const def = EFFECT_DEFS[instance.type];
  if (!def) throw new Error(`Unknown effect type: ${instance.type}`);
  if (!Number.isFinite(instance.value) || instance.value < def.min || instance.value > def.max) {
    throw new Error(`Effect ${instance.type} value ${instance.value} is outside ${def.min}..${def.max}`);
  }
}

/**
 * The ordered filter chain for a clip: the legacy Phase 20 preset
 * first (unchanged), then the Phase 28 stack in array order.
 * Neutral-valued stack entries are omitted (they render identically).
 */
export function effectChainFor(clip: TimelineClip): string[] {
  const chain: string[] = [];
  if (clip.effect && clip.effect !== 'none') chain.push(LEGACY_EFFECT_FILTERS[clip.effect]);
  for (const instance of clip.effects ?? []) {
    validateEffectInstance(instance);
    const def = EFFECT_DEFS[instance.type];
    if (instance.value !== def.neutral) chain.push(def.filter(instance.value));
  }
  return chain;
}

// ---------------------------------------------------------------- transitions

export const XFADE_NAMES: Record<TransitionType, string> = {
  crossfade: 'fade',
  'fade-black': 'fadeblack',
  'fade-white': 'fadewhite',
  'wipe-left': 'wipeleft',
  'wipe-right': 'wiperight',
  'slide-left': 'slideleft',
  'slide-right': 'slideright',
  'zoom-in': 'zoomin'
};

export const TRANSITION_TYPES = Object.keys(XFADE_NAMES) as TransitionType[];

export function xfadeName(type: TransitionType | undefined): string {
  return XFADE_NAMES[type ?? 'crossfade'];
}

export function validateTransitionType(type: string): void {
  if (!TRANSITION_TYPES.includes(type as TransitionType)) {
    throw new Error(`Unknown transition type: ${type} (supported: ${TRANSITION_TYPES.join(', ')})`);
  }
}

// ---------------------------------------------------------------- keyframes

export type AnimatableProperty = 'x' | 'y' | 'scale' | 'rotationDeg' | 'opacity';
export const ANIMATABLE_PROPERTIES: AnimatableProperty[] = ['x', 'y', 'scale', 'rotationDeg', 'opacity'];

const PROPERTY_RANGES: Record<AnimatableProperty, { min: number; max: number }> = {
  x: { min: -100000, max: 100000 },
  y: { min: -100000, max: 100000 },
  scale: { min: 0.05, max: 4 },
  rotationDeg: { min: -360, max: 360 },
  opacity: { min: 0, max: 1 }
};

export function validateKeyframes(
  keyframes: Keyframe[],
  durationSec: number,
  options: { allowedProperties?: AnimatableProperty[]; owner: string }
): void {
  const allowed = options.allowedProperties ?? ANIMATABLE_PROPERTIES;
  const seenTimes = new Set<number>();
  for (const kf of keyframes) {
    if (!Number.isFinite(kf.timeSec) || kf.timeSec < 0 || kf.timeSec > durationSec + 1e-6) {
      throw new Error(`${options.owner}: keyframe time ${kf.timeSec}s is outside 0..${durationSec}s`);
    }
    if (seenTimes.has(kf.timeSec)) {
      throw new Error(`${options.owner}: duplicate keyframe at ${kf.timeSec}s`);
    }
    seenTimes.add(kf.timeSec);
    let defined = 0;
    for (const prop of ANIMATABLE_PROPERTIES) {
      const v = kf[prop];
      if (v === undefined) continue;
      if (!allowed.includes(prop)) {
        throw new Error(`${options.owner}: property ${prop} cannot be keyframed here`);
      }
      const range = PROPERTY_RANGES[prop];
      if (!Number.isFinite(v) || v < range.min || v > range.max) {
        throw new Error(`${options.owner}: keyframe ${prop}=${v} is outside ${range.min}..${range.max}`);
      }
      defined++;
    }
    if (defined === 0) throw new Error(`${options.owner}: keyframe at ${kf.timeSec}s defines no animatable property`);
    if (kf.easing !== undefined && kf.easing !== 'linear' && kf.easing !== 'smooth') {
      throw new Error(`${options.owner}: unknown easing ${kf.easing}`);
    }
  }
}

export function sortedKeyframes(keyframes: Keyframe[]): Keyframe[] {
  return [...keyframes].sort((a, b) => a.timeSec - b.timeSec);
}

interface KeyframePoint {
  t: number;
  v: number;
  easing: 'linear' | 'smooth';
}

function pointsFor(keyframes: Keyframe[], prop: AnimatableProperty): KeyframePoint[] {
  return sortedKeyframes(keyframes)
    .filter((kf) => kf[prop] !== undefined)
    .map((kf) => ({ t: kf.timeSec, v: kf[prop]!, easing: kf.easing ?? 'linear' }));
}

function interpolate(points: KeyframePoint[], t: number): number {
  if (t <= points[0].t) return points[0].v;
  if (t >= points[points.length - 1].t) return points[points.length - 1].v;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (t >= a.t && t <= b.t) {
      let u = (t - a.t) / (b.t - a.t);
      if (a.easing === 'smooth') u = u * u * (3 - 2 * u);
      return a.v + (b.v - a.v) * u;
    }
  }
  return points[points.length - 1].v;
}

/**
 * The effective transform of a clip at a clip-local time: base
 * transform with every keyframed property replaced by its
 * interpolated value.
 */
export function sampleKeyframes(keyframes: Keyframe[] | undefined, base: ClipTransform, localTimeSec: number): ClipTransform {
  if (!keyframes || keyframes.length === 0) return { ...base };
  const out: ClipTransform = { ...base, crop: base.crop ? { ...base.crop } : undefined };
  for (const prop of ANIMATABLE_PROPERTIES) {
    const points = pointsFor(keyframes, prop);
    if (points.length > 0) out[prop] = interpolate(points, localTimeSec);
  }
  return out;
}

export function hasKeyframedProperty(keyframes: Keyframe[] | undefined, prop: AnimatableProperty): boolean {
  return Boolean(keyframes?.some((kf) => kf[prop] !== undefined));
}

/**
 * Compile one property's keyframe track into an ffmpeg time
 * expression implementing EXACTLY the same piecewise interpolation
 * as interpolate() above (nested ifs; smooth = smoothstep). Times
 * are shifted by `timeOffset` so the expression can run on a stream
 * whose t is not clip-local (e.g. the overlay filter's output time).
 */
export function buildTimeExpression(
  keyframes: Keyframe[],
  prop: AnimatableProperty,
  fallbackValue: number,
  timeOffset: number = 0,
  timeVar: string = 't'
): string {
  const points = pointsFor(keyframes, prop);
  if (points.length === 0) return f3(fallbackValue);
  const num = (v: number): string => f3(v);
  const segment = (a: KeyframePoint, b: KeyframePoint): string => {
    const t0 = a.t + timeOffset;
    // The segment LENGTH is offset-invariant: (b.t - a.t), never shifted.
    const u = `((${timeVar}-${num(t0)})/${num(b.t - a.t)})`;
    const eased = a.easing === 'smooth' ? `(${u}*${u}*(3-2*${u}))` : u;
    return `(${num(a.v)}+(${num(b.v)}-${num(a.v)})*${eased})`;
  };
  let expr = num(points[points.length - 1].v);
  for (let i = points.length - 2; i >= 0; i--) {
    expr = `if(lt(${timeVar},${num(points[i + 1].t + timeOffset)}),${segment(points[i], points[i + 1])},${expr})`;
  }
  expr = `if(lt(${timeVar},${num(points[0].t + timeOffset)}),${num(points[0].v)},${expr})`;
  return expr;
}
