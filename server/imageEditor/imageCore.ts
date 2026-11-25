import * as crypto from 'crypto';
import type {
  ImageProject,
  Layer,
  PixelImage,
  Point,
  Rect,
  RgbaColor,
  SerializedProject,
  Viewport
} from './types.js';
import { drawTextBitmap } from './bitmapFont.js';

/**
 * Phase 19: the image-editing core. Every function performs real math
 * on real RGBA buffers: alpha compositing for layers, rasterization
 * for tools, resampling for resize, exact rotations, per-pixel color
 * adjustments, snapshot history for undo/redo, and JSON+base64 project
 * persistence. Modular by design — new tools/adjustments slot in as
 * additional pure functions over the same types.
 */

export function createPixelImage(width: number, height: number, fill?: RgbaColor): PixelImage {
  if (width <= 0 || height <= 0) throw new Error(`Invalid image size ${width}x${height}`);
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = fill.r;
      data[i + 1] = fill.g;
      data[i + 2] = fill.b;
      data[i + 3] = fill.a;
    }
  }
  return { width, height, data };
}

export function clonePixelImage(img: PixelImage): PixelImage {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

export function getPixel(img: PixelImage, x: number, y: number): RgbaColor {
  const i = (y * img.width + x) * 4;
  return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: img.data[i + 3] };
}

export function setPixel(img: PixelImage, x: number, y: number, c: RgbaColor): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = c.r;
  img.data[i + 1] = c.g;
  img.data[i + 2] = c.b;
  img.data[i + 3] = c.a;
}

/** Source-over alpha blend of one pixel onto a destination buffer at index i. */
function blendOver(dst: Uint8ClampedArray, i: number, sr: number, sg: number, sb: number, sa: number): void {
  const da = dst[i + 3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) {
    dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 0;
    return;
  }
  dst[i] = Math.round((sr * sa + dst[i] * da * (1 - sa)) / outA);
  dst[i + 1] = Math.round((sg * sa + dst[i + 1] * da * (1 - sa)) / outA);
  dst[i + 2] = Math.round((sb * sa + dst[i + 2] * da * (1 - sa)) / outA);
  dst[i + 3] = Math.round(outA * 255);
}

// ---------------------------------------------------------------- layers

export function createProject(width: number, height: number, background?: RgbaColor): ImageProject {
  const layer: Layer = {
    id: crypto.randomUUID(),
    name: 'Background',
    visible: true,
    opacity: 1,
    image: createPixelImage(width, height, background)
  };
  return { width, height, layers: [layer], activeLayerId: layer.id };
}

export function addLayer(project: ImageProject, name?: string): Layer {
  const layer: Layer = {
    id: crypto.randomUUID(),
    name: name || `Layer ${project.layers.length + 1}`,
    visible: true,
    opacity: 1,
    image: createPixelImage(project.width, project.height)
  };
  project.layers.push(layer);
  project.activeLayerId = layer.id;
  return layer;
}

export function getLayer(project: ImageProject, layerId: string): Layer {
  const layer = project.layers.find((l) => l.id === layerId);
  if (!layer) throw new Error(`Layer not found: ${layerId}`);
  return layer;
}

export function removeLayer(project: ImageProject, layerId: string): void {
  const idx = project.layers.findIndex((l) => l.id === layerId);
  if (idx === -1) throw new Error(`Layer not found: ${layerId}`);
  if (project.layers.length === 1) throw new Error('Cannot remove the last layer');
  project.layers.splice(idx, 1);
  if (project.activeLayerId === layerId) {
    project.activeLayerId = project.layers[Math.max(0, idx - 1)].id;
  }
}

/** Move a layer in the stack; toIndex 0 = bottom. */
export function moveLayer(project: ImageProject, layerId: string, toIndex: number): void {
  const idx = project.layers.findIndex((l) => l.id === layerId);
  if (idx === -1) throw new Error(`Layer not found: ${layerId}`);
  if (toIndex < 0 || toIndex >= project.layers.length) throw new Error(`Layer index out of range: ${toIndex}`);
  const [layer] = project.layers.splice(idx, 1);
  project.layers.splice(toIndex, 0, layer);
}

export function setLayerVisibility(project: ImageProject, layerId: string, visible: boolean): void {
  getLayer(project, layerId).visible = visible;
}

export function setLayerOpacity(project: ImageProject, layerId: string, opacity: number): void {
  if (opacity < 0 || opacity > 1) throw new Error(`Opacity out of range: ${opacity}`);
  getLayer(project, layerId).opacity = opacity;
}

/** Flatten visible layers (bottom → top) into a single image. */
export function composite(project: ImageProject): PixelImage {
  const out = createPixelImage(project.width, project.height);
  for (const layer of project.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const src = layer.image.data;
    for (let p = 0; p < src.length; p += 4) {
      const sa = (src[p + 3] / 255) * layer.opacity;
      if (sa <= 0) continue;
      blendOver(out.data, p, src[p], src[p + 1], src[p + 2], sa);
    }
  }
  return out;
}

// ---------------------------------------------------------------- tools

function inSelection(x: number, y: number, selection?: Rect | null): boolean {
  if (!selection) return true;
  return x >= selection.x && y >= selection.y && x < selection.x + selection.width && y < selection.y + selection.height;
}

function paintDot(img: PixelImage, cx: number, cy: number, radius: number, color: RgbaColor, erase: boolean, selection?: Rect | null): void {
  const r = Math.max(0.5, radius);
  const x0 = Math.floor(cx - r);
  const x1 = Math.ceil(cx + r);
  const y0 = Math.floor(cy - r);
  const y1 = Math.ceil(cy + r);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      if (!inSelection(x, y, selection)) continue;
      const d = Math.hypot(x - cx, y - cy);
      if (d > r) continue;
      const i = (y * img.width + x) * 4;
      if (erase) {
        const falloff = d >= r ? 0 : 1;
        img.data[i + 3] = Math.round(img.data[i + 3] * (1 - falloff));
        if (img.data[i + 3] === 0) {
          img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
        }
      } else {
        blendOver(img.data, i, color.r, color.g, color.b, color.a / 255);
      }
    }
  }
}

/** Brush stroke along a polyline; dots are interpolated so fast strokes stay continuous. */
export function brushStroke(
  project: ImageProject,
  layerId: string,
  points: Point[],
  radius: number,
  color: RgbaColor,
  selection?: Rect | null
): void {
  const layer = getLayer(project, layerId);
  paintStroke(layer.image, points, radius, color, false, selection);
}

/** Eraser stroke: reduces alpha along the path (real erase, not painting background color). */
export function eraserStroke(
  project: ImageProject,
  layerId: string,
  points: Point[],
  radius: number,
  selection?: Rect | null
): void {
  const layer = getLayer(project, layerId);
  paintStroke(layer.image, points, radius, { r: 0, g: 0, b: 0, a: 0 }, true, selection);
}

function paintStroke(img: PixelImage, points: Point[], radius: number, color: RgbaColor, erase: boolean, selection?: Rect | null): void {
  if (points.length === 0) return;
  let prev = points[0];
  paintDot(img, prev.x, prev.y, radius, color, erase, selection);
  for (let s = 1; s < points.length; s++) {
    const cur = points[s];
    const dist = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, radius / 2)));
    for (let k = 1; k <= steps; k++) {
      paintDot(img, prev.x + ((cur.x - prev.x) * k) / steps, prev.y + ((cur.y - prev.y) * k) / steps, radius, color, erase, selection);
    }
    prev = cur;
  }
}

export function fillRect(project: ImageProject, layerId: string, rect: Rect, color: RgbaColor, selection?: Rect | null): void {
  const img = getLayer(project, layerId).image;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      if (!inSelection(x, y, selection)) continue;
      const i = (y * img.width + x) * 4;
      if (x >= 0 && y >= 0 && x < img.width && y < img.height) {
        blendOver(img.data, i, color.r, color.g, color.b, color.a / 255);
      }
    }
  }
}

export function drawEllipse(project: ImageProject, layerId: string, rect: Rect, color: RgbaColor, selection?: Rect | null): void {
  const img = getLayer(project, layerId).image;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const rx = rect.width / 2;
  const ry = rect.height / 2;
  if (rx <= 0 || ry <= 0) return;
  for (let y = Math.floor(rect.y); y < rect.y + rect.height; y++) {
    for (let x = Math.floor(rect.x); x < rect.x + rect.width; x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      if (nx * nx + ny * ny <= 1 && inSelection(x, y, selection)) {
        const i = (y * img.width + x) * 4;
        if (x >= 0 && y >= 0 && x < img.width && y < img.height) {
          blendOver(img.data, i, color.r, color.g, color.b, color.a / 255);
        }
      }
    }
  }
}

export function drawLine(project: ImageProject, layerId: string, from: Point, to: Point, width: number, color: RgbaColor, selection?: Rect | null): void {
  const img = getLayer(project, layerId).image;
  paintStroke(img, [from, to], width / 2, color, false, selection);
}

/** Rasterize text with the built-in 5x7 bitmap font (A–Z, 0–9, basic punctuation). */
export function drawText(
  project: ImageProject,
  layerId: string,
  origin: Point,
  text: string,
  scale: number,
  color: RgbaColor,
  selection?: Rect | null
): void {
  const img = getLayer(project, layerId).image;
  drawTextBitmap(
    (x, y) => {
      if (!inSelection(x, y, selection)) return;
      const i = (y * img.width + x) * 4;
      if (x >= 0 && y >= 0 && x < img.width && y < img.height) {
        blendOver(img.data, i, color.r, color.g, color.b, color.a / 255);
      }
    },
    origin,
    text,
    Math.max(1, Math.floor(scale))
  );
}

// ---------------------------------------------------------------- transforms

/** Crop every layer to the rect; the project shrinks to the rect size. */
export function cropProject(project: ImageProject, rect: Rect): void {
  if (rect.width <= 0 || rect.height <= 0) throw new Error('Crop rect must have positive size');
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > project.width || rect.y + rect.height > project.height) {
    throw new Error('Crop rect must lie inside the image');
  }
  for (const layer of project.layers) {
    const out = createPixelImage(rect.width, rect.height);
    for (let y = 0; y < rect.height; y++) {
      for (let x = 0; x < rect.width; x++) {
        const c = getPixel(layer.image, rect.x + x, rect.y + y);
        setPixel(out, x, y, c);
      }
    }
    layer.image = out;
  }
  project.width = rect.width;
  project.height = rect.height;
}

/** Bilinear resample of a single image. */
export function resizeImage(img: PixelImage, newWidth: number, newHeight: number): PixelImage {
  if (newWidth <= 0 || newHeight <= 0) throw new Error(`Invalid resize target ${newWidth}x${newHeight}`);
  const out = createPixelImage(newWidth, newHeight);
  const xScale = img.width / newWidth;
  const yScale = img.height / newHeight;
  for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
      const sx = (x + 0.5) * xScale - 0.5;
      const sy = (y + 0.5) * yScale - 0.5;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const sample = (xx: number, yy: number): RgbaColor =>
        getPixel(img, Math.min(img.width - 1, Math.max(0, xx)), Math.min(img.height - 1, Math.max(0, yy)));
      const c00 = sample(x0, y0);
      const c10 = sample(x0 + 1, y0);
      const c01 = sample(x0, y0 + 1);
      const c11 = sample(x0 + 1, y0 + 1);
      const mix = (a: number, b: number, c: number, d: number) =>
        Math.round(a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy);
      setPixel(out, x, y, {
        r: mix(c00.r, c10.r, c01.r, c11.r),
        g: mix(c00.g, c10.g, c01.g, c11.g),
        b: mix(c00.b, c10.b, c01.b, c11.b),
        a: mix(c00.a, c10.a, c01.a, c11.a)
      });
    }
  }
  return out;
}

export function resizeProject(project: ImageProject, newWidth: number, newHeight: number): void {
  for (const layer of project.layers) {
    layer.image = resizeImage(layer.image, newWidth, newHeight);
  }
  project.width = newWidth;
  project.height = newHeight;
}

/** Exact 90°-step rotation (no resampling error). */
export function rotateImage(img: PixelImage, degrees: 90 | 180 | 270): PixelImage {
  if (degrees === 180) {
    const out = createPixelImage(img.width, img.height);
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        setPixel(out, img.width - 1 - x, img.height - 1 - y, getPixel(img, x, y));
      }
    }
    return out;
  }
  const out = createPixelImage(img.height, img.width);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (degrees === 90) setPixel(out, img.height - 1 - y, x, getPixel(img, x, y));
      else setPixel(out, y, img.width - 1 - x, getPixel(img, x, y));
    }
  }
  return out;
}

export function rotateProject(project: ImageProject, degrees: 90 | 180 | 270): void {
  for (const layer of project.layers) {
    layer.image = rotateImage(layer.image, degrees);
  }
  if (degrees !== 180) {
    const t = project.width;
    project.width = project.height;
    project.height = t;
  }
}

export function flipImage(img: PixelImage, horizontal: boolean): PixelImage {
  const out = createPixelImage(img.width, img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      setPixel(out, horizontal ? img.width - 1 - x : x, horizontal ? y : img.height - 1 - y, getPixel(img, x, y));
    }
  }
  return out;
}

// ---------------------------------------------------------------- adjustments

type PixelFn = (c: RgbaColor) => RgbaColor;

function applyAdjustment(project: ImageProject, layerId: string, fn: PixelFn, selection?: Rect | null): void {
  const img = getLayer(project, layerId).image;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (!inSelection(x, y, selection)) continue;
      setPixel(img, x, y, fn(getPixel(img, x, y)));
    }
  }
}

const clamp255 = (v: number) => Math.min(255, Math.max(0, Math.round(v)));

/** brightness: -255..255 added; contrast: -100..100 (factor curve). */
export function adjustBrightnessContrast(
  project: ImageProject,
  layerId: string,
  brightness: number,
  contrast: number,
  selection?: Rect | null
): void {
  const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  applyAdjustment(
    project,
    layerId,
    (c) => ({
      r: clamp255(factor * (c.r - 128) + 128 + brightness),
      g: clamp255(factor * (c.g - 128) + 128 + brightness),
      b: clamp255(factor * (c.b - 128) + 128 + brightness),
      a: c.a
    }),
    selection
  );
}

export function adjustSaturation(project: ImageProject, layerId: string, amount: number, selection?: Rect | null): void {
  // amount: -1 (grayscale) .. 1 (double saturation)
  applyAdjustment(
    project,
    layerId,
    (c) => {
      const gray = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
      const f = 1 + amount;
      return {
        r: clamp255(gray + (c.r - gray) * f),
        g: clamp255(gray + (c.g - gray) * f),
        b: clamp255(gray + (c.b - gray) * f),
        a: c.a
      };
    },
    selection
  );
}

export function invert(project: ImageProject, layerId: string, selection?: Rect | null): void {
  applyAdjustment(project, layerId, (c) => ({ r: 255 - c.r, g: 255 - c.g, b: 255 - c.b, a: c.a }), selection);
}

export function grayscale(project: ImageProject, layerId: string, selection?: Rect | null): void {
  adjustSaturation(project, layerId, -1, selection);
}

// ---------------------------------------------------------------- history

/**
 * Snapshot-based undo/redo. Each commit stores a deep copy of the
 * project (bounded); undo/redo swap the live project with snapshots.
 * Snapshots are real pixel data — memory cost is honest and capped.
 */
export class HistoryStack {
  private undoStack: SerializedProject[] = [];
  private redoStack: SerializedProject[] = [];
  constructor(private readonly limit: number = 30) {}

  commit(project: ImageProject): void {
    this.undoStack.push(serializeProject(project));
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(project: ImageProject): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(serializeProject(project));
    restoreInto(project, deserializeProject(prev));
    return true;
  }

  redo(project: ImageProject): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(serializeProject(project));
    restoreInto(project, deserializeProject(next));
    return true;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}

function restoreInto(target: ImageProject, source: ImageProject): void {
  target.width = source.width;
  target.height = source.height;
  target.layers = source.layers;
  target.activeLayerId = source.activeLayerId;
}

// ---------------------------------------------------------------- persistence

export function serializeProject(project: ImageProject): SerializedProject {
  return {
    format: 'squadforge-image-project',
    version: 1,
    width: project.width,
    height: project.height,
    activeLayerId: project.activeLayerId,
    layers: project.layers.map((l) => ({
      id: l.id,
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      pixelsBase64: Buffer.from(l.image.data).toString('base64')
    }))
  };
}

export function deserializeProject(data: SerializedProject): ImageProject {
  if (!data || data.format !== 'squadforge-image-project' || data.version !== 1) {
    throw new Error('Not a SquadForge image project (bad format/version)');
  }
  if (!Array.isArray(data.layers) || data.layers.length === 0) {
    throw new Error('Project has no layers');
  }
  const expected = data.width * data.height * 4;
  const layers: Layer[] = data.layers.map((l) => {
    const buf = Buffer.from(l.pixelsBase64, 'base64');
    if (buf.length !== expected) {
      throw new Error(`Layer "${l.name}" pixel data size mismatch: ${buf.length} != ${expected}`);
    }
    return {
      id: l.id,
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      image: { width: data.width, height: data.height, data: new Uint8ClampedArray(buf) }
    };
  });
  return { width: data.width, height: data.height, layers, activeLayerId: data.activeLayerId };
}

// ---------------------------------------------------------------- viewport

/** Canvas viewport math: zoom around a screen anchor, pan, conversions. */
export function screenToImage(vp: Viewport, sx: number, sy: number): Point {
  return { x: (sx - vp.panX) / vp.zoom, y: (sy - vp.panY) / vp.zoom };
}

export function imageToScreen(vp: Viewport, ix: number, iy: number): Point {
  return { x: ix * vp.zoom + vp.panX, y: iy * vp.zoom + vp.panY };
}

export function zoomAt(vp: Viewport, anchorScreen: Point, factor: number): Viewport {
  const newZoom = Math.min(32, Math.max(0.05, vp.zoom * factor));
  const img = screenToImage(vp, anchorScreen.x, anchorScreen.y);
  return {
    zoom: newZoom,
    panX: anchorScreen.x - img.x * newZoom,
    panY: anchorScreen.y - img.y * newZoom
  };
}

export function panBy(vp: Viewport, dx: number, dy: number): Viewport {
  return { zoom: vp.zoom, panX: vp.panX + dx, panY: vp.panY + dy };
}
