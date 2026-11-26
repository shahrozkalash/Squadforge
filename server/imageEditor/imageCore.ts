import * as crypto from 'crypto';
import type {
  BezierSegment,
  BlendMode,
  BrushPreset,
  BrushSettings,
  BrushTip,
  BuiltInFontId,
  FilterDescriptor,
  FilterOptions,
  FilterParamSpec,
  ImageProject,
  Layer,
  LayerEffect,
  LayerGroup,
  LayerKind,
  LayerMask,
  PixelImage,
  Point,
  Rect,
  RgbaColor,
  SelectionMask,
  SerializedBrushPreset,
  SerializedProject,
  StrokePoint,
  TextAlign,
  TextLayerData,
  Transform2D,
  VectorShapeData,
  Viewport
} from './types.js';
import { BLEND_MODES, BUILT_IN_FONT_IDS, DEFAULT_GRID_SETTINGS, GUIDE_ORIENTATIONS, LAYER_KINDS, TEXT_ALIGNS, VECTOR_SHAPE_KINDS } from './types.js';
import { drawTextBitmap, glyphRowsFor, GLYPH_ADVANCE, GLYPH_HEIGHT, GLYPH_WIDTH } from './bitmapFont.js';

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

/** Per-channel blend functions (W3C compositing spec), channels in 0..1. */
function blendChannel(mode: BlendMode, cb: number, cs: number): number {
  switch (mode) {
    case 'multiply':
      return cb * cs;
    case 'screen':
      return 1 - (1 - cb) * (1 - cs);
    case 'overlay':
      return cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs);
    case 'darken':
      return Math.min(cb, cs);
    case 'lighten':
      return Math.max(cb, cs);
    default:
      return cs; // normal
  }
}

/**
 * Phase 44: composite one source pixel over the destination pixel at
 * index i using a blend mode. Follows the W3C formula:
 *   ao = as + ab·(1 − as)
 *   co = [ as·(1 − ab)·Cs + as·ab·B(Cb, Cs) + (1 − as)·ab·Cb ] / ao
 * For 'normal' (B = Cs) this reduces exactly to source-over (blendOver).
 * sr/sg/sb are 0..255; sa is the effective source alpha in 0..1 (source
 * alpha × layer opacity × mask factor × clip factor, computed by callers).
 */
function blendComposite(
  dst: Uint8ClampedArray,
  i: number,
  sr: number,
  sg: number,
  sb: number,
  sa: number,
  mode: BlendMode
): void {
  if (mode === 'normal') {
    blendOver(dst, i, sr, sg, sb, sa);
    return;
  }
  const ab = dst[i + 3] / 255;
  const ao = sa + ab * (1 - sa);
  if (ao <= 0) {
    dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 0;
    return;
  }
  const src = [sr / 255, sg / 255, sb / 255];
  for (let c = 0; c < 3; c++) {
    const cb = dst[i + c] / 255;
    const blended = blendChannel(mode, cb, src[c]);
    const co = (sa * (1 - ab) * src[c] + sa * ab * blended + (1 - sa) * ab * cb) / ao;
    dst[i + c] = Math.round(co * 255);
  }
  dst[i + 3] = Math.round(ao * 255);
}

/**
 * Paint one pixel onto a layer's own buffer (used by tools). Painting is
 * always normal-mode source-over — except on an alpha-locked layer, where
 * the destination alpha is preserved exactly and transparent pixels are
 * left untouched (Phase 44 alpha lock).
 */
function blendPaint(dst: Uint8ClampedArray, i: number, sr: number, sg: number, sb: number, sa: number, alphaLock: boolean): void {
  if (!alphaLock) {
    blendOver(dst, i, sr, sg, sb, sa);
    return;
  }
  const da = dst[i + 3] / 255;
  if (da <= 0 || sa <= 0) return; // locked: never create or change alpha
  dst[i] = Math.round(sr * sa + dst[i] * (1 - sa));
  dst[i + 1] = Math.round(sg * sa + dst[i + 1] * (1 - sa));
  dst[i + 2] = Math.round(sb * sa + dst[i + 2] * (1 - sa));
  // dst[i + 3] unchanged — the lock holds.
}

// ---------------------------------------------------------------- layers

/** Phase 44 defaults shared by every layer construction site (Phase 48: raster content defaults; Phase 52: effect stack + placement). */
function layerDefaults(): Pick<
  Layer,
  | 'blendMode'
  | 'mask'
  | 'alphaLock'
  | 'clipped'
  | 'groupId'
  | 'kind'
  | 'text'
  | 'shape'
  | 'contentTransform'
  | 'effects'
  | 'placement'
> {
  return {
    blendMode: 'normal',
    mask: null,
    alphaLock: false,
    clipped: false,
    groupId: null,
    kind: 'raster',
    text: null,
    shape: null,
    contentTransform: null,
    effects: [],
    placement: null
  };
}

export function createProject(width: number, height: number, background?: RgbaColor): ImageProject {
  const layer: Layer = {
    id: crypto.randomUUID(),
    name: 'Background',
    visible: true,
    opacity: 1,
    image: createPixelImage(width, height, background),
    ...layerDefaults()
  };
  return { width, height, layers: [layer], groups: [], activeLayerId: layer.id, guides: [], grid: { ...DEFAULT_GRID_SETTINGS } };
}

export function addLayer(project: ImageProject, name?: string): Layer {
  const layer: Layer = {
    id: crypto.randomUUID(),
    name: name || `Layer ${project.layers.length + 1}`,
    visible: true,
    opacity: 1,
    image: createPixelImage(project.width, project.height),
    ...layerDefaults()
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

/**
 * Phase 52: the layer an operation is about to write pixels into.
 * Adjustment layers have no pixels of their own — writing into their
 * never-rendered buffer would be a silent no-op, so pixel-writing
 * operations refuse them with a clear error instead.
 */
function requirePaintableLayer(project: ImageProject, layerId: string): Layer {
  const layer = getLayer(project, layerId);
  if (layer.kind === 'adjustment') {
    throw new Error(`Layer "${layer.name}" is an adjustment layer; it has no pixels of its own to modify`);
  }
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

export function assertBlendMode(mode: string): asserts mode is BlendMode {
  if (!BLEND_MODES.includes(mode as BlendMode)) {
    throw new Error(`Unknown blend mode: ${mode} (expected one of ${BLEND_MODES.join(', ')})`);
  }
}

/** Phase 44: set how a layer blends over the backdrop when composited. */
export function setLayerBlendMode(project: ImageProject, layerId: string, mode: BlendMode): void {
  assertBlendMode(mode);
  getLayer(project, layerId).blendMode = mode;
}

/** Phase 44: alpha lock — paint operations on the layer may not change its alpha. */
export function setLayerAlphaLock(project: ImageProject, layerId: string, locked: boolean): void {
  getLayer(project, layerId).alphaLock = locked;
}

/** Phase 44: clipping — the layer only shows where the nearest non-clipped node below it (same group level) has alpha. */
export function setLayerClipped(project: ImageProject, layerId: string, clipped: boolean): void {
  getLayer(project, layerId).clipped = clipped;
}

// ---------------------------------------------------------------- groups (Phase 44)

export function getGroup(project: ImageProject, groupId: string): LayerGroup {
  const group = project.groups.find((g) => g.id === groupId);
  if (!group) throw new Error(`Layer group not found: ${groupId}`);
  return group;
}

export function createGroup(project: ImageProject, name?: string, parentId: string | null = null): LayerGroup {
  if (parentId !== null) getGroup(project, parentId); // parent must exist
  const group: LayerGroup = {
    id: crypto.randomUUID(),
    name: name || `Group ${project.groups.length + 1}`,
    parentId,
    visible: true,
    opacity: 1,
    blendMode: 'normal'
  };
  project.groups.push(group);
  return group;
}

/** Ancestor group ids of a layer, immediate parent first. Throws on dangling references and cycles. */
function groupChainOf(project: ImageProject, layer: Layer): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let gid = layer.groupId;
  while (gid !== null) {
    if (seen.has(gid)) throw new Error(`Layer group cycle detected at group ${gid}`);
    seen.add(gid);
    chain.push(gid);
    gid = getGroup(project, gid).parentId;
  }
  return chain;
}

/** True when groupId is an ancestor of (or equal to) the group reached by walking up from `from`. */
function isGroupAncestor(project: ImageProject, groupId: string, from: string | null): boolean {
  const seen = new Set<string>();
  let gid = from;
  while (gid !== null) {
    if (gid === groupId) return true;
    if (seen.has(gid)) throw new Error(`Layer group cycle detected at group ${gid}`);
    seen.add(gid);
    gid = getGroup(project, gid).parentId;
  }
  return false;
}

/** Reparent a group. Rejects cycles (a group cannot be placed inside itself or its descendants). */
export function setGroupParent(project: ImageProject, groupId: string, parentId: string | null): void {
  const group = getGroup(project, groupId);
  if (parentId !== null) {
    getGroup(project, parentId);
    if (isGroupAncestor(project, groupId, parentId)) {
      throw new Error('Cannot move a group inside itself or its descendants');
    }
  }
  group.parentId = parentId;
}

/**
 * Remove a group. By default its children are lifted to the group's
 * parent (layers keep rendering, in place). With deleteContents, the
 * group's layers and sub-groups are removed too — refused if that would
 * remove the project's last layer.
 */
export function removeGroup(project: ImageProject, groupId: string, deleteContents = false): void {
  const group = getGroup(project, groupId);
  if (deleteContents) {
    const doomedLayers = project.layers.filter((l) => groupChainOf(project, l).includes(groupId));
    if (doomedLayers.length >= project.layers.length) {
      throw new Error('Cannot delete group contents: it would remove the last layer');
    }
    const doomedIds = new Set(doomedLayers.map((l) => l.id));
    project.layers = project.layers.filter((l) => !doomedIds.has(l.id));
    project.groups = project.groups.filter((g) => g.id !== groupId && !isGroupAncestor(project, groupId, g.parentId));
    if (project.activeLayerId && doomedIds.has(project.activeLayerId)) {
      project.activeLayerId = project.layers[0]?.id ?? null;
    }
    return;
  }
  for (const layer of project.layers) {
    if (layer.groupId === groupId) layer.groupId = group.parentId;
  }
  for (const g of project.groups) {
    if (g.parentId === groupId) g.parentId = group.parentId;
  }
  project.groups = project.groups.filter((g) => g.id !== groupId);
}

export function setGroupVisibility(project: ImageProject, groupId: string, visible: boolean): void {
  getGroup(project, groupId).visible = visible;
}

export function setGroupOpacity(project: ImageProject, groupId: string, opacity: number): void {
  if (opacity < 0 || opacity > 1) throw new Error(`Opacity out of range: ${opacity}`);
  getGroup(project, groupId).opacity = opacity;
}

export function setGroupBlendMode(project: ImageProject, groupId: string, mode: BlendMode): void {
  assertBlendMode(mode);
  getGroup(project, groupId).blendMode = mode;
}

/** Assign a layer to a group (null = root level). The layer keeps its position in the flat stack. */
export function setLayerGroup(project: ImageProject, layerId: string, groupId: string | null): void {
  if (groupId !== null) getGroup(project, groupId);
  getLayer(project, layerId).groupId = groupId;
}

// ---------------------------------------------------------------- masks (Phase 44)

function requireMask(project: ImageProject, layerId: string): { layer: Layer; mask: LayerMask } {
  const layer = getLayer(project, layerId);
  if (!layer.mask) throw new Error(`Layer "${layer.name}" has no mask`);
  return { layer, mask: layer.mask };
}

/** Attach a fresh grayscale mask filled with `fill` (255 = reveal all, the usual default). */
export function createLayerMask(project: ImageProject, layerId: string, fill = 255): LayerMask {
  const layer = getLayer(project, layerId);
  if (!Number.isInteger(fill) || fill < 0 || fill > 255) throw new Error(`Mask fill out of range: ${fill}`);
  const mask: LayerMask = {
    width: layer.image.width,
    height: layer.image.height,
    data: new Uint8ClampedArray(layer.image.width * layer.image.height).fill(fill)
  };
  layer.mask = mask;
  return mask;
}

export function getLayerMask(project: ImageProject, layerId: string): LayerMask | null {
  return getLayer(project, layerId).mask;
}

export function removeLayerMask(project: ImageProject, layerId: string): void {
  getLayer(project, layerId).mask = null;
}

/** Invert the mask: every value v becomes 255 − v. */
export function invertLayerMask(project: ImageProject, layerId: string): void {
  const { mask } = requireMask(project, layerId);
  for (let i = 0; i < mask.data.length; i++) mask.data[i] = 255 - mask.data[i];
}

function paintMaskDot(
  mask: LayerMask,
  cx: number,
  cy: number,
  radius: number,
  gray: number,
  strength: number,
  selection?: Rect | null
): void {
  const r = Math.max(0.5, radius);
  const x0 = Math.floor(cx - r);
  const x1 = Math.ceil(cx + r);
  const y0 = Math.floor(cy - r);
  const y1 = Math.ceil(cy + r);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) continue;
      if (!inSelection(x, y, selection)) continue;
      if (Math.hypot(x - cx, y - cy) > r) continue;
      const idx = y * mask.width + x;
      mask.data[idx] = Math.round(mask.data[idx] * (1 - strength) + gray * strength);
    }
  }
}

/**
 * Paint a grayscale value into the layer's mask along a polyline
 * (interpolated like the brush, so strokes stay continuous). `strength`
 * 0..1 blends the painted value toward `gray` (1 = set it outright).
 */
export function paintMask(
  project: ImageProject,
  layerId: string,
  points: Point[],
  radius: number,
  gray: number,
  strength = 1,
  selection?: Rect | null
): void {
  const { mask } = requireMask(project, layerId);
  if (!Number.isInteger(gray) || gray < 0 || gray > 255) throw new Error(`Mask gray value out of range: ${gray}`);
  if (strength < 0 || strength > 1) throw new Error(`Mask strength out of range: ${strength}`);
  if (points.length === 0) return;
  let prev = points[0];
  paintMaskDot(mask, prev.x, prev.y, radius, gray, strength, selection);
  for (let s = 1; s < points.length; s++) {
    const cur = points[s];
    const dist = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, radius / 2)));
    for (let k = 1; k <= steps; k++) {
      paintMaskDot(mask, prev.x + ((cur.x - prev.x) * k) / steps, prev.y + ((cur.y - prev.y) * k) / steps, radius, gray, strength, selection);
    }
    prev = cur;
  }
}

/** Bake the mask into the layer's alpha channel and remove the mask. */
export function applyLayerMask(project: ImageProject, layerId: string): void {
  const { layer, mask } = requireMask(project, layerId);
  // Phase 52: an adjustment layer's mask modulates its effect at
  // render time — there is no pixel alpha to bake it into.
  if (layer.kind === 'adjustment') {
    throw new Error(`Layer "${layer.name}" is an adjustment layer; its mask modulates its effect and cannot be applied to pixels`);
  }
  const d = layer.image.data;
  for (let px = 0, p = 0; px < mask.data.length; px++, p += 4) {
    d[p + 3] = Math.round((d[p + 3] * mask.data[px]) / 255);
  }
  layer.mask = null;
}

// ---------------------------------------------------------------- selections (Phase 45)

/**
 * Phase 45: professional selections. A selection is a grayscale raster
 * (SelectionMask) the size of the canvas — the same representation as a
 * Phase 44 layer mask, so the two bridge directly. Shape selections
 * sample pixel centres ((x+0.5, y+0.5)), which keeps ellipse/polygon
 * membership symmetric and exactly testable. Color-based selections use
 * one documented distance: the maximum absolute per-channel difference
 * across R, G, B and A (0..255); a pixel matches when distance ≤
 * tolerance, so the tolerance boundary is inclusive and exact.
 * The pure operations (invert/feather/expand/contract/transforms)
 * return new selections and never mutate their input.
 */

export function createSelection(width: number, height: number, fill = 0): SelectionMask {
  if (width <= 0 || height <= 0) throw new Error(`Invalid selection size ${width}x${height}`);
  if (!Number.isInteger(fill) || fill < 0 || fill > 255) throw new Error(`Selection fill out of range: ${fill}`);
  return { width, height, data: new Uint8ClampedArray(width * height).fill(fill) };
}

export function cloneSelection(sel: SelectionMask): SelectionMask {
  return { width: sel.width, height: sel.height, data: new Uint8ClampedArray(sel.data) };
}

/** Number of pixels with any selection (value > 0). For a binary selection this is the selected area. */
export function selectedPixelCount(sel: SelectionMask): number {
  let n = 0;
  for (let i = 0; i < sel.data.length; i++) if (sel.data[i] > 0) n++;
  return n;
}

/** Bounding box of the selected (value > 0) pixels, or null when the selection is empty. */
export function selectionBounds(sel: SelectionMask): Rect | null {
  let minX = sel.width;
  let minY = sel.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < sel.height; y++) {
    for (let x = 0; x < sel.width; x++) {
      if (sel.data[y * sel.width + x] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX === -1) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Axis-aligned rectangle selection (the raster form of the Phase 19 Rect selection). */
export function rectSelection(width: number, height: number, rect: Rect): SelectionMask {
  const sel = createSelection(width, height);
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(width, rect.x + rect.width);
  const y1 = Math.min(height, rect.y + rect.height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) sel.data[y * width + x] = 255;
  }
  return sel;
}

/** Ellipse selection: a pixel is selected when its centre lies inside the ellipse inscribed in `rect`. A non-positive rect yields an empty selection. */
export function ellipseSelection(width: number, height: number, rect: Rect): SelectionMask {
  const sel = createSelection(width, height);
  if (rect.width <= 0 || rect.height <= 0) return sel;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const rx = rect.width / 2;
  const ry = rect.height / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      if (nx * nx + ny * ny <= 1) sel.data[y * width + x] = 255;
    }
  }
  return sel;
}

/** Even-odd point-in-polygon test (ray casting), the rasterizer behind polygon and lasso selections. */
function pointInPolygon(px: number, py: number, points: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x;
    const yi = points[i].y;
    const xj = points[j].x;
    const yj = points[j].y;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polygonRaster(width: number, height: number, points: Point[]): SelectionMask {
  if (points.length < 3) throw new Error(`Polygon selection needs at least 3 points, got ${points.length}`);
  const sel = createSelection(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pointInPolygon(x + 0.5, y + 0.5, points)) sel.data[y * width + x] = 255;
    }
  }
  return sel;
}

/** Polygon selection from explicit vertices (closed automatically). */
export function polygonSelection(width: number, height: number, points: Point[]): SelectionMask {
  return polygonRaster(width, height, points);
}

/**
 * Freehand (lasso) selection: the pointer path is treated as a closed
 * polygon and filled with the same even-odd rule as polygonSelection.
 */
export function lassoSelection(width: number, height: number, points: Point[]): SelectionMask {
  return polygonRaster(width, height, points);
}

/** The one color distance used by wand and color-range: max absolute per-channel difference (R, G, B, A). */
function colorDistanceMax(a: RgbaColor, b: RgbaColor): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b), Math.abs(a.a - b.a));
}

function assertTolerance(tolerance: number): void {
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255) {
    throw new Error(`Tolerance out of range: ${tolerance} (expected an integer 0..255)`);
  }
}

/**
 * Magic wand: select pixels matching the seed pixel's color within
 * `tolerance`. With `contiguous` (the default) only the connected
 * region around the seed is selected (4-connectivity flood fill);
 * with contiguous=false every matching pixel in the image is selected.
 */
export function magicWandSelection(image: PixelImage, seedX: number, seedY: number, tolerance: number, contiguous = true): SelectionMask {
  assertTolerance(tolerance);
  if (seedX < 0 || seedY < 0 || seedX >= image.width || seedY >= image.height) {
    throw new Error(`Wand seed out of bounds: (${seedX}, ${seedY}) in ${image.width}x${image.height}`);
  }
  const seed = getPixel(image, seedX, seedY);
  const matches = (x: number, y: number): boolean => colorDistanceMax(getPixel(image, x, y), seed) <= tolerance;
  const sel = createSelection(image.width, image.height);
  if (!contiguous) {
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        if (matches(x, y)) sel.data[y * image.width + x] = 255;
      }
    }
    return sel;
  }
  const visited = new Uint8Array(image.width * image.height);
  const stack: Array<[number, number]> = [[seedX, seedY]];
  visited[seedY * image.width + seedX] = 1;
  while (stack.length > 0) {
    const [x, y] = stack.pop()!;
    if (!matches(x, y)) continue;
    sel.data[y * image.width + x] = 255;
    const neighbors: Array<[number, number]> = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1]
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= image.width || ny >= image.height) continue;
      const idx = ny * image.width + nx;
      if (!visited[idx]) {
        visited[idx] = 1;
        stack.push([nx, ny]);
      }
    }
  }
  return sel;
}

/** Color-range selection: every pixel in the image whose color is within `tolerance` of `target` (global, not connected). */
export function colorRangeSelection(image: PixelImage, target: RgbaColor, tolerance: number): SelectionMask {
  assertTolerance(tolerance);
  const sel = createSelection(image.width, image.height);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (colorDistanceMax(getPixel(image, x, y), target) <= tolerance) sel.data[y * image.width + x] = 255;
    }
  }
  return sel;
}

/** Invert the selection: every value v becomes 255 − v. An empty selection inverts to a full one (and vice versa). */
export function invertSelection(sel: SelectionMask): SelectionMask {
  const out = cloneSelection(sel);
  for (let i = 0; i < out.data.length; i++) out.data[i] = 255 - out.data[i];
  return out;
}

/**
 * Feather the selection: a separable box blur of the given radius
 * (kernel width 2·radius+1 per pass, edges clamped), computed in float
 * and rounded once at the end — so a hard edge feathered with radius 1
 * takes the exact intermediate values 85 and 170. Radius 0 is identity.
 */
export function featherSelection(sel: SelectionMask, radius: number): SelectionMask {
  if (!Number.isInteger(radius) || radius < 0) throw new Error(`Feather radius out of range: ${radius}`);
  const out = cloneSelection(sel);
  if (radius === 0) return out;
  const { width: w, height: h } = sel;
  const k = 2 * radius + 1;
  let cur = new Float32Array(sel.data.length);
  for (let i = 0; i < cur.length; i++) cur[i] = sel.data[i];
  const blurPass = (horizontal: boolean): void => {
    const next = new Float32Array(cur.length);
    const lines = horizontal ? h : w;
    const len = horizontal ? w : h;
    for (let line = 0; line < lines; line++) {
      // Prefix sums over the edge-extended line make each window sum O(1).
      const ext = new Float32Array(len + 2 * radius);
      for (let i = 0; i < ext.length; i++) {
        const srcIdx = Math.min(len - 1, Math.max(0, i - radius));
        ext[i] = cur[horizontal ? line * w + srcIdx : srcIdx * w + line];
      }
      const prefix = new Float32Array(ext.length + 1);
      for (let i = 0; i < ext.length; i++) prefix[i + 1] = prefix[i] + ext[i];
      for (let pos = 0; pos < len; pos++) {
        const sum = prefix[pos + k] - prefix[pos];
        if (horizontal) next[line * w + pos] = sum / k;
        else next[pos * w + line] = sum / k;
      }
    }
    cur = next;
  };
  blurPass(true);
  blurPass(false);
  for (let i = 0; i < out.data.length; i++) out.data[i] = Math.round(cur[i]);
  return out;
}

/** One separable max/min morphology pass pair (square structuring element of half-width n). */
function morphSelection(sel: SelectionMask, n: number, isMax: boolean): SelectionMask {
  const { width: w, height: h } = sel;
  let cur: Uint8ClampedArray = sel.data;
  for (const horizontal of [true, false]) {
    const next = new Uint8ClampedArray(cur.length);
    const lines = horizontal ? h : w;
    const len = horizontal ? w : h;
    for (let line = 0; line < lines; line++) {
      for (let pos = 0; pos < len; pos++) {
        let best = isMax ? 0 : 255;
        for (let d = -n; d <= n; d++) {
          const q = Math.min(len - 1, Math.max(0, pos + d));
          const v = horizontal ? cur[line * w + q] : cur[q * w + line];
          best = isMax ? Math.max(best, v) : Math.min(best, v);
        }
        if (horizontal) next[line * w + pos] = best;
        else next[pos * w + line] = best;
      }
    }
    cur = next;
  }
  return { width: w, height: h, data: cur };
}

function assertMorphPixels(pixels: number): void {
  if (!Number.isInteger(pixels) || pixels < 0) throw new Error(`Expand/contract amount out of range: ${pixels}`);
}

/** Grow the selection by `pixels` on every side (max filter; partial/feathered values propagate by their maximum). */
export function expandSelection(sel: SelectionMask, pixels: number): SelectionMask {
  assertMorphPixels(pixels);
  if (pixels === 0) return cloneSelection(sel);
  return morphSelection(sel, pixels, true);
}

/** Shrink the selection by `pixels` on every side (min filter; a region thinner than 2·pixels disappears). */
export function contractSelection(sel: SelectionMask, pixels: number): SelectionMask {
  assertMorphPixels(pixels);
  if (pixels === 0) return cloneSelection(sel);
  return morphSelection(sel, pixels, false);
}

/**
 * Select a layer's visible footprint: per-pixel alpha scaled by the
 * layer's Phase 44 mask when it has one. (Layer opacity is a blending
 * factor, not part of the footprint, and is not included.)
 */
export function selectionFromLayerAlpha(project: ImageProject, layerId: string): SelectionMask {
  const layer = getLayer(project, layerId);
  const sel = createSelection(layer.image.width, layer.image.height);
  const d = layer.image.data;
  for (let px = 0, p = 0; px < sel.data.length; px++, p += 4) {
    let v = d[p + 3];
    if (layer.mask) v = Math.round((v * layer.mask.data[px]) / 255);
    sel.data[px] = v;
  }
  return sel;
}

/** Install a selection as the layer's Phase 44 mask (replacing any existing mask). Sizes must match the layer. */
export function applySelectionAsMask(project: ImageProject, layerId: string, selection: SelectionMask): void {
  const layer = getLayer(project, layerId);
  if (selection.width !== layer.image.width || selection.height !== layer.image.height) {
    throw new Error(
      `Selection size ${selection.width}x${selection.height} does not match layer size ${layer.image.width}x${layer.image.height}`
    );
  }
  layer.mask = { width: selection.width, height: selection.height, data: new Uint8ClampedArray(selection.data) };
}

// ---------------------------------------------------------------- compositing (Phase 44: groups, masks, blend modes, clipping)

type CompositeNode = { kind: 'layer'; layer: Layer } | { kind: 'group'; group: LayerGroup; children: CompositeNode[] };

/**
 * Build the ordered child list for one hierarchy level from the flat
 * layer stack: children appear in the order of their first (lowest)
 * member in the stack, so a group renders as one isolated unit sitting
 * at its lowest member's position. Keep a group's members contiguous in
 * the stack for the least surprising result.
 */
function buildLevel(project: ImageProject, parentId: string | null): CompositeNode[] {
  const nodes: CompositeNode[] = [];
  const emitted = new Set<string>();
  const emitGroup = (groupId: string) => {
    if (emitted.has(groupId)) return;
    emitted.add(groupId);
    const group = getGroup(project, groupId);
    nodes.push({ kind: 'group', group, children: buildLevel(project, groupId) });
  };
  for (const layer of project.layers) {
    const chain = groupChainOf(project, layer);
    if (parentId === null) {
      if (chain.length === 0) nodes.push({ kind: 'layer', layer });
      else emitGroup(chain[chain.length - 1]);
    } else {
      const idx = chain.indexOf(parentId);
      if (idx === -1) continue;
      if (idx === 0) nodes.push({ kind: 'layer', layer });
      else emitGroup(chain[idx - 1]);
    }
  }
  return nodes;
}

/**
 * Phase 52: the render-time view of a layer — the pixels and mask the
 * compositor actually blends. For a layer with no effect stack and no
 * placement this is exactly the stored `image` / `mask` (the Phase
 * 19–51 behavior, byte for byte). Otherwise the view is derived from
 * the pristine stored data, in this order:
 *   1. the enabled effects of the layer's stack, applied to the
 *      pristine pixels (for content layers: to the render cache);
 *   2. a raster layer's placement warp, applied to the filtered
 *      pixels and to the mask alike, so they stay aligned.
 * The stored pixels and mask are never modified by deriving a view.
 * Views are computed once per composite call and cached by layer id.
 */
interface LayerView {
  image: PixelImage;
  mask: LayerMask | null;
}

type LayerViewCache = Map<string, LayerView>;

function layerView(cache: LayerViewCache, layer: Layer): LayerView {
  let view = cache.get(layer.id);
  if (!view) {
    view = computeLayerView(layer);
    cache.set(layer.id, view);
  }
  return view;
}

function computeLayerView(layer: Layer): LayerView {
  let image = layer.image;
  if (layer.effects.some((e) => e.enabled)) {
    image = applyLayerEffectStack(image, layer.effects);
  }
  let mask = layer.mask;
  if (layer.kind === 'raster' && layer.placement) {
    const m = layer.placement as Mat3;
    image = warpImage(image, m);
    if (mask) {
      mask = { width: mask.width, height: mask.height, data: warpChannel(mask.data, mask.width, mask.height, m) };
    }
  }
  return { image, mask };
}

/**
 * Phase 52: does the project contain an adjustment layer that will
 * actually fire — visible, with at least one enabled effect? (Group
 * visibility is not consulted: taking the full-render path for a
 * group-hidden adjustment layer costs time, never correctness.)
 */
function hasActiveAdjustmentLayer(project: ImageProject): boolean {
  return project.layers.some((l) => l.kind === 'adjustment' && l.visible && l.effects.some((e) => e.enabled));
}

/**
 * Phase 52: apply an adjustment layer to the accumulated backdrop of
 * its compositing level. `out` holds that backdrop for canvas rows
 * [y0, y0 + out.height); the layer's enabled effect stack is applied
 * to it as a whole image, then blended back per pixel by the weight
 * layer.opacity × mask value — so a hidden layer (skipped by the
 * caller), a zero opacity, or a black mask region all leave the
 * backdrop untouched, and partial weights cross-fade exactly.
 *
 * Callers must guarantee the band is the full canvas height whenever
 * an adjustment layer can fire (compositeRows enforces this): the
 * stack may contain neighborhood filters, which are only exact with
 * the full backdrop as context.
 */
function applyAdjustmentLayerBand(layer: Layer, out: PixelImage, y0: number): void {
  if (!layer.effects.some((e) => e.enabled)) return;
  const backdrop: PixelImage = { width: out.width, height: out.height, data: out.data };
  const filtered = applyLayerEffectStack(backdrop, layer.effects);
  const mask = layer.mask;
  for (let row = 0; row < out.height; row++) {
    for (let x = 0; x < out.width; x++) {
      let w = layer.opacity;
      if (mask) w *= mask.data[(y0 + row) * out.width + x] / 255;
      if (w <= 0) continue;
      const i = (row * out.width + x) * 4;
      if (w >= 1) {
        out.data[i] = filtered.data[i];
        out.data[i + 1] = filtered.data[i + 1];
        out.data[i + 2] = filtered.data[i + 2];
        out.data[i + 3] = filtered.data[i + 3];
      } else {
        for (let c = 0; c < 4; c++) {
          out.data[i + c] = Math.round(out.data[i + c] * (1 - w) + filtered.data[i + c] * w);
        }
      }
    }
  }
}

/**
 * Effective per-pixel alpha (0..1) of a layer over canvas rows
 * [y0, y0 + bandHeight): source alpha × opacity × mask. The returned
 * map is band-sized (width × bandHeight), indexed from the band's
 * first row. (Phase 51: banded form of the Phase 44 helper — the
 * per-pixel math is unchanged. Phase 52: reads the layer's render-time
 * view, so the footprint follows its effect stack and placement.)
 */
function layerAlphaMapBand(layer: Layer, view: LayerView, y0: number, bandHeight: number): Float32Array {
  const width = view.image.width;
  const n = width * bandHeight;
  const map = new Float32Array(n);
  const d = view.image.data;
  for (let px = 0; px < n; px++) {
    const p = (y0 * width + px) * 4;
    let a = (d[p + 3] / 255) * layer.opacity;
    if (view.mask) a *= view.mask.data[y0 * width + px] / 255;
    map[px] = a;
  }
  return map;
}

/**
 * Blend one layer's canvas rows [y0, y0 + out.height) into the
 * band-sized image `out`. Layer images are canvas-sized by engine
 * invariant, so source row y is canvas row y and destination row
 * y − y0. Per-pixel math identical to the pre-Phase-51 full-canvas
 * loop.
 */
function renderLayerBandInto(layer: Layer, view: LayerView, out: PixelImage, y0: number, clipBase: Float32Array | null): void {
  const src = view.image.data;
  const mask = view.mask;
  const width = view.image.width;
  for (let y = y0; y < y0 + out.height; y++) {
    for (let x = 0; x < width; x++) {
      const px = y * width + x;
      const p = px * 4;
      let sa = (src[p + 3] / 255) * layer.opacity;
      if (sa <= 0) continue;
      if (mask) {
        sa *= mask.data[px] / 255;
        if (sa <= 0) continue;
      }
      const bpx = (y - y0) * width + x;
      if (clipBase) {
        sa *= clipBase[bpx];
        if (sa <= 0) continue;
      }
      blendComposite(out.data, bpx * 4, src[p], src[p + 1], src[p + 2], sa, layer.blendMode);
    }
  }
}

function renderNodesBand(project: ImageProject, nodes: CompositeNode[], out: PixelImage, y0: number, views: LayerViewCache): void {
  // Alpha footprint of the nearest non-clipped node below, per pixel —
  // the base that clipped siblings are clipped to at this level.
  let clipBase: Float32Array | null = null;
  for (const node of nodes) {
    if (node.kind === 'layer') {
      const layer = node.layer;
      if (!layer.visible || layer.opacity <= 0) continue;
      // Phase 52: an adjustment layer has no pixels to blend — it
      // filters the backdrop accumulated so far at this level. It is
      // not a clipping base (it has no alpha footprint of its own),
      // and its own `clipped` flag has no effect.
      if (layer.kind === 'adjustment') {
        applyAdjustmentLayerBand(layer, out, y0);
        continue;
      }
      // A clipped layer with no non-clipped node below it has nothing
      // to clip to: it contributes nothing (Photoshop behaves the same).
      if (layer.clipped && !clipBase) continue;
      const view = layerView(views, layer);
      renderLayerBandInto(layer, view, out, y0, layer.clipped ? clipBase : null);
      if (!layer.clipped) clipBase = layerAlphaMapBand(layer, view, y0, out.height);
    } else {
      const group = node.group;
      if (!group.visible || group.opacity <= 0) continue;
      const buf = createPixelImage(project.width, out.height);
      renderNodesBand(project, node.children, buf, y0, views);
      const bd = buf.data;
      for (let p = 0; p < bd.length; p += 4) {
        const sa = (bd[p + 3] / 255) * group.opacity;
        if (sa <= 0) continue;
        blendComposite(out.data, p, bd[p], bd[p + 1], bd[p + 2], sa, group.blendMode);
      }
      const map = new Float32Array(project.width * out.height);
      for (let px = 0, p = 0; px < map.length; px++, p += 4) map[px] = (bd[p + 3] / 255) * group.opacity;
      clipBase = map;
    }
  }
}

/**
 * Flatten visible layers (bottom → top) into a single image. Phase 44:
 * honors per-layer blend modes, grayscale masks, clipping, and nested
 * groups (isolated group buffers blended with the group's opacity and
 * blend mode; invisible groups hide their subtree). With no groups,
 * masks, clipping or non-normal blend modes this is exactly the Phase 19
 * source-over flatten. Phase 52: each layer renders through its
 * render-time view (effect stack, then placement — see computeLayerView)
 * and adjustment layers filter the accumulated backdrop of their level.
 */
export function composite(project: ImageProject): PixelImage {
  return compositeRows(project, 0, project.height);
}

/**
 * Phase 51: composite only canvas rows [y0, y1), returning a
 * width × (y1 − y0) image. Every compositing operation in this
 * engine is per-pixel independent — a layer pixel blends only with
 * the backdrop pixel at the same coordinates, and clip bases and
 * group buffers are per-pixel as well — so a band rendered on its
 * own is byte-identical to the same rows of the full `composite()`.
 * This is the seam the parallel CPU provider splits work along; the
 * consistency is pinned by the Phase 51 tests.
 *
 * Phase 52 exception, handled inside this function: an adjustment
 * layer's stack may contain neighborhood filters, which are only
 * exact with the full backdrop as context — they are NOT per-pixel
 * independent across band boundaries. When the project contains an
 * adjustment layer that can fire, this function renders the full
 * composite and slices the requested rows out of it, so the
 * band == full-rows identity holds for every project (the parallel
 * provider stays byte-exact; it just gets no banding win on such
 * projects). Per-layer effect stacks and placements need no such
 * exception: they transform whole layer images before the per-pixel
 * blending starts.
 */
export function compositeRows(project: ImageProject, y0: number, y1: number): PixelImage {
  if (!Number.isInteger(y0) || !Number.isInteger(y1) || y0 < 0 || y1 > project.height || y0 >= y1) {
    throw new Error(`Invalid composite row band [${y0}, ${y1}) for canvas height ${project.height}`);
  }
  const views: LayerViewCache = new Map();
  if (hasActiveAdjustmentLayer(project)) {
    const full = createPixelImage(project.width, project.height);
    renderNodesBand(project, buildLevel(project, null), full, 0, views);
    if (y0 === 0 && y1 === project.height) return full;
    return sliceImageRows(full, y0, y1);
  }
  const out = createPixelImage(project.width, y1 - y0);
  renderNodesBand(project, buildLevel(project, null), out, y0, views);
  return out;
}

// ---------------------------------------------------------------- tools

function inSelection(x: number, y: number, selection?: Rect | null): boolean {
  if (!selection) return true;
  return x >= selection.x && y >= selection.y && x < selection.x + selection.width && y < selection.y + selection.height;
}

function paintDot(
  img: PixelImage,
  cx: number,
  cy: number,
  radius: number,
  color: RgbaColor,
  erase: boolean,
  selection?: Rect | null,
  alphaLock = false
): void {
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
        // Phase 44: the eraser only ever changes alpha, so an alpha
        // lock makes it a no-op (as in Photoshop's lock-transparent mode).
        if (alphaLock) continue;
        const falloff = d >= r ? 0 : 1;
        img.data[i + 3] = Math.round(img.data[i + 3] * (1 - falloff));
        if (img.data[i + 3] === 0) {
          img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
        }
      } else {
        blendPaint(img.data, i, color.r, color.g, color.b, color.a / 255, alphaLock);
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
  const layer = requirePaintableLayer(project, layerId);
  paintStroke(layer.image, points, radius, color, false, selection, layer.alphaLock);
}

/** Eraser stroke: reduces alpha along the path (real erase, not painting background color). */
export function eraserStroke(
  project: ImageProject,
  layerId: string,
  points: Point[],
  radius: number,
  selection?: Rect | null
): void {
  const layer = requirePaintableLayer(project, layerId);
  paintStroke(layer.image, points, radius, { r: 0, g: 0, b: 0, a: 0 }, true, selection, layer.alphaLock);
}

function paintStroke(
  img: PixelImage,
  points: Point[],
  radius: number,
  color: RgbaColor,
  erase: boolean,
  selection?: Rect | null,
  alphaLock = false
): void {
  if (points.length === 0) return;
  let prev = points[0];
  paintDot(img, prev.x, prev.y, radius, color, erase, selection, alphaLock);
  for (let s = 1; s < points.length; s++) {
    const cur = points[s];
    const dist = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, radius / 2)));
    for (let k = 1; k <= steps; k++) {
      paintDot(
        img,
        prev.x + ((cur.x - prev.x) * k) / steps,
        prev.y + ((cur.y - prev.y) * k) / steps,
        radius,
        color,
        erase,
        selection,
        alphaLock
      );
    }
    prev = cur;
  }
}

export function fillRect(project: ImageProject, layerId: string, rect: Rect, color: RgbaColor, selection?: Rect | null): void {
  const layer = requirePaintableLayer(project, layerId);
  const img = layer.image;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      if (!inSelection(x, y, selection)) continue;
      const i = (y * img.width + x) * 4;
      if (x >= 0 && y >= 0 && x < img.width && y < img.height) {
        blendPaint(img.data, i, color.r, color.g, color.b, color.a / 255, layer.alphaLock);
      }
    }
  }
}

export function drawEllipse(project: ImageProject, layerId: string, rect: Rect, color: RgbaColor, selection?: Rect | null): void {
  const layer = requirePaintableLayer(project, layerId);
  const img = layer.image;
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
          blendPaint(img.data, i, color.r, color.g, color.b, color.a / 255, layer.alphaLock);
        }
      }
    }
  }
}

export function drawLine(project: ImageProject, layerId: string, from: Point, to: Point, width: number, color: RgbaColor, selection?: Rect | null): void {
  const layer = requirePaintableLayer(project, layerId);
  paintStroke(layer.image, [from, to], width / 2, color, false, selection, layer.alphaLock);
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
  const layer = requirePaintableLayer(project, layerId);
  const img = layer.image;
  drawTextBitmap(
    (x, y) => {
      if (!inSelection(x, y, selection)) return;
      const i = (y * img.width + x) * 4;
      if (x >= 0 && y >= 0 && x < img.width && y < img.height) {
        blendPaint(img.data, i, color.r, color.g, color.b, color.a / 255, layer.alphaLock);
      }
    },
    origin,
    text,
    Math.max(1, Math.floor(scale))
  );
}

// ---------------------------------------------------------------- advanced brush & painting (Phase 46)

/**
 * Phase 46: the advanced brush engine. It extends the Phase 19 paint
 * path — it is not a second one: finished strokes are applied through
 * the same `blendPaint`, so the Phase 44 alpha lock holds exactly as
 * it does for the simple brush, and strokes can be scoped by the
 * Phase 19 rect selection or by a Phase 45 raster selection.
 *
 * Rendering model (see BrushSettings): a stroke is first accumulated
 * into a float coverage map the size of the layer. Stamps are placed
 * along the (optionally smoothed) path every `spacing × size` pixels,
 * interpolating position and pressure; each stamp deposits
 * shape × flow × pressure coverage with the build-up rule
 * cov += deposit × (1 − cov). The coverage is then applied once at
 * `opacity`: paint source-overs the color with alpha = opacity × cov
 * per pixel, erase scales alpha by (1 − opacity × cov).
 *
 * Round-tip shape: with nd = distance/radius, shape is 1 for
 * nd ≤ hardness, falls linearly to 0 at nd = 1, and is a hard disc
 * when hardness = 1 (the Phase 19 dot rule). Custom tips are raster
 * stamps: the tip is drawn into the stamp's square footprint
 * (integer-aligned, side = stamp diameter) and bilinear-sampled with
 * clamped edges — the `resizeImage` sampling convention — so a stamp
 * whose diameter equals the tip size reproduces the tip texel-for-texel.
 */

export const DEFAULT_BRUSH_SETTINGS: BrushSettings = {
  size: 12,
  hardness: 0.75,
  spacing: 0.25,
  opacity: 1,
  flow: 1,
  smoothing: 0,
  tip: null,
  pressureSize: false,
  pressureOpacity: false
};

function assertBrushTip(tip: BrushTip): void {
  if (!tip || !Number.isInteger(tip.width) || !Number.isInteger(tip.height) || tip.width <= 0 || tip.height <= 0) {
    throw new Error('Brush tip must have positive integer dimensions');
  }
  if (!tip.data || tip.data.length !== tip.width * tip.height) {
    throw new Error(`Brush tip data size mismatch: ${tip.data?.length} != ${tip.width * tip.height}`);
  }
}

export function assertBrushSettings(s: BrushSettings): void {
  if (!Number.isFinite(s.size) || s.size <= 0) throw new Error(`Brush size out of range: ${s.size}`);
  for (const key of ['hardness', 'opacity', 'flow', 'smoothing'] as const) {
    if (!Number.isFinite(s[key]) || s[key] < 0 || s[key] > 1) throw new Error(`Brush ${key} out of range: ${s[key]}`);
  }
  if (!Number.isFinite(s.spacing) || s.spacing < 0) throw new Error(`Brush spacing out of range: ${s.spacing}`);
  if (s.tip !== null && s.tip !== undefined) assertBrushTip(s.tip);
}

/** Build a complete, validated BrushSettings from partial overrides over the defaults. */
export function createBrushSettings(partial?: Partial<BrushSettings>): BrushSettings {
  const settings: BrushSettings = {
    ...DEFAULT_BRUSH_SETTINGS,
    ...(partial ?? {}),
    tip: partial?.tip ? { width: partial.tip.width, height: partial.tip.height, data: new Uint8ClampedArray(partial.tip.data) } : null
  };
  assertBrushSettings(settings);
  return settings;
}

/** A validated custom brush tip from raw grayscale bytes (copied). */
export function createBrushTip(width: number, height: number, data: Uint8Array): BrushTip {
  const tip: BrushTip = { width, height, data: new Uint8ClampedArray(data) };
  assertBrushTip(tip);
  return tip;
}

/** The round tip's edge profile: 1 inside the hardness radius, linear falloff to 0 at the rim, hard disc at hardness 1. */
function roundProfile(nd: number, hardness: number): number {
  if (nd > 1) return 0;
  if (hardness >= 1) return 1;
  if (nd <= hardness) return 1;
  return (1 - nd) / (1 - hardness);
}

/** Generate a round brush tip raster with the same profile the round stamp uses. */
export function roundBrushTip(diameter: number, hardness: number): BrushTip {
  if (!Number.isInteger(diameter) || diameter <= 0) throw new Error(`Brush tip diameter out of range: ${diameter}`);
  if (!Number.isFinite(hardness) || hardness < 0 || hardness > 1) throw new Error(`Brush hardness out of range: ${hardness}`);
  const tip: BrushTip = { width: diameter, height: diameter, data: new Uint8ClampedArray(diameter * diameter) };
  const c = (diameter - 1) / 2;
  const r = diameter / 2;
  for (let y = 0; y < diameter; y++) {
    for (let x = 0; x < diameter; x++) {
      tip.data[y * diameter + x] = Math.round(roundProfile(Math.hypot(x - c, y - c) / r, hardness) * 255);
    }
  }
  return tip;
}

/**
 * Derive a brush tip from an image: each texel is the pixel's
 * luminance scaled by its alpha — a transparent pixel stamps nothing,
 * an opaque white pixel stamps fully.
 */
export function brushTipFromImage(img: PixelImage): BrushTip {
  const tip: BrushTip = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.width * img.height) };
  for (let px = 0, p = 0; px < tip.data.length; px++, p += 4) {
    const lum = 0.299 * img.data[p] + 0.587 * img.data[p + 1] + 0.114 * img.data[p + 2];
    tip.data[px] = Math.round((lum * img.data[p + 3]) / 255);
  }
  return tip;
}

/** Derive a brush tip from a layer's pixels (see brushTipFromImage). */
export function brushTipFromLayer(project: ImageProject, layerId: string): BrushTip {
  return brushTipFromImage(getLayer(project, layerId).image);
}

/** Clamp a stroke point's pressure into 0..1; absent or non-finite pressure means the device reported none → full pressure. */
function pointPressure(p: StrokePoint): number {
  if (p.pressure === undefined || !Number.isFinite(p.pressure)) return 1;
  return Math.min(1, Math.max(0, p.pressure));
}

function assertStrokePoints(points: StrokePoint[]): void {
  for (const p of points) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw new Error(`Stroke point coordinates must be finite, got (${p?.x}, ${p?.y})`);
    }
  }
}

/**
 * Stroke stabilization: an exponential moving average over the input
 * points, anchored at the first point. `amount` 0 returns the input
 * unchanged (a copy); at amount 1 the follow factor is 0.1, so jitter
 * is heavily damped at the cost of corner lag — the standard
 * stabilizer trade-off. Pressure is smoothed along with position and
 * is always materialized in the output when amount > 0.
 */
export function smoothStrokePoints(points: StrokePoint[], amount: number): StrokePoint[] {
  if (!Number.isFinite(amount) || amount < 0 || amount > 1) throw new Error(`Smoothing amount out of range: ${amount}`);
  assertStrokePoints(points);
  if (points.length === 0 || amount === 0) return points.map((p) => ({ ...p }));
  const k = 1 - amount * 0.9;
  const out: StrokePoint[] = [{ x: points[0].x, y: points[0].y, pressure: pointPressure(points[0]) }];
  for (let i = 1; i < points.length; i++) {
    const prev = out[i - 1];
    out.push({
      x: prev.x + (points[i].x - prev.x) * k,
      y: prev.y + (points[i].y - prev.y) * k,
      pressure: prev.pressure! + (pointPressure(points[i]) - prev.pressure!) * k
    });
  }
  return out;
}

interface PathPoint {
  x: number;
  y: number;
  pressure: number;
}

/** Bilinear sample of a tip raster with edge clamping (the resizeImage convention). */
function sampleTipBilinear(tip: BrushTip, u: number, v: number): number {
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const s = (xx: number, yy: number): number =>
    tip.data[Math.min(tip.height - 1, Math.max(0, yy)) * tip.width + Math.min(tip.width - 1, Math.max(0, xx))];
  return (
    s(x0, y0) * (1 - fx) * (1 - fy) + s(x0 + 1, y0) * fx * (1 - fy) + s(x0, y0 + 1) * (1 - fx) * fy + s(x0 + 1, y0 + 1) * fx * fy
  );
}

/**
 * Accumulate a stroke's coverage map (values 0..1, before the opacity
 * cap). Stamps are placed every `spacing × size` pixels along the
 * path with the leftover distance carried across segments, and
 * pressure is interpolated linearly between path points.
 */
function strokeCoverage(width: number, height: number, points: StrokePoint[], settings: BrushSettings): Float32Array {
  assertBrushSettings(settings);
  assertStrokePoints(points);
  const cov = new Float32Array(width * height);
  if (points.length === 0) return cov;
  const smoothed = settings.smoothing > 0 ? smoothStrokePoints(points, settings.smoothing) : points;
  const path: PathPoint[] = smoothed.map((p) => ({ x: p.x, y: p.y, pressure: pointPressure(p) }));
  const step = Math.max(settings.spacing * settings.size, 0.5);

  const stampAt = (cx: number, cy: number, pressure: number): void => {
    const diameter = settings.size * (settings.pressureSize ? pressure : 1);
    const r = diameter / 2;
    if (r < 0.25) return; // pressure (or size) too small to leave a mark
    const strength = settings.flow * (settings.pressureOpacity ? pressure : 1);
    if (strength <= 0) return;
    const deposit = (idx: number, shape: number): void => {
      if (shape <= 0) return;
      const d = shape * strength;
      cov[idx] += d * (1 - cov[idx]);
    };
    if (settings.tip) {
      const tip = settings.tip;
      const left = Math.round(cx - r);
      const top = Math.round(cy - r);
      const side = Math.max(1, Math.round(diameter));
      for (let fy = 0; fy < side; fy++) {
        const y = top + fy;
        if (y < 0 || y >= height) continue;
        const v = ((fy + 0.5) * tip.height) / side - 0.5;
        for (let fx = 0; fx < side; fx++) {
          const x = left + fx;
          if (x < 0 || x >= width) continue;
          const u = ((fx + 0.5) * tip.width) / side - 0.5;
          deposit(y * width + x, sampleTipBilinear(tip, u, v) / 255);
        }
      }
    } else {
      const x0 = Math.floor(cx - r);
      const x1 = Math.ceil(cx + r);
      const y0 = Math.floor(cy - r);
      const y1 = Math.ceil(cy + r);
      for (let y = y0; y <= y1; y++) {
        if (y < 0 || y >= height) continue;
        for (let x = x0; x <= x1; x++) {
          if (x < 0 || x >= width) continue;
          deposit(y * width + x, roundProfile(Math.hypot(x - cx, y - cy) / r, settings.hardness));
        }
      }
    }
  };

  let prev = path[0];
  stampAt(prev.x, prev.y, prev.pressure);
  let carry = 0; // distance traveled since the last stamp
  for (let s = 1; s < path.length; s++) {
    const cur = path[s];
    const segLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    if (segLen > 0) {
      let d = step - carry;
      while (d <= segLen) {
        const t = d / segLen;
        stampAt(
          prev.x + (cur.x - prev.x) * t,
          prev.y + (cur.y - prev.y) * t,
          prev.pressure + (cur.pressure - prev.pressure) * t
        );
        d += step;
      }
      carry = segLen - d + step;
    }
    prev = cur;
  }
  return cov;
}

export interface BrushStrokeOptions {
  /** Phase 19 rect selection scoping. */
  selection?: Rect | null;
  /** Phase 45 raster selection scoping: coverage is scaled by value/255. Must match the layer size. */
  selectionMask?: SelectionMask | null;
}

/** Per-pixel stroke alpha: coverage × opacity, scoped by the rect selection and/or the raster selection. */
function strokeAlphas(
  layer: Layer,
  cov: Float32Array,
  settings: BrushSettings,
  options?: BrushStrokeOptions
): Float32Array {
  const { width, height } = layer.image;
  const selMask = options?.selectionMask ?? null;
  if (selMask && (selMask.width !== width || selMask.height !== height)) {
    throw new Error(`Selection size ${selMask.width}x${selMask.height} does not match layer size ${width}x${height}`);
  }
  const out = new Float32Array(cov.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (cov[idx] <= 0) continue;
      if (!inSelection(x, y, options?.selection)) continue;
      let a = cov[idx] * settings.opacity;
      if (selMask) a *= selMask.data[idx] / 255;
      out[idx] = a;
    }
  }
  return out;
}

/**
 * Paint an advanced-brush stroke: size/hardness/spacing/opacity/flow,
 * optional pressure routing, smoothing and custom tips, applied
 * through the shared paint path (Phase 44 alpha lock honored).
 */
export function paintBrushStroke(
  project: ImageProject,
  layerId: string,
  points: StrokePoint[],
  settings: BrushSettings,
  color: RgbaColor,
  options?: BrushStrokeOptions
): void {
  const layer = requirePaintableLayer(project, layerId);
  const cov = strokeCoverage(layer.image.width, layer.image.height, points, settings);
  const alphas = strokeAlphas(layer, cov, settings, options);
  const data = layer.image.data;
  for (let px = 0, p = 0; px < alphas.length; px++, p += 4) {
    if (alphas[px] <= 0) continue;
    blendPaint(data, p, color.r, color.g, color.b, alphas[px], layer.alphaLock);
  }
}

/**
 * Erase with the advanced brush: alpha is scaled by
 * (1 − opacity × coverage) along the stroke. Like the Phase 19
 * eraser, this only ever changes alpha, so an alpha-locked layer is
 * left untouched.
 */
export function eraseBrushStroke(
  project: ImageProject,
  layerId: string,
  points: StrokePoint[],
  settings: BrushSettings,
  options?: BrushStrokeOptions
): void {
  const layer = requirePaintableLayer(project, layerId);
  if (layer.alphaLock) return;
  const cov = strokeCoverage(layer.image.width, layer.image.height, points, settings);
  const alphas = strokeAlphas(layer, cov, settings, options);
  const data = layer.image.data;
  for (let px = 0, p = 0; px < alphas.length; px++, p += 4) {
    if (alphas[px] <= 0) continue;
    data[p + 3] = Math.round(data[p + 3] * (1 - alphas[px]));
    if (data[p + 3] === 0) {
      data[p] = data[p + 1] = data[p + 2] = 0;
    }
  }
}

// ---------------------------------------------------------------- brush presets (Phase 46)

/**
 * Built-in presets. They are ordinary presets — same model, same
 * serialization — with distinct, purposeful parameters.
 */
export const BUILT_IN_BRUSH_PRESETS: BrushPreset[] = [
  {
    name: 'Hard Round',
    settings: createBrushSettings({ size: 12, hardness: 1, spacing: 0.1, opacity: 1, flow: 1 })
  },
  {
    name: 'Soft Round',
    settings: createBrushSettings({ size: 24, hardness: 0, spacing: 0.25, opacity: 1, flow: 1 })
  },
  {
    name: 'Airbrush',
    settings: createBrushSettings({ size: 30, hardness: 0, spacing: 0.05, opacity: 0.8, flow: 0.08 })
  },
  {
    name: 'Speckle Tip',
    settings: createBrushSettings({
      size: 8,
      hardness: 1,
      spacing: 0.5,
      opacity: 1,
      flow: 1,
      tip: createBrushTip(4, 4, new Uint8Array([255, 0, 128, 0, 0, 255, 0, 64, 128, 0, 255, 0, 0, 64, 0, 255]))
    })
  },
  {
    name: 'Pen Pressure Pen',
    settings: createBrushSettings({
      size: 16,
      hardness: 0.9,
      spacing: 0.1,
      opacity: 1,
      flow: 1,
      pressureSize: true,
      pressureOpacity: true
    })
  }
];

/** Look up a built-in preset by name. Throws when the name is unknown. */
export function getBrushPreset(name: string): BrushPreset {
  const preset = BUILT_IN_BRUSH_PRESETS.find((p) => p.name === name);
  if (!preset) {
    throw new Error(`Unknown brush preset: ${name} (expected one of ${BUILT_IN_BRUSH_PRESETS.map((p) => p.name).join(', ')})`);
  }
  // Return a copy so callers can tweak settings without mutating the library.
  return { name: preset.name, settings: createBrushSettings(preset.settings) };
}

/** Serialize a preset to its JSON-safe form (tip bytes as base64). */
export function serializeBrushPreset(preset: BrushPreset): SerializedBrushPreset {
  assertBrushSettings(preset.settings);
  const s = preset.settings;
  return {
    format: 'squadforge-brush-preset',
    version: 1,
    name: preset.name,
    settings: {
      size: s.size,
      hardness: s.hardness,
      spacing: s.spacing,
      opacity: s.opacity,
      flow: s.flow,
      smoothing: s.smoothing,
      pressureSize: s.pressureSize,
      pressureOpacity: s.pressureOpacity,
      tip: s.tip ? { width: s.tip.width, height: s.tip.height, dataBase64: Buffer.from(s.tip.data).toString('base64') } : null
    }
  };
}

/** Load a preset from its serialized form. Corrupt or out-of-range data is rejected, never silently loaded. */
export function deserializeBrushPreset(data: SerializedBrushPreset): BrushPreset {
  if (!data || data.format !== 'squadforge-brush-preset' || data.version !== 1) {
    throw new Error('Not a SquadForge brush preset (bad format/version)');
  }
  if (typeof data.name !== 'string' || data.name.length === 0) throw new Error('Brush preset needs a name');
  const s = data.settings;
  if (!s) throw new Error('Brush preset has no settings');
  let tip: BrushTip | null = null;
  if (s.tip !== null && s.tip !== undefined) {
    const buf = Buffer.from(s.tip.dataBase64 ?? '', 'base64');
    if (buf.length !== s.tip.width * s.tip.height) {
      throw new Error(`Brush preset tip data size mismatch: ${buf.length} != ${s.tip.width * s.tip.height}`);
    }
    tip = { width: s.tip.width, height: s.tip.height, data: new Uint8ClampedArray(buf) };
  }
  const settings = createBrushSettings({
    size: s.size,
    hardness: s.hardness,
    spacing: s.spacing,
    opacity: s.opacity,
    flow: s.flow,
    smoothing: s.smoothing,
    pressureSize: s.pressureSize === true,
    pressureOpacity: s.pressureOpacity === true,
    tip
  });
  return { name: data.name, settings };
}

// ---------------------------------------------------------------- color sampling (Phase 46)

/** Average an image's pixels over the (2·radius+1)² window around (x, y), clipped at the image edges. */
function sampleAverage(img: PixelImage, x: number, y: number, radius: number): RgbaColor {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= img.width || y >= img.height) {
    throw new Error(`Sample point out of bounds: (${x}, ${y}) in ${img.width}x${img.height}`);
  }
  if (!Number.isInteger(radius) || radius < 0) throw new Error(`Sample radius out of range: ${radius}`);
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let n = 0;
  for (let yy = Math.max(0, y - radius); yy <= Math.min(img.height - 1, y + radius); yy++) {
    for (let xx = Math.max(0, x - radius); xx <= Math.min(img.width - 1, x + radius); xx++) {
      const c = getPixel(img, xx, yy);
      r += c.r;
      g += c.g;
      b += c.b;
      a += c.a;
      n++;
    }
  }
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), a: Math.round(a / n) };
}

/**
 * Eyedropper over the flattened canvas: the color the user actually
 * sees at (x, y) — the full composite (layers, masks, groups, blend
 * modes). With radius > 0, the average over the surrounding window.
 */
export function sampleColor(project: ImageProject, x: number, y: number, radius = 0): RgbaColor {
  return sampleAverage(composite(project), x, y, radius);
}

/** Eyedropper over a single layer's own pixels (no compositing). */
export function sampleLayerColor(project: ImageProject, layerId: string, x: number, y: number, radius = 0): RgbaColor {
  return sampleAverage(getLayer(project, layerId).image, x, y, radius);
}

// ---------------------------------------------------------------- transforms

/** Phase 44: single-channel mask transforms, mirroring the image ones so masks stay aligned with their layer. */
function cropMask(mask: LayerMask, rect: Rect): LayerMask {
  const out: LayerMask = { width: rect.width, height: rect.height, data: new Uint8ClampedArray(rect.width * rect.height) };
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      out.data[y * rect.width + x] = mask.data[(rect.y + y) * mask.width + (rect.x + x)];
    }
  }
  return out;
}

function resizeMask(mask: LayerMask, newWidth: number, newHeight: number): LayerMask {
  const out: LayerMask = { width: newWidth, height: newHeight, data: new Uint8ClampedArray(newWidth * newHeight) };
  const xScale = mask.width / newWidth;
  const yScale = mask.height / newHeight;
  const sample = (xx: number, yy: number): number =>
    mask.data[Math.min(mask.height - 1, Math.max(0, yy)) * mask.width + Math.min(mask.width - 1, Math.max(0, xx))];
  for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
      const sx = (x + 0.5) * xScale - 0.5;
      const sy = (y + 0.5) * yScale - 0.5;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      out.data[y * newWidth + x] = Math.round(
        sample(x0, y0) * (1 - fx) * (1 - fy) +
          sample(x0 + 1, y0) * fx * (1 - fy) +
          sample(x0, y0 + 1) * (1 - fx) * fy +
          sample(x0 + 1, y0 + 1) * fx * fy
      );
    }
  }
  return out;
}

function rotateMask(mask: LayerMask, degrees: 90 | 180 | 270): LayerMask {
  if (degrees === 180) {
    const out: LayerMask = { width: mask.width, height: mask.height, data: new Uint8ClampedArray(mask.data.length) };
    for (let y = 0; y < mask.height; y++) {
      for (let x = 0; x < mask.width; x++) {
        out.data[(mask.height - 1 - y) * mask.width + (mask.width - 1 - x)] = mask.data[y * mask.width + x];
      }
    }
    return out;
  }
  const out: LayerMask = { width: mask.height, height: mask.width, data: new Uint8ClampedArray(mask.data.length) };
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (degrees === 90) out.data[x * mask.height + (mask.height - 1 - y)] = mask.data[y * mask.width + x];
      else out.data[(mask.width - 1 - x) * mask.height + y] = mask.data[y * mask.width + x];
    }
  }
  return out;
}

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
    if (layer.mask) layer.mask = cropMask(layer.mask, rect);
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
    if (layer.mask) layer.mask = resizeMask(layer.mask, newWidth, newHeight);
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
    if (layer.mask) layer.mask = rotateMask(layer.mask, degrees);
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

// ---------------------------------------------------------------- free transforms & perspective (Phase 45)

/**
 * Phase 45: free rotation, perspective warps and the handle transform
 * model, all built on one warp core. A warp is a 3x3 projective matrix
 * (row-major, Mat3) mapping SOURCE pixel coordinates to DESTINATION
 * pixel coordinates; rendering inverts it and bilinear-samples the
 * source. Pixel (x, y) is sampled at the point (x, y) exactly — the
 * convention that makes a 90° free rotation reproduce rotateImage
 * bit-for-bit. Samples outside the source are transparent (for images)
 * or 0 (for selections/masks); weights are not renormalized at edges.
 * Resampling rule: bilinear everywhere in this section.
 */
type Mat3 = [number, number, number, number, number, number, number, number, number];

function mat3Multiply(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9) as Mat3;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

function mat3Invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    throw new Error('Transform is singular (not invertible)');
  }
  const s = 1 / det;
  return [
    (e * i - f * h) * s,
    (c * h - b * i) * s,
    (b * f - c * e) * s,
    (f * g - d * i) * s,
    (a * i - c * g) * s,
    (c * d - a * f) * s,
    (d * h - e * g) * s,
    (b * g - a * h) * s,
    (a * e - b * d) * s
  ];
}

function translationMatrix(tx: number, ty: number): Mat3 {
  return [1, 0, tx, 0, 1, ty, 0, 0, 1];
}

/** Snap cos/sin to exact 0/±1 near multiples of 90° so right-angle warps stay pixel-exact. */
function snapTrig(v: number): number {
  if (Math.abs(v) < 1e-12) return 0;
  if (Math.abs(v - 1) < 1e-12) return 1;
  if (Math.abs(v + 1) < 1e-12) return -1;
  return v;
}

/**
 * Rotation about (cx, cy) by `degrees`, in the engine's existing
 * convention: +90° here maps a pixel exactly where rotateImage(90)
 * puts it (verified by test against the exact step rotation).
 */
function rotationMatrixAbout(cx: number, cy: number, degrees: number): Mat3 {
  if (!Number.isFinite(degrees)) throw new Error(`Rotation angle out of range: ${degrees}`);
  const rad = (degrees * Math.PI) / 180;
  const cos = snapTrig(Math.cos(rad));
  const sin = snapTrig(Math.sin(rad));
  const rot: Mat3 = [cos, -sin, 0, sin, cos, 0, 0, 0, 1];
  return mat3Multiply(translationMatrix(cx, cy), mat3Multiply(rot, translationMatrix(-cx, -cy)));
}

/** Bilinear sample of an RGBA image at a fractional point; outside the image counts as transparent black. */
function sampleBilinearZero(img: PixelImage, sx: number, sy: number): [number, number, number, number] {
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const fx = sx - x0;
  const fy = sy - y0;
  const acc: [number, number, number, number] = [0, 0, 0, 0];
  const corners: Array<[number, number, number]> = [
    [x0, y0, (1 - fx) * (1 - fy)],
    [x0 + 1, y0, fx * (1 - fy)],
    [x0, y0 + 1, (1 - fx) * fy],
    [x0 + 1, y0 + 1, fx * fy]
  ];
  for (const [cx, cy, wgt] of corners) {
    if (wgt === 0 || cx < 0 || cy < 0 || cx >= img.width || cy >= img.height) continue;
    const i = (cy * img.width + cx) * 4;
    acc[0] += img.data[i] * wgt;
    acc[1] += img.data[i + 1] * wgt;
    acc[2] += img.data[i + 2] * wgt;
    acc[3] += img.data[i + 3] * wgt;
  }
  return acc;
}

/** Bilinear sample of a single-channel raster at a fractional point; outside counts as 0. */
function sampleChannelZero(data: Uint8ClampedArray, width: number, height: number, sx: number, sy: number): number {
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const fx = sx - x0;
  const fy = sy - y0;
  let acc = 0;
  const corners: Array<[number, number, number]> = [
    [x0, y0, (1 - fx) * (1 - fy)],
    [x0 + 1, y0, fx * (1 - fy)],
    [x0, y0 + 1, (1 - fx) * fy],
    [x0 + 1, y0 + 1, fx * fy]
  ];
  for (const [cx, cy, wgt] of corners) {
    if (wgt === 0 || cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
    acc += data[cy * width + cx] * wgt;
  }
  return acc;
}

/** Warp an image by a source→destination matrix, keeping the canvas size. */
function warpImage(img: PixelImage, forward: Mat3): PixelImage {
  const inv = mat3Invert(forward);
  const out = createPixelImage(img.width, img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const sw = inv[6] * x + inv[7] * y + inv[8];
      if (Math.abs(sw) < 1e-12) continue;
      const sx = (inv[0] * x + inv[1] * y + inv[2]) / sw;
      const sy = (inv[3] * x + inv[4] * y + inv[5]) / sw;
      const [r, g, b, a] = sampleBilinearZero(img, sx, sy);
      const i = (y * img.width + x) * 4;
      out.data[i] = Math.round(r);
      out.data[i + 1] = Math.round(g);
      out.data[i + 2] = Math.round(b);
      out.data[i + 3] = Math.round(a);
    }
  }
  return out;
}

/** Warp a single-channel raster (selection or layer mask) by a source→destination matrix, keeping the canvas size. */
function warpChannel(data: Uint8ClampedArray, width: number, height: number, forward: Mat3): Uint8ClampedArray {
  const inv = mat3Invert(forward);
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sw = inv[6] * x + inv[7] * y + inv[8];
      if (Math.abs(sw) < 1e-12) continue;
      const sx = (inv[0] * x + inv[1] * y + inv[2]) / sw;
      const sy = (inv[3] * x + inv[4] * y + inv[5]) / sw;
      out[y * width + x] = Math.round(sampleChannelZero(data, width, height, sx, sy));
    }
  }
  return out;
}

/** Rotate an image by an arbitrary angle about its centre; the canvas size is unchanged (corners may clip). Bilinear. */
export function rotateImageFree(img: PixelImage, degrees: number): PixelImage {
  return warpImage(img, rotationMatrixAbout((img.width - 1) / 2, (img.height - 1) / 2, degrees));
}

/** Rotate a selection by an arbitrary angle about its centre; the canvas size is unchanged. Bilinear. */
export function rotateSelectionFree(sel: SelectionMask, degrees: number): SelectionMask {
  const m = rotationMatrixAbout((sel.width - 1) / 2, (sel.height - 1) / 2, degrees);
  return { width: sel.width, height: sel.height, data: warpChannel(sel.data, sel.width, sel.height, m) };
}

/** Rotate a layer (and its Phase 44 mask, so they stay aligned) by an arbitrary angle about the layer centre. */
export function rotateLayerFree(project: ImageProject, layerId: string, degrees: number): void {
  const layer = getLayer(project, layerId);
  if (layer.kind === 'adjustment') {
    throw new Error(`Layer "${layer.name}" is an adjustment layer; it has no pixels to transform`);
  }
  const m = rotationMatrixAbout((layer.image.width - 1) / 2, (layer.image.height - 1) / 2, degrees);
  // Phase 48: content layers compose the warp into their placement
  // matrix and re-render, so their data stays editable.
  // Phase 52: placed raster layers compose into their placement too.
  const placed = layer.kind === 'raster' && layer.placement !== null;
  if (layer.kind === 'raster') {
    if (placed) {
      layer.placement = [...mat3Multiply(m, layer.placement as Mat3)];
    } else {
      layer.image = warpImage(layer.image, m);
    }
  } else {
    composeContentPlacement(project, layer, m);
  }
  if (layer.mask && !placed) {
    layer.mask = { ...layer.mask, data: warpChannel(layer.mask.data, layer.mask.width, layer.mask.height, m) };
  }
}

/**
 * Solve the homography (3x3, h33 = 1) mapping four source points to
 * four destination points, by Gaussian elimination on the standard
 * 8x8 system. Throws when the point configuration is degenerate
 * (e.g. three collinear points, or a 1x1 image's coincident corners).
 */
export function solveHomography(src: [Point, Point, Point, Point], dst: [Point, Point, Point, Point]): number[] {
  const rows: number[][] = [];
  for (let n = 0; n < 4; n++) {
    const { x, y } = src[n];
    const { x: u, y: v } = dst[n];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let col = 0, row = 0; col < 8 && row < 8; col++, row++) {
    let pivot = row;
    for (let r = row + 1; r < 8; r++) {
      if (Math.abs(rows[r][col]) > Math.abs(rows[pivot][col])) pivot = r;
    }
    if (Math.abs(rows[pivot][col]) < 1e-12) throw new Error('Perspective corners are degenerate (no unique homography)');
    [rows[row], rows[pivot]] = [rows[pivot], rows[row]];
    const div = rows[row][col];
    for (let c = col; c < 9; c++) rows[row][c] /= div;
    for (let r = 0; r < 8; r++) {
      if (r === row) continue;
      const factor = rows[r][col];
      if (factor === 0) continue;
      for (let c = col; c < 9; c++) rows[r][c] -= factor * rows[row][c];
    }
  }
  const h = rows.map((r) => r[8]);
  const m: Mat3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  // The linear system can still "solve" for degenerate configurations
  // (e.g. three destination corners on one line) by producing a
  // singular matrix that collapses the image — reject those, and any
  // solution that does not actually map the corners where asked.
  const [a, b, c, d, e, f, g, hh, i] = m;
  const det = a * (e * i - f * hh) - b * (d * i - f * g) + c * (d * hh - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    throw new Error('Perspective corners are degenerate (no unique homography)');
  }
  for (let n = 0; n < 4; n++) {
    const w = m[6] * src[n].x + m[7] * src[n].y + m[8];
    const u = (m[0] * src[n].x + m[1] * src[n].y + m[2]) / w;
    const v = (m[3] * src[n].x + m[4] * src[n].y + m[5]) / w;
    if (!Number.isFinite(u) || !Number.isFinite(v) || Math.abs(u - dst[n].x) > 1e-6 || Math.abs(v - dst[n].y) > 1e-6) {
      throw new Error('Perspective corners are degenerate (no unique homography)');
    }
  }
  return m;
}

function assertCorners(corners: [Point, Point, Point, Point]): void {
  if (!Array.isArray(corners) || corners.length !== 4 || corners.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
    throw new Error('Perspective needs exactly 4 finite corner points (TL, TR, BR, BL)');
  }
}

/**
 * Perspective-warp an image: the source corners (0,0), (W−1,0),
 * (W−1,H−1), (0,H−1) are moved to `corners` (TL, TR, BR, BL, in canvas
 * coordinates). The canvas size is unchanged; content warped outside
 * the canvas is clipped. Bilinear resampling.
 */
export function perspectiveImage(img: PixelImage, corners: [Point, Point, Point, Point]): PixelImage {
  assertCorners(corners);
  const src: [Point, Point, Point, Point] = [
    { x: 0, y: 0 },
    { x: img.width - 1, y: 0 },
    { x: img.width - 1, y: img.height - 1 },
    { x: 0, y: img.height - 1 }
  ];
  return warpImage(img, solveHomography(src, corners) as Mat3);
}

/** Perspective-warp a selection with the same corner convention as perspectiveImage. */
export function perspectiveSelection(sel: SelectionMask, corners: [Point, Point, Point, Point]): SelectionMask {
  assertCorners(corners);
  const src: [Point, Point, Point, Point] = [
    { x: 0, y: 0 },
    { x: sel.width - 1, y: 0 },
    { x: sel.width - 1, y: sel.height - 1 },
    { x: 0, y: sel.height - 1 }
  ];
  const m = solveHomography(src, corners) as Mat3;
  return { width: sel.width, height: sel.height, data: warpChannel(sel.data, sel.width, sel.height, m) };
}

/** Perspective-warp a layer (and its Phase 44 mask, so they stay aligned). */
export function perspectiveLayer(project: ImageProject, layerId: string, corners: [Point, Point, Point, Point]): void {
  const layer = getLayer(project, layerId);
  if (layer.kind === 'adjustment') {
    throw new Error(`Layer "${layer.name}" is an adjustment layer; it has no pixels to transform`);
  }
  // Phase 52: a placed raster layer composes the homography into its
  // placement, like a content layer — pristine pixels/mask untouched.
  const placed = layer.kind === 'raster' && layer.placement !== null;
  if (layer.kind === 'raster' && !placed) {
    layer.image = perspectiveImage(layer.image, corners);
  } else {
    // Phase 48: compose the same homography perspectiveImage would
    // apply into the placement, then (for content layers) re-render.
    assertCorners(corners);
    const src: [Point, Point, Point, Point] = [
      { x: 0, y: 0 },
      { x: layer.image.width - 1, y: 0 },
      { x: layer.image.width - 1, y: layer.image.height - 1 },
      { x: 0, y: layer.image.height - 1 }
    ];
    const h = solveHomography(src, corners) as Mat3;
    if (placed) {
      layer.placement = [...mat3Multiply(h, layer.placement as Mat3)];
    } else {
      composeContentPlacement(project, layer, h);
    }
  }
  if (layer.mask && !placed) {
    const warped = perspectiveSelection({ width: layer.mask.width, height: layer.mask.height, data: layer.mask.data }, corners);
    layer.mask = { ...layer.mask, data: warped.data };
  }
}

/** The identity transform about a centre (the starting state of the transform handles). */
export function identityTransform(centerX = 0, centerY = 0): Transform2D {
  return { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotationDeg: 0, centerX, centerY };
}

function assertTransform(t: Transform2D): void {
  for (const key of ['translateX', 'translateY', 'scaleX', 'scaleY', 'rotationDeg', 'centerX', 'centerY'] as const) {
    if (!Number.isFinite(t[key])) throw new Error(`Transform field ${key} out of range: ${t[key]}`);
  }
  if (t.scaleX === 0 || t.scaleY === 0) throw new Error('Transform scale must be non-zero');
}

/**
 * The source→destination matrix of a Transform2D: scale, then rotate,
 * both about the transform centre, then translate.
 */
export function transformMatrix(t: Transform2D): number[] {
  assertTransform(t);
  const scale: Mat3 = [t.scaleX, 0, 0, 0, t.scaleY, 0, 0, 0, 1];
  const aboutCentre = mat3Multiply(
    translationMatrix(t.centerX, t.centerY),
    mat3Multiply(rotationMatrixAbout(0, 0, t.rotationDeg), mat3Multiply(scale, translationMatrix(-t.centerX, -t.centerY)))
  );
  return mat3Multiply(translationMatrix(t.translateX, t.translateY), aboutCentre);
}

/** Apply a Transform2D to an image (bilinear warp, canvas size unchanged). */
export function applyTransformToImage(img: PixelImage, t: Transform2D): PixelImage {
  return warpImage(img, transformMatrix(t) as Mat3);
}

/** Apply a Transform2D to a selection (bilinear warp, canvas size unchanged). */
export function applyTransformToSelection(sel: SelectionMask, t: Transform2D): SelectionMask {
  const m = transformMatrix(t) as Mat3;
  return { width: sel.width, height: sel.height, data: warpChannel(sel.data, sel.width, sel.height, m) };
}

/** Apply a Transform2D to a layer's pixels and its Phase 44 mask (so they stay aligned). */
export function transformLayer(project: ImageProject, layerId: string, t: Transform2D): void {
  const layer = getLayer(project, layerId);
  if (layer.kind === 'adjustment') {
    throw new Error(`Layer "${layer.name}" is an adjustment layer; it has no pixels to transform`);
  }
  const m = transformMatrix(t) as Mat3;
  // Phase 48: content layers compose the transform into their
  // placement matrix and re-render from their editable data instead
  // of warping the render cache — the transform becomes placement
  // data and the content stays editable.
  // Phase 52: a raster layer WITH a placement composes the transform
  // into its placement matrix the same way — pristine pixels and the
  // stored mask stay untouched (the mask warps with the placement at
  // render time). A raster layer without one keeps the Phase 45
  // behavior: the warp is baked into the pixels and the mask.
  const placed = layer.kind === 'raster' && layer.placement !== null;
  if (layer.kind === 'raster') {
    if (placed) {
      layer.placement = [...mat3Multiply(m, layer.placement as Mat3)];
    } else {
      layer.image = warpImage(layer.image, m);
    }
  } else {
    composeContentPlacement(project, layer, m);
  }
  if (layer.mask && !placed) {
    layer.mask = { ...layer.mask, data: warpChannel(layer.mask.data, layer.mask.width, layer.mask.height, m) };
  }
}

/** Apply a Transform2D to every layer in a group's subtree (nested groups included), masks included. */
export function transformGroup(project: ImageProject, groupId: string, t: Transform2D): void {
  getGroup(project, groupId); // group must exist
  const m = transformMatrix(t) as Mat3;
  for (const layer of project.layers) {
    if (!groupChainOf(project, layer).includes(groupId)) continue;
    // Phase 52: adjustment layers have no pixels to move; they are
    // skipped (their masks stay canvas-aligned, as their effect is).
    if (layer.kind === 'adjustment') continue;
    // Phase 52: placed raster layers compose into their placement
    // (see transformLayer); their stored masks stay untouched.
    const placed = layer.kind === 'raster' && layer.placement !== null;
    if (layer.kind === 'raster') {
      if (placed) {
        layer.placement = [...mat3Multiply(m, layer.placement as Mat3)];
      } else {
        layer.image = warpImage(layer.image, m);
      }
    } else {
      composeContentPlacement(project, layer, m);
    }
    if (layer.mask && !placed) {
      layer.mask = { ...layer.mask, data: warpChannel(layer.mask.data, layer.mask.width, layer.mask.height, m) };
    }
  }
}

// ---------------------------------------------------------------- adjustments

type PixelFn = (c: RgbaColor) => RgbaColor;

function applyAdjustment(project: ImageProject, layerId: string, fn: PixelFn, selection?: Rect | null): void {
  const img = requirePaintableLayer(project, layerId).image;
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

// ---------------------------------------------------------------- filters & effects (Phase 47)

/**
 * Phase 47: professional filters and effects, behind one registry.
 *
 * Every filter is a pure function PixelImage -> PixelImage: it reads
 * its input and returns a new image, never mutating the input. The
 * registry pairs each implementation with a FilterDescriptor (id,
 * display name, parameter schema), and the only ways in are the
 * validated entry points:
 *
 *   applyFilterToImage(img, id, params)   — pure, whole-image
 *   applyFilter(project, layerId, ...)    — writes the layer, scoped
 *   previewFilter / previewFilterRegion   — same math, project untouched
 *
 * Parameters are validated against the schema: an unknown filter id,
 * an unknown parameter name, a non-finite value or a value outside
 * the declared range all throw. Missing parameters take the schema
 * defaults. Only filters that are genuinely implemented here appear
 * in the registry — there is no placeholder entry.
 *
 * Alpha handling, per filter family (also noted per implementation):
 * point color effects preserve alpha (the Phase 19 adjustment rule);
 * the two blurs convolve all four channels, as a raster blur does;
 * sharpen/noise/edge-detect/emboss compute RGB and preserve alpha;
 * the distortions resample all four channels like the Phase 45 warps.
 *
 * Scoping: applyFilter computes the filtered layer in full, then
 * blends it with the original per pixel by the scope weight — 0/1
 * for the Phase 19 rect, value/255 for the Phase 45 raster selection
 * (both combine multiplicatively). A layer's Phase 44 mask is NOT
 * baked in or altered: it keeps modulating compositing exactly as
 * before. Like the Phase 19 adjustments, filters ignore the alpha
 * lock (the lock constrains paint tools, not adjustments).
 */

type FilterImpl = (img: PixelImage, params: Record<string, number>) => PixelImage;

interface FilterEntry {
  descriptor: FilterDescriptor;
  apply: FilterImpl;
}

const clampIndex = (v: number, size: number) => Math.min(size - 1, Math.max(0, v));

/** Rec.601 luminance, the same weights adjustSaturation uses. */
function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Apply a per-pixel function to every pixel of a new image; the input is not mutated. */
function mapPixels(img: PixelImage, fn: (c: RgbaColor) => RgbaColor): PixelImage {
  const out = createPixelImage(img.width, img.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const c = fn({ r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: img.data[i + 3] });
    out.data[i] = c.r;
    out.data[i + 1] = c.g;
    out.data[i + 2] = c.b;
    out.data[i + 3] = c.a;
  }
  return out;
}

/**
 * Separable convolution of all four channels with a symmetric kernel
 * (edge pixels replicate). Computed in float and rounded once at the
 * end, so a normalized kernel leaves a uniform image exactly uniform.
 */
function separableConvolve(img: PixelImage, kernel: number[]): PixelImage {
  return separableConvolveRows(img, kernel, 0, img.height);
}

/**
 * Phase 51: separable convolution restricted to output rows
 * [y0, y1), returning a width × (y1 − y0) image. The horizontal pass
 * is computed for exactly the rows the vertical pass can read — the
 * band plus its radius halo, clamped to the image — and every sum
 * runs in the same order over the same values as the full-image
 * version, so a band's rows are byte-identical to the same rows of
 * `separableConvolve`'s output. This is the seam the parallel CPU
 * provider splits blur work along.
 */
export function separableConvolveRows(img: PixelImage, kernel: number[], y0: number, y1: number): PixelImage {
  const r = (kernel.length - 1) / 2;
  const { width, height } = img;
  if (!Number.isInteger(y0) || !Number.isInteger(y1) || y0 < 0 || y1 > height || y0 >= y1) {
    throw new Error(`Invalid convolution row band [${y0}, ${y1}) for image height ${height}`);
  }
  const tmpY0 = Math.max(0, y0 - r);
  const tmpY1 = Math.min(height, y1 + r);
  const tmp = new Float32Array((tmpY1 - tmpY0) * width * 4);
  for (let y = tmpY0; y < tmpY1; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let k = 0; k < kernel.length; k++) {
          sum += kernel[k] * img.data[(y * width + clampIndex(x + k - r, width)) * 4 + c];
        }
        tmp[((y - tmpY0) * width + x) * 4 + c] = sum;
      }
    }
  }
  const out = createPixelImage(width, y1 - y0);
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let k = 0; k < kernel.length; k++) {
          sum += kernel[k] * tmp[((clampIndex(y + k - r, height) - tmpY0) * width + x) * 4 + c];
        }
        out.data[((y - y0) * width + x) * 4 + c] = Math.round(sum);
      }
    }
  }
  return out;
}

/** 3x3 convolution of the RGB channels (edge pixels replicate); alpha is copied unchanged. */
function convolve3x3Rgb(img: PixelImage, kernel: number[]): PixelImage {
  const { width, height } = img;
  const out = createPixelImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let ky = 0; ky < 3; ky++) {
          for (let kx = 0; kx < 3; kx++) {
            sum += kernel[ky * 3 + kx] * img.data[(clampIndex(y + ky - 1, height) * width + clampIndex(x + kx - 1, width)) * 4 + c];
          }
        }
        out.data[o + c] = clamp255(sum);
      }
      out.data[o + 3] = img.data[o + 3];
    }
  }
  return out;
}

/** mulberry32: a small deterministic PRNG; the noise filter's seed drives it. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Run an existing Phase 19 project-level adjustment against a bare image, via a throwaway project. */
function viaProject(img: PixelImage, fn: (project: ImageProject, layerId: string) => void): PixelImage {
  const project = createProject(img.width, img.height);
  project.layers[0].image = clonePixelImage(img);
  fn(project, project.layers[0].id);
  return project.layers[0].image;
}

// --- spatial filters ---

/** Uniform box kernel of the given radius (shared by the serial impl and the Phase 51 banded path). */
function boxBlurKernel(radius: number): number[] {
  return new Array<number>(2 * radius + 1).fill(1 / (2 * radius + 1));
}

/** Normalized Gaussian kernel; radius 0 in the parameters means auto (⌈3σ⌉). Shared by the serial impl and the Phase 51 banded path. */
function gaussianKernel(sigma: number, radiusParam: number): number[] {
  const radius = radiusParam > 0 ? Math.round(radiusParam) : Math.max(1, Math.ceil(3 * sigma));
  const kernel: number[] = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(w);
    sum += w;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  return kernel;
}

function boxBlurImpl(img: PixelImage, p: Record<string, number>): PixelImage {
  const radius = Math.round(p.radius);
  if (radius <= 0) return clonePixelImage(img);
  return separableConvolve(img, boxBlurKernel(radius));
}

function gaussianBlurImpl(img: PixelImage, p: Record<string, number>): PixelImage {
  const sigma = p.sigma;
  if (sigma <= 0) return clonePixelImage(img);
  return separableConvolve(img, gaussianKernel(sigma, p.radius));
}

function sharpenImpl(img: PixelImage, p: Record<string, number>): PixelImage {
  const a = p.amount;
  if (a === 0) return clonePixelImage(img);
  return convolve3x3Rgb(img, [0, -a, 0, -a, 1 + 4 * a, -a, 0, -a, 0]);
}

function noiseImpl(img: PixelImage, p: Record<string, number>): PixelImage {
  const amount = p.amount;
  if (amount === 0) return clonePixelImage(img);
  const rand = mulberry32(Math.floor(p.seed));
  return mapPixels(img, (c) => ({
    r: clamp255(c.r + Math.round((rand() * 2 - 1) * amount)),
    g: clamp255(c.g + Math.round((rand() * 2 - 1) * amount)),
    b: clamp255(c.b + Math.round((rand() * 2 - 1) * amount)),
    a: c.a
  }));
}

function edgeDetectImpl(img: PixelImage, p: Record<string, number>): PixelImage {
  const { width, height } = img;
  const lum = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    lum[i] = luminance(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]);
  }
  const at = (x: number, y: number) => lum[clampIndex(y, height) * width + clampIndex(x, width)];
  const out = createPixelImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const gy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let mag = Math.sqrt(gx * gx + gy * gy) * p.strength;
      if (mag < p.threshold) mag = 0;
      const o = (y * width + x) * 4;
      const v = clamp255(mag);
      out.data[o] = v;
      out.data[o + 1] = v;
      out.data[o + 2] = v;
      out.data[o + 3] = img.data[o + 3];
    }
  }
  return out;
}

function embossImpl(img: PixelImage, p: Record<string, number>): PixelImage {
  const { width, height } = img;
  const lum = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    lum[i] = luminance(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]);
  }
  const at = (x: number, y: number) => lum[clampIndex(y, height) * width + clampIndex(x, width)];
  const rad = (p.angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const out = createPixelImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gx = at(x + 1, y) - at(x - 1, y);
      const gy = at(x, y + 1) - at(x, y - 1);
      const v = clamp255(128 + (gx * cos + gy * sin) * p.strength);
      const o = (y * width + x) * 4;
      out.data[o] = v;
      out.data[o + 1] = v;
      out.data[o + 2] = v;
      out.data[o + 3] = img.data[o + 3];
    }
  }
  return out;
}

// --- distortions (inverse-mapped bilinear resampling, the Phase 45 warp convention) ---

function waveImpl(img: PixelImage, p: Record<string, number>): PixelImage {
  const phaseRad = (p.phase * Math.PI) / 180;
  const out = createPixelImage(img.width, img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const sy = y + p.amplitude * Math.sin((2 * Math.PI * x) / p.wavelength + phaseRad);
      const [r, g, b, a] = sampleBilinearZero(img, x, sy);
      const o = (y * img.width + x) * 4;
      out.data[o] = Math.round(r);
      out.data[o + 1] = Math.round(g);
      out.data[o + 2] = Math.round(b);
      out.data[o + 3] = Math.round(a);
    }
  }
  return out;
}

function swirlImpl(img: PixelImage, p: Record<string, number>): PixelImage {
  const { width, height } = img;
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const radius = p.radius > 0 ? p.radius : Math.min(width, height) / 2;
  if (radius <= 0 || p.angle === 0) return clonePixelImage(img);
  const out = createPixelImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      let sx = x;
      let sy = y;
      if (r < radius && r > 0) {
        const factor = (1 - r / radius) * (1 - r / radius);
        const rot = (p.angle * factor * Math.PI) / 180;
        const cos = snapTrig(Math.cos(rot));
        const sin = snapTrig(Math.sin(rot));
        sx = cx + cos * dx + sin * dy;
        sy = cy - sin * dx + cos * dy;
      }
      const [rr, gg, bb, aa] = sampleBilinearZero(img, sx, sy);
      const o = (y * width + x) * 4;
      out.data[o] = Math.round(rr);
      out.data[o + 1] = Math.round(gg);
      out.data[o + 2] = Math.round(bb);
      out.data[o + 3] = Math.round(aa);
    }
  }
  return out;
}

// --- color effects ---

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [(rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255];
}

function hueRotateImpl(img: PixelImage, p: Record<string, number>): PixelImage {
  if (p.degrees === 0) return clonePixelImage(img);
  return mapPixels(img, (c) => {
    const [h, s, l] = rgbToHsl(c.r, c.g, c.b);
    const [r, g, b] = hslToRgb(h + p.degrees, s, l);
    return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: c.a };
  });
}

function sepiaImpl(img: PixelImage, p: Record<string, number>): PixelImage {
  const a = p.amount;
  if (a === 0) return clonePixelImage(img);
  return mapPixels(img, (c) => {
    const sr = 0.393 * c.r + 0.769 * c.g + 0.189 * c.b;
    const sg = 0.349 * c.r + 0.686 * c.g + 0.168 * c.b;
    const sb = 0.272 * c.r + 0.534 * c.g + 0.131 * c.b;
    return {
      r: clamp255(c.r * (1 - a) + sr * a),
      g: clamp255(c.g * (1 - a) + sg * a),
      b: clamp255(c.b * (1 - a) + sb * a),
      a: c.a
    };
  });
}

function posterizeImpl(img: PixelImage, p: Record<string, number>): PixelImage {
  const levels = Math.round(p.levels);
  const quantize = (v: number) => Math.round((Math.round((v / 255) * (levels - 1)) * 255) / (levels - 1));
  return mapPixels(img, (c) => ({ r: quantize(c.r), g: quantize(c.g), b: quantize(c.b), a: c.a }));
}

function thresholdImpl(img: PixelImage, p: Record<string, number>): PixelImage {
  return mapPixels(img, (c) => {
    const v = luminance(c.r, c.g, c.b) >= p.level ? 255 : 0;
    return { r: v, g: v, b: v, a: c.a };
  });
}

// --- the registry ---

const param = (name: string, min: number, max: number, defaultValue: number): FilterParamSpec => ({
  name,
  min,
  max,
  defaultValue
});

const FILTER_ENTRIES: FilterEntry[] = [
  {
    descriptor: { id: 'box-blur', name: 'Box Blur', params: [param('radius', 0, 50, 1)] },
    apply: boxBlurImpl
  },
  {
    descriptor: {
      id: 'gaussian-blur',
      name: 'Gaussian Blur',
      params: [param('sigma', 0, 20, 1), param('radius', 0, 50, 0)]
    },
    apply: gaussianBlurImpl
  },
  {
    descriptor: { id: 'sharpen', name: 'Sharpen', params: [param('amount', 0, 5, 1)] },
    apply: sharpenImpl
  },
  {
    descriptor: {
      id: 'noise',
      name: 'Noise',
      params: [param('amount', 0, 255, 25), param('seed', 0, 4294967295, 1)]
    },
    apply: noiseImpl
  },
  {
    descriptor: {
      id: 'edge-detect',
      name: 'Edge Detection',
      params: [param('strength', 0, 4, 1), param('threshold', 0, 255, 0)]
    },
    apply: edgeDetectImpl
  },
  {
    descriptor: {
      id: 'emboss',
      name: 'Emboss',
      params: [param('strength', 0, 4, 1), param('angle', 0, 360, 135)]
    },
    apply: embossImpl
  },
  {
    descriptor: {
      id: 'wave',
      name: 'Wave Distortion',
      params: [param('amplitude', 0, 100, 4), param('wavelength', 2, 1000, 32), param('phase', 0, 360, 0)]
    },
    apply: waveImpl
  },
  {
    descriptor: {
      id: 'swirl',
      name: 'Swirl Distortion',
      params: [param('angle', -720, 720, 90), param('radius', 0, 2000, 0)]
    },
    apply: swirlImpl
  },
  {
    descriptor: {
      id: 'brightness-contrast',
      name: 'Brightness / Contrast',
      params: [param('brightness', -255, 255, 0), param('contrast', -100, 100, 0)]
    },
    apply: (img, p) => viaProject(img, (project, layerId) => adjustBrightnessContrast(project, layerId, p.brightness, p.contrast))
  },
  {
    descriptor: { id: 'saturation', name: 'Saturation', params: [param('amount', -1, 1, 0)] },
    apply: (img, p) => viaProject(img, (project, layerId) => adjustSaturation(project, layerId, p.amount))
  },
  {
    descriptor: { id: 'hue-rotate', name: 'Hue Rotate', params: [param('degrees', -360, 360, 0)] },
    apply: hueRotateImpl
  },
  {
    descriptor: { id: 'invert', name: 'Invert', params: [] },
    apply: (img) => viaProject(img, (project, layerId) => invert(project, layerId))
  },
  {
    descriptor: { id: 'grayscale', name: 'Grayscale', params: [] },
    apply: (img) => viaProject(img, (project, layerId) => grayscale(project, layerId))
  },
  {
    descriptor: { id: 'sepia', name: 'Sepia', params: [param('amount', 0, 1, 1)] },
    apply: sepiaImpl
  },
  {
    descriptor: { id: 'posterize', name: 'Posterize', params: [param('levels', 2, 32, 4)] },
    apply: posterizeImpl
  },
  {
    descriptor: { id: 'threshold', name: 'Threshold', params: [param('level', 0, 255, 128)] },
    apply: thresholdImpl
  }
];

const FILTER_BY_ID = new Map<string, FilterEntry>(FILTER_ENTRIES.map((e) => [e.descriptor.id, e]));

function filterEntry(filterId: string): FilterEntry {
  const entry = FILTER_BY_ID.get(filterId);
  if (!entry) throw new Error(`Unknown filter: ${filterId}`);
  return entry;
}

function cloneDescriptor(d: FilterDescriptor): FilterDescriptor {
  return { id: d.id, name: d.name, params: d.params.map((p) => ({ ...p })) };
}

/** All registered filters, as defensive copies — a UI renders its controls from these. */
export function listFilters(): FilterDescriptor[] {
  return FILTER_ENTRIES.map((e) => cloneDescriptor(e.descriptor));
}

/** One filter's descriptor (a copy). Throws on an unknown id. */
export function getFilterDescriptor(filterId: string): FilterDescriptor {
  return cloneDescriptor(filterEntry(filterId).descriptor);
}

/**
 * Validate caller parameters against a filter's schema and fill in
 * defaults. Unknown ids, unknown parameter names, non-finite values
 * and out-of-range values all throw — nothing is silently clamped.
 */
export function resolveFilterParams(filterId: string, params?: Record<string, number>): Record<string, number> {
  const { descriptor } = filterEntry(filterId);
  const given = params ?? {};
  if (typeof given !== 'object' || Array.isArray(given)) {
    throw new Error(`Filter parameters for '${filterId}' must be an object of numbers`);
  }
  const known = new Set(descriptor.params.map((p) => p.name));
  for (const key of Object.keys(given)) {
    if (!known.has(key)) throw new Error(`Unknown parameter '${key}' for filter '${filterId}'`);
  }
  const resolved: Record<string, number> = {};
  for (const spec of descriptor.params) {
    const value = given[spec.name] ?? spec.defaultValue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Parameter '${spec.name}' for filter '${filterId}' must be a finite number`);
    }
    if (value < spec.min || value > spec.max) {
      throw new Error(`Parameter '${spec.name}' for filter '${filterId}' out of range ${spec.min}..${spec.max}: ${value}`);
    }
    resolved[spec.name] = value;
  }
  return resolved;
}

/** Apply a filter to a whole image. Pure: the input image is never mutated. */
export function applyFilterToImage(img: PixelImage, filterId: string, params?: Record<string, number>): PixelImage {
  const entry = filterEntry(filterId);
  return entry.apply(img, resolveFilterParams(filterId, params));
}

// --- Phase 51: banded filter execution (the parallel provider's seam) ---

/**
 * The filters whose math is a separable convolution and therefore
 * splits exactly along horizontal bands. Every other registered
 * filter either resamples across the whole image (wave, swirl),
 * reads a 3×3 neighborhood with cross-band dependencies this seam
 * does not model (sharpen, edge detection, emboss), or is per-pixel
 * and gains nothing from banding — those stay on the serial path,
 * and `applyFilterAsync` falls back for them by policy, never by
 * silently changing the math.
 */
const BANDED_FILTER_IDS: ReadonlySet<string> = new Set(['box-blur', 'gaussian-blur']);

/** Whether `applyFilterToImageRows` can compute this filter exactly on a horizontal band. */
export function isBandedFilter(filterId: string): boolean {
  return BANDED_FILTER_IDS.has(filterId);
}

/** Copy rows [y0, y1) of an image into a new band-sized image. */
function sliceImageRows(img: PixelImage, y0: number, y1: number): PixelImage {
  const out = createPixelImage(img.width, y1 - y0);
  out.data.set(img.data.subarray(y0 * img.width * 4, y1 * img.width * 4));
  return out;
}

/**
 * Phase 51: compute rows [y0, y1) of a banded filter's output,
 * byte-identical to the same rows of `applyFilterToImage`'s output
 * (the halo rows the convolution needs are read from the full input
 * image, which the caller supplies whole). Parameters are validated
 * exactly as in `applyFilterToImage`. A registered filter that is
 * not band-separable throws — it must run on the serial path.
 */
export function applyFilterToImageRows(
  img: PixelImage,
  filterId: string,
  params: Record<string, number> | undefined,
  y0: number,
  y1: number
): PixelImage {
  const resolved = resolveFilterParams(filterId, params);
  if (!Number.isInteger(y0) || !Number.isInteger(y1) || y0 < 0 || y1 > img.height || y0 >= y1) {
    throw new Error(`Invalid filter row band [${y0}, ${y1}) for image height ${img.height}`);
  }
  if (filterId === 'box-blur') {
    const radius = Math.round(resolved.radius);
    if (radius <= 0) return sliceImageRows(img, y0, y1);
    return separableConvolveRows(img, boxBlurKernel(radius), y0, y1);
  }
  if (filterId === 'gaussian-blur') {
    if (resolved.sigma <= 0) return sliceImageRows(img, y0, y1);
    return separableConvolveRows(img, gaussianKernel(resolved.sigma, resolved.radius), y0, y1);
  }
  throw new Error(
    `Filter '${filterId}' cannot be computed on a row band (only ${[...BANDED_FILTER_IDS].join(' and ')} are band-separable); run it with the serial provider`
  );
}

/**
 * Blend a fully-filtered layer image with the original by the scope
 * weight (rect in/out × raster-selection value/255). The filtered
 * image is always computed from the whole layer first, so
 * neighborhood filters behave correctly at scope boundaries and
 * feathered selection edges cross-fade instead of stepping.
 */
function scopedFilterResult(img: PixelImage, filtered: PixelImage, options?: FilterOptions): PixelImage {
  const selMask = options?.selectionMask ?? null;
  if (selMask && (selMask.width !== img.width || selMask.height !== img.height)) {
    throw new Error(`Selection size ${selMask.width}x${selMask.height} does not match layer size ${img.width}x${img.height}`);
  }
  const rect = options?.selection ?? null;
  if (!rect && !selMask) return filtered;
  const out = clonePixelImage(img);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      let w = 1;
      if (rect && !inSelection(x, y, rect)) w = 0;
      if (selMask) w *= selMask.data[y * img.width + x] / 255;
      if (w <= 0) continue;
      const i = (y * img.width + x) * 4;
      if (w >= 1) {
        out.data[i] = filtered.data[i];
        out.data[i + 1] = filtered.data[i + 1];
        out.data[i + 2] = filtered.data[i + 2];
        out.data[i + 3] = filtered.data[i + 3];
      } else {
        for (let c = 0; c < 4; c++) {
          out.data[i + c] = Math.round(img.data[i + c] * (1 - w) + filtered.data[i + c] * w);
        }
      }
    }
  }
  return out;
}

/**
 * Apply a filter to a layer, in place, honoring the optional rect /
 * raster-selection scope. The layer's Phase 44 mask (if any) is left
 * untouched — it keeps modulating compositing, it is not baked in.
 */
export function applyFilter(
  project: ImageProject,
  layerId: string,
  filterId: string,
  params?: Record<string, number>,
  options?: FilterOptions
): void {
  const layer = requirePaintableLayer(project, layerId);
  const filtered = applyFilterToImage(layer.image, filterId, params);
  layer.image = scopedFilterResult(layer.image, filtered, options);
}

/**
 * Preview a filter on a layer: returns the image the layer WOULD
 * have after applyFilter with the same arguments, as a new image.
 * The project is not modified in any way.
 */
export function previewFilter(
  project: ImageProject,
  layerId: string,
  filterId: string,
  params?: Record<string, number>,
  options?: FilterOptions
): PixelImage {
  const layer = getLayer(project, layerId);
  const filtered = applyFilterToImage(layer.image, filterId, params);
  return scopedFilterResult(layer.image, filtered, options);
}

/**
 * Preview a filter on one region of a layer: returns the filtered
 * crop of `region` (region-sized image), computed with the full
 * layer as context so neighborhood filters are correct at the
 * region's edges. The project is not modified.
 */
export function previewFilterRegion(
  project: ImageProject,
  layerId: string,
  region: Rect,
  filterId: string,
  params?: Record<string, number>,
  options?: FilterOptions
): PixelImage {
  const layer = getLayer(project, layerId);
  if (region.width <= 0 || region.height <= 0) throw new Error('Preview region must have positive size');
  if (region.x < 0 || region.y < 0 || region.x + region.width > layer.image.width || region.y + region.height > layer.image.height) {
    throw new Error('Preview region must lie inside the layer');
  }
  const full = previewFilter(project, layerId, filterId, params, options);
  const out = createPixelImage(region.width, region.height);
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) {
      setPixel(out, x, y, getPixel(full, region.x + x, region.y + y));
    }
  }
  return out;
}

// ---------------------------------------------------------------- non-destructive editing (Phase 52)

/**
 * Phase 52: non-destructive editing. Three mechanisms, all stored as
 * data on the existing Layer model and applied at render time (see
 * computeLayerView and applyAdjustmentLayerBand in the compositing
 * section):
 *
 * 1. Effect stacks (`Layer.effects`): an ordered list of Phase 47
 *    registry filters. Rendering applies the enabled effects, in
 *    stack order, to the layer's pristine pixels; the stored pixels
 *    are never modified by the stack. Parameters are validated by
 *    the Phase 47 registry when an effect is added or edited and
 *    when a project is loaded — unknown ids and out-of-range values
 *    are rejected, never silently stored.
 * 2. Adjustment layers (`kind: 'adjustment'`): layers with no pixels
 *    of their own whose stack filters the accumulated backdrop of
 *    their compositing level — the canvas at root level, the group's
 *    isolated buffer inside a group (Phase 44 groups always isolate
 *    in this engine, so the scoping follows the isolation). Layer
 *    opacity and a Phase 44 mask modulate the effect per pixel.
 *    Blend mode, clipping and the alpha lock have no meaning for an
 *    adjustment layer and are ignored at render.
 * 3. Raster placement (`Layer.placement`): a Phase 45 transform
 *    stored as a matrix on a raster layer. While set, the Phase 45
 *    transform family composes into it instead of baking pixels;
 *    clearing it restores the byte-exact original render.
 *
 * `bakeLayerEffects` is the explicit, destructive bridge: it writes
 * a raster layer's stacked result into its pixels and clears the
 * stack. Rendering is unchanged by baking.
 */

function cloneLayerEffect(e: LayerEffect): LayerEffect {
  return { filterId: e.filterId, params: { ...e.params }, enabled: e.enabled };
}

function effectAt(layer: Layer, index: number): LayerEffect {
  if (!Number.isInteger(index) || index < 0 || index >= layer.effects.length) {
    throw new Error(`Effect index out of range: ${index} (layer "${layer.name}" has ${layer.effects.length} effects)`);
  }
  return layer.effects[index];
}

/**
 * Apply a stack's enabled effects, in stack order, to an image.
 * Pure: the input is never mutated, and with no enabled effects the
 * input itself is returned. Every effect goes through the Phase 47
 * registry, so parameters are re-validated on every render.
 */
export function applyLayerEffectStack(img: PixelImage, effects: readonly LayerEffect[]): PixelImage {
  let out = img;
  for (const effect of effects) {
    if (!effect.enabled) continue;
    out = applyFilterToImage(out, effect.filterId, effect.params);
  }
  return out;
}

/**
 * Add an effect to a layer's stack (the end of the list applies
 * last). Parameters are resolved against the Phase 47 schema —
 * unknown filter ids, unknown parameter names and out-of-range
 * values throw, and nothing is stored.
 */
export function addLayerEffect(
  project: ImageProject,
  layerId: string,
  filterId: string,
  params?: Record<string, number>,
  enabled = true
): LayerEffect {
  const layer = getLayer(project, layerId);
  const resolved = resolveFilterParams(filterId, params);
  const effect: LayerEffect = { filterId, params: resolved, enabled };
  layer.effects.push(effect);
  return cloneLayerEffect(effect);
}

/** A layer's effect stack, as defensive copies. */
export function getLayerEffects(project: ImageProject, layerId: string): LayerEffect[] {
  return getLayer(project, layerId).effects.map(cloneLayerEffect);
}

/**
 * Replace an effect's parameters (validated against its filter's
 * schema; the stored form is the resolved parameter set). The new
 * parameters take effect on the next render — the layer's stored
 * pixels are not touched.
 */
export function setLayerEffectParams(
  project: ImageProject,
  layerId: string,
  index: number,
  params: Record<string, number>
): void {
  const effect = effectAt(getLayer(project, layerId), index);
  effect.params = resolveFilterParams(effect.filterId, params);
}

/** Enable or disable one effect in a layer's stack; disabled effects stay in the stack but are skipped at render. */
export function setLayerEffectEnabled(project: ImageProject, layerId: string, index: number, enabled: boolean): void {
  effectAt(getLayer(project, layerId), index).enabled = enabled;
}

/** Move an effect within its stack; render order follows stack order. */
export function moveLayerEffect(project: ImageProject, layerId: string, fromIndex: number, toIndex: number): void {
  const layer = getLayer(project, layerId);
  effectAt(layer, fromIndex);
  effectAt(layer, toIndex);
  const [effect] = layer.effects.splice(fromIndex, 1);
  layer.effects.splice(toIndex, 0, effect);
}

/** Remove one effect from a layer's stack. */
export function removeLayerEffect(project: ImageProject, layerId: string, index: number): void {
  const layer = getLayer(project, layerId);
  effectAt(layer, index);
  layer.effects.splice(index, 1);
}

/**
 * DESTRUCTIVE: bake a raster layer's effect stack into its pixels
 * and clear the stack. Afterwards the layer renders byte-identically
 * (its placement, if any, still applies on top of the baked pixels),
 * but the pristine pixels are gone — this is the explicit commit
 * path for consumers that need plain pixels, not a render shortcut.
 *
 * Only raster layers can bake: an adjustment layer has no pixels of
 * its own, and a content layer's pixels are a render cache of its
 * editable data (a bake would be silently overwritten by the next
 * re-render), so both throw.
 */
export function bakeLayerEffects(project: ImageProject, layerId: string): void {
  const layer = getLayer(project, layerId);
  if (layer.kind === 'adjustment') {
    throw new Error(`Layer "${layer.name}" is an adjustment layer; it has no pixels of its own to bake into`);
  }
  if (layer.kind !== 'raster') {
    throw new Error(
      `Layer "${layer.name}" is a ${layer.kind} layer; its pixels are a render cache of its editable data and cannot hold a bake`
    );
  }
  layer.image = applyLayerEffectStack(layer.image, layer.effects);
  layer.effects = [];
}

/**
 * Add an adjustment layer: no pixels of its own; its effect stack
 * (initially empty — populate it with addLayerEffect) filters the
 * backdrop below it at composite time. Like every layer it starts
 * visible, at full opacity, at the top of the stack, and becomes
 * the active layer.
 */
export function addAdjustmentLayer(project: ImageProject, name?: string): Layer {
  const layer: Layer = {
    id: crypto.randomUUID(),
    name: name || `Adjustment ${project.layers.length + 1}`,
    visible: true,
    opacity: 1,
    image: createPixelImage(project.width, project.height),
    ...layerDefaults(),
    kind: 'adjustment'
  };
  project.layers.push(layer);
  project.activeLayerId = layer.id;
  return layer;
}

/**
 * Set a raster layer's non-destructive placement from a Phase 45
 * Transform2D (null clears it, restoring the byte-exact original
 * render). The placement is stored as a 3x3 matrix — the same form
 * as a content layer's contentTransform — so the transform family
 * can compose into it. Content layers place via setContentTransform;
 * adjustment layers have no pixels to place.
 */
export function setLayerPlacement(project: ImageProject, layerId: string, placement: Transform2D | null): void {
  const layer = getLayer(project, layerId);
  if (layer.kind !== 'raster') {
    throw new Error(
      `Placement applies to raster layers; layer "${layer.name}" is a ${layer.kind} layer` +
        (layer.kind === 'adjustment' ? ' (it has no pixels)' : ' (use setContentTransform)')
    );
  }
  layer.placement = placement ? [...transformMatrix(placement)] : null;
}

/** A raster layer's placement matrix (a copy), or null when the layer renders unplaced. */
export function getLayerPlacement(project: ImageProject, layerId: string): number[] | null {
  const layer = getLayer(project, layerId);
  return layer.placement ? [...layer.placement] : null;
}

// ---------------------------------------------------------------- typography & vector tools (Phase 48)

/**
 * Phase 48: editable text layers and vector shape layers.
 *
 * A content layer (kind 'text' or 'shape') carries its content as
 * editable data on the layer; its `image` is a render cache produced
 * by the deterministic renderers in this section. Every mutator
 * (add / update / transform / deserialize) re-renders the cache from
 * the data, so the composite, the undo history and the serialized
 * project all see the same pixels, and editing the data after any
 * transform still renders correctly — transforms of content layers
 * compose into the layer's `contentTransform` placement matrix
 * (Phase 45 machinery) instead of baking into pixels.
 *
 * Text is set in the built-in bitmap fonts of bitmapFont.ts — the
 * only fonts this engine has. The glyph grid is 5x7; a text layer's
 * fontSize snaps to an integer scale of that grid. Layout: lines
 * split on '\n', glyph origins advance by 6*scale + letterSpacing,
 * lines by 7*scale + lineSpacing, each line aligned within the
 * block width from the (whole-pixel-rounded) origin. Shadow is the
 * glyph coverage translated and box-blurred; outline is the glyph
 * coverage dilated by the outline width (the Phase 45 morphology)
 * minus the coverage itself; fill is the coverage. All three paint
 * with source-over in that order.
 *
 * Shapes fill through the Phase 45 selection rasterizers (rect /
 * ellipse / polygon rules, paths flattened from their Bézier
 * segments) and stroke through the Phase 19 paint-stroke dot path
 * along the shape's outline. Bézier evaluation is the real cubic
 * formula; flattening samples it at a fixed step count.
 */

function assertRgbaColor(c: RgbaColor, what: string): void {
  if (!c || ![c.r, c.g, c.b, c.a].every((v) => Number.isFinite(v) && v >= 0 && v <= 255)) {
    throw new Error(`${what} out of range`);
  }
}

function assertPointValue(p: Point, what: string): void {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    throw new Error(`${what} out of range`);
  }
}

function cloneRgba(c: RgbaColor): RgbaColor {
  return { r: c.r, g: c.g, b: c.b, a: c.a };
}

function clonePoint(p: Point): Point {
  return { x: p.x, y: p.y };
}

// ---------------------------------------------------------- text data

export function assertTextLayerData(d: TextLayerData): void {
  if (!d || typeof d !== 'object') throw new Error('Text layer data is missing');
  if (typeof d.text !== 'string') throw new Error('Text content must be a string');
  if (!BUILT_IN_FONT_IDS.includes(d.font)) {
    throw new Error(`Unknown built-in font: ${d.font} (expected one of ${BUILT_IN_FONT_IDS.join(', ')})`);
  }
  if (!Number.isFinite(d.fontSize) || d.fontSize <= 0 || d.fontSize > 1024) {
    throw new Error(`Text fontSize out of range: ${d.fontSize}`);
  }
  if (!TEXT_ALIGNS.includes(d.align)) throw new Error(`Text align out of range: ${d.align}`);
  if (!Number.isFinite(d.letterSpacing) || d.letterSpacing < 0) {
    throw new Error(`Text letterSpacing out of range: ${d.letterSpacing}`);
  }
  if (!Number.isFinite(d.lineSpacing) || d.lineSpacing < 0) {
    throw new Error(`Text lineSpacing out of range: ${d.lineSpacing}`);
  }
  assertRgbaColor(d.color, 'Text color');
  if (d.outline !== null) {
    if (!d.outline || !Number.isInteger(d.outline.width) || d.outline.width < 0 || d.outline.width > 64) {
      throw new Error(`Text outline width out of range: ${d.outline?.width}`);
    }
    assertRgbaColor(d.outline.color, 'Text outline color');
  }
  if (d.shadow !== null) {
    if (!d.shadow || !Number.isFinite(d.shadow.offsetX) || !Number.isFinite(d.shadow.offsetY)) {
      throw new Error('Text shadow offset out of range');
    }
    if (!Number.isFinite(d.shadow.blur) || d.shadow.blur < 0 || d.shadow.blur > 64) {
      throw new Error(`Text shadow blur out of range: ${d.shadow.blur}`);
    }
    assertRgbaColor(d.shadow.color, 'Text shadow color');
  }
  assertPointValue(d.origin, 'Text origin');
  if (!Number.isFinite(d.blockWidth) || d.blockWidth < 0) {
    throw new Error(`Text blockWidth out of range: ${d.blockWidth}`);
  }
}

/** Deep copy of text layer data (the serialized form is this same shape). */
export function cloneTextLayerData(d: TextLayerData): TextLayerData {
  return {
    text: d.text,
    font: d.font,
    fontSize: d.fontSize,
    align: d.align,
    letterSpacing: d.letterSpacing,
    lineSpacing: d.lineSpacing,
    color: cloneRgba(d.color),
    outline: d.outline ? { width: d.outline.width, color: cloneRgba(d.outline.color) } : null,
    shadow: d.shadow
      ? { offsetX: d.shadow.offsetX, offsetY: d.shadow.offsetY, blur: d.shadow.blur, color: cloneRgba(d.shadow.color) }
      : null,
    origin: clonePoint(d.origin),
    blockWidth: d.blockWidth
  };
}

/**
 * Build validated text layer data from a partial: every field but
 * `text` has a default (built-in 'pixel' font, nominal size 14,
 * left-aligned, black, no outline/shadow, origin (0, 0), auto block
 * width). The result is a deep copy — later mutation of the caller's
 * objects does not alias into the layer.
 */
export function createTextLayerData(partial: Partial<TextLayerData> & Pick<TextLayerData, 'text'>): TextLayerData {
  const d: TextLayerData = {
    text: partial.text,
    font: partial.font ?? 'pixel',
    fontSize: partial.fontSize ?? 14,
    align: partial.align ?? 'left',
    letterSpacing: partial.letterSpacing ?? 0,
    lineSpacing: partial.lineSpacing ?? 0,
    color: partial.color ?? { r: 0, g: 0, b: 0, a: 255 },
    outline: partial.outline ?? null,
    shadow: partial.shadow ?? null,
    origin: partial.origin ?? { x: 0, y: 0 },
    blockWidth: partial.blockWidth ?? 0
  };
  assertTextLayerData(d);
  return cloneTextLayerData(d);
}

/** The integer bitmap scale a nominal fontSize renders at: glyph height = 7 * scale. */
export function textScaleFor(fontSize: number): number {
  if (!Number.isFinite(fontSize) || fontSize <= 0) throw new Error(`Text fontSize out of range: ${fontSize}`);
  return Math.max(1, Math.round(fontSize / GLYPH_HEIGHT));
}

function textLineWidth(line: string, scale: number, letterSpacing: number): number {
  const n = [...line].length;
  return n === 0 ? 0 : n * GLYPH_ADVANCE * scale - scale + (n - 1) * letterSpacing;
}

function textBlockWidth(data: TextLayerData, scale: number, lines: string[]): number {
  if (data.blockWidth > 0) return data.blockWidth;
  let max = 0;
  for (const line of lines) max = Math.max(max, textLineWidth(line, scale, data.letterSpacing));
  return max;
}

/** Measured layout of a text block: effective block width/height, bitmap scale and line count. */
export function measureTextBlock(data: TextLayerData): { width: number; height: number; scale: number; lineCount: number } {
  assertTextLayerData(data);
  const scale = textScaleFor(data.fontSize);
  const lines = data.text.split('\n');
  return {
    width: textBlockWidth(data, scale, lines),
    height: lines.length * GLYPH_HEIGHT * scale + (lines.length - 1) * data.lineSpacing,
    scale,
    lineCount: lines.length
  };
}

/** Separable box blur of a float channel, edge-replicating (the Phase 47 blur convention). */
function boxBlurFloatChannel(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  let cur = new Float32Array(src);
  const size = 2 * radius + 1;
  for (const horizontal of [true, false]) {
    const next = new Float32Array(cur.length);
    const lines = horizontal ? height : width;
    const len = horizontal ? width : height;
    for (let line = 0; line < lines; line++) {
      for (let pos = 0; pos < len; pos++) {
        let sum = 0;
        for (let d = -radius; d <= radius; d++) {
          const q = Math.min(len - 1, Math.max(0, pos + d));
          sum += horizontal ? cur[line * width + q] : cur[q * width + line];
        }
        const v = sum / size;
        if (horizontal) next[line * width + pos] = v;
        else next[pos * width + line] = v;
      }
    }
    cur = next;
  }
  return cur;
}

/** Source-over a color through a 0..1 coverage map. */
function paintCoverage(img: PixelImage, cov: Float32Array, color: RgbaColor): void {
  const a0 = color.a / 255;
  if (a0 <= 0) return;
  for (let px = 0, p = 0; px < cov.length; px++, p += 4) {
    const a = cov[px] * a0;
    if (a > 0) blendOver(img.data, p, color.r, color.g, color.b, a);
  }
}

/** Rasterize text layer data into a fresh transparent image (shadow, then outline, then fill). */
function renderTextInto(img: PixelImage, data: TextLayerData): void {
  const w = img.width;
  const h = img.height;
  const scale = textScaleFor(data.fontSize);
  const lines = data.text.split('\n');
  const blockW = textBlockWidth(data, scale, lines);
  const cov = new Float32Array(w * h);
  const originX = Math.round(data.origin.x);
  const originY = Math.round(data.origin.y);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const lw = textLineWidth(line, scale, data.letterSpacing);
    const xOff = data.align === 'center' ? Math.round((blockW - lw) / 2) : data.align === 'right' ? blockW - lw : 0;
    let cursorX = originX + xOff;
    const lineY = originY + li * (GLYPH_HEIGHT * scale + data.lineSpacing);
    for (const ch of line) {
      const rows = glyphRowsFor(data.font, ch);
      for (let row = 0; row < GLYPH_HEIGHT; row++) {
        const bits = rows[row];
        for (let col = 0; col < GLYPH_WIDTH; col++) {
          if (!(bits & (0x10 >> col))) continue;
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const x = cursorX + col * scale + dx;
              const y = lineY + row * scale + dy;
              if (x >= 0 && y >= 0 && x < w && y < h) cov[y * w + x] = 1;
            }
          }
        }
      }
      cursorX += GLYPH_ADVANCE * scale + data.letterSpacing;
    }
  }
  if (data.shadow) {
    let scov: Float32Array = new Float32Array(cov.length);
    const ox = Math.round(data.shadow.offsetX);
    const oy = Math.round(data.shadow.offsetY);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = cov[y * w + x];
        if (v <= 0) continue;
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (v > scov[ny * w + nx]) scov[ny * w + nx] = v;
      }
    }
    const blurRadius = Math.round(data.shadow.blur);
    if (blurRadius > 0) scov = boxBlurFloatChannel(scov, w, h, blurRadius);
    paintCoverage(img, scov, data.shadow.color);
  }
  if (data.outline && data.outline.width > 0) {
    const sel = createSelection(w, h);
    for (let px = 0; px < cov.length; px++) sel.data[px] = cov[px] > 0 ? 255 : 0;
    const expanded = expandSelection(sel, data.outline.width);
    const ocov = new Float32Array(cov.length);
    for (let px = 0; px < cov.length; px++) ocov[px] = Math.max(0, (expanded.data[px] - sel.data[px]) / 255);
    paintCoverage(img, ocov, data.outline.color);
  }
  paintCoverage(img, cov, data.color);
}

// ---------------------------------------------------------- Bézier paths

function assertBezierSegment(seg: BezierSegment, index = 0): void {
  if (!seg) throw new Error(`Bézier segment ${index} is missing`);
  assertPointValue(seg.p0, `Bézier segment ${index} p0`);
  assertPointValue(seg.c1, `Bézier segment ${index} c1`);
  assertPointValue(seg.c2, `Bézier segment ${index} c2`);
  assertPointValue(seg.p1, `Bézier segment ${index} p1`);
}

function cloneBezierSegment(seg: BezierSegment): BezierSegment {
  return { p0: clonePoint(seg.p0), c1: clonePoint(seg.c1), c2: clonePoint(seg.c2), p1: clonePoint(seg.p1) };
}

/**
 * Evaluate a cubic Bézier segment at t in [0, 1] with the real cubic
 * formula B(t) = (1-t)^3 p0 + 3(1-t)^2 t c1 + 3(1-t) t^2 c2 + t^3 p1.
 */
export function cubicBezierPoint(seg: BezierSegment, t: number): Point {
  assertBezierSegment(seg);
  if (!Number.isFinite(t) || t < 0 || t > 1) throw new Error(`Bézier parameter t out of range: ${t}`);
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * seg.p0.x + w1 * seg.c1.x + w2 * seg.c2.x + w3 * seg.p1.x,
    y: w0 * seg.p0.y + w1 * seg.c1.y + w2 * seg.c2.y + w3 * seg.p1.y
  };
}

/** Flatten one Bézier segment to a polyline of `steps + 1` points (endpoints included). */
export function flattenBezierSegment(seg: BezierSegment, steps = 16): Point[] {
  if (!Number.isInteger(steps) || steps < 1 || steps > 4096) {
    throw new Error(`Bézier flatten steps out of range: ${steps}`);
  }
  const pts: Point[] = [];
  for (let k = 0; k <= steps; k++) pts.push(cubicBezierPoint(seg, k / steps));
  return pts;
}

/** Flatten a whole path (joint points between consecutive segments appear once). */
export function flattenPath(segments: BezierSegment[], stepsPerSegment = 16): Point[] {
  if (!Array.isArray(segments) || segments.length < 1) throw new Error('Path needs at least 1 Bézier segment');
  const pts: Point[] = [];
  segments.forEach((seg, i) => {
    const flat = flattenBezierSegment(seg, stepsPerSegment);
    pts.push(...(i === 0 ? flat : flat.slice(1)));
  });
  return pts;
}

// ---------------------------------------------------------- shape data

export function assertVectorShapeData(s: VectorShapeData): void {
  if (!s || typeof s !== 'object') throw new Error('Vector shape data is missing');
  if (!VECTOR_SHAPE_KINDS.includes(s.kind)) {
    throw new Error(`Unknown vector shape kind: ${s.kind} (expected one of ${VECTOR_SHAPE_KINDS.join(', ')})`);
  }
  if (!Number.isFinite(s.strokeWidth) || s.strokeWidth < 0) {
    throw new Error(`Shape strokeWidth out of range: ${s.strokeWidth}`);
  }
  if (s.fill !== null) assertRgbaColor(s.fill, 'Shape fill color');
  if (s.stroke !== null) assertRgbaColor(s.stroke, 'Shape stroke color');
  switch (s.kind) {
    case 'rectangle':
    case 'ellipse':
      if (!s.rect) throw new Error(`Shape kind ${s.kind} requires a rect`);
      if (![s.rect.x, s.rect.y, s.rect.width, s.rect.height].every((v) => Number.isFinite(v))) {
        throw new Error('Shape rect out of range');
      }
      if (s.rect.width <= 0 || s.rect.height <= 0) throw new Error('Shape rect must have positive width and height');
      break;
    case 'line':
      if (!s.from || !s.to) throw new Error('Shape kind line requires from and to points');
      assertPointValue(s.from, 'Shape line start');
      assertPointValue(s.to, 'Shape line end');
      break;
    case 'polygon':
      if (!s.points || s.points.length < 3) {
        throw new Error(`Polygon shape needs at least 3 points, got ${s.points?.length ?? 0}`);
      }
      s.points.forEach((p, i) => assertPointValue(p, `Polygon point ${i}`));
      break;
    case 'path':
      if (!s.segments || s.segments.length < 1) throw new Error('Path shape needs at least 1 Bézier segment');
      s.segments.forEach((seg, i) => assertBezierSegment(seg, i));
      break;
  }
}

/** Deep copy of vector shape data (the serialized form is this same shape). */
export function cloneVectorShapeData(s: VectorShapeData): VectorShapeData {
  return {
    kind: s.kind,
    rect: s.rect ? { ...s.rect } : null,
    from: s.from ? clonePoint(s.from) : null,
    to: s.to ? clonePoint(s.to) : null,
    points: s.points ? s.points.map(clonePoint) : null,
    segments: s.segments ? s.segments.map(cloneBezierSegment) : null,
    closed: s.closed,
    fill: s.fill ? cloneRgba(s.fill) : null,
    stroke: s.stroke ? cloneRgba(s.stroke) : null,
    strokeWidth: s.strokeWidth
  };
}

function shapeDataBase(): Omit<VectorShapeData, 'kind'> {
  return { rect: null, from: null, to: null, points: null, segments: null, closed: false, fill: null, stroke: null, strokeWidth: 1 };
}

/** A rectangle shape: filled region is the rect; its stroke follows the filled region's edge pixels. */
export function rectangleShape(rect: Rect, fill: RgbaColor | null, stroke: RgbaColor | null = null, strokeWidth = 1): VectorShapeData {
  const s: VectorShapeData = { ...shapeDataBase(), kind: 'rectangle', rect: { ...rect }, closed: true, fill, stroke, strokeWidth };
  assertVectorShapeData(s);
  return cloneVectorShapeData(s);
}

/** An ellipse shape inscribed in the rect (the Phase 45 ellipse rule). */
export function ellipseShape(rect: Rect, fill: RgbaColor | null, stroke: RgbaColor | null = null, strokeWidth = 1): VectorShapeData {
  const s: VectorShapeData = { ...shapeDataBase(), kind: 'ellipse', rect: { ...rect }, closed: true, fill, stroke, strokeWidth };
  assertVectorShapeData(s);
  return cloneVectorShapeData(s);
}

/** A straight line shape (stroke only; lines have no fill). */
export function lineShape(from: Point, to: Point, stroke: RgbaColor, strokeWidth = 1): VectorShapeData {
  const s: VectorShapeData = { ...shapeDataBase(), kind: 'line', from: { ...from }, to: { ...to }, stroke, strokeWidth };
  assertVectorShapeData(s);
  return cloneVectorShapeData(s);
}

/** A closed polygon shape from its vertices. */
export function polygonShape(points: Point[], fill: RgbaColor | null, stroke: RgbaColor | null = null, strokeWidth = 1): VectorShapeData {
  const s: VectorShapeData = {
    ...shapeDataBase(),
    kind: 'polygon',
    points: points.map((p) => ({ ...p })),
    closed: true,
    fill,
    stroke,
    strokeWidth
  };
  assertVectorShapeData(s);
  return cloneVectorShapeData(s);
}

/** A Bézier path shape; `closed` paths fill and gain a straight closing stroke segment. */
export function pathShape(
  segments: BezierSegment[],
  options?: { closed?: boolean; fill?: RgbaColor | null; stroke?: RgbaColor | null; strokeWidth?: number }
): VectorShapeData {
  const s: VectorShapeData = {
    ...shapeDataBase(),
    kind: 'path',
    segments: segments.map(cloneBezierSegment),
    closed: options?.closed ?? false,
    fill: options?.fill ?? null,
    stroke: options?.stroke ?? null,
    strokeWidth: options?.strokeWidth ?? 1
  };
  assertVectorShapeData(s);
  return cloneVectorShapeData(s);
}

/** Rasterize vector shape data into a fresh transparent image (fill first, then stroke). */
function renderShapeInto(img: PixelImage, shape: VectorShapeData): void {
  const w = img.width;
  const h = img.height;
  let fillMask: SelectionMask | null = null;
  switch (shape.kind) {
    case 'rectangle':
      fillMask = rectSelection(w, h, shape.rect!);
      break;
    case 'ellipse':
      fillMask = ellipseSelection(w, h, shape.rect!);
      break;
    case 'polygon':
      fillMask = polygonSelection(w, h, shape.points!);
      break;
    case 'path':
      if (shape.closed) fillMask = polygonSelection(w, h, flattenPath(shape.segments!));
      break;
    case 'line':
      break;
  }
  if (shape.fill && fillMask) {
    const a = shape.fill.a / 255;
    if (a > 0) {
      for (let px = 0, p = 0; px < fillMask.data.length; px++, p += 4) {
        if (fillMask.data[px] > 0) blendOver(img.data, p, shape.fill.r, shape.fill.g, shape.fill.b, a);
      }
    }
  }
  if (shape.stroke && shape.strokeWidth > 0) {
    const polylines: Point[][] = [];
    switch (shape.kind) {
      case 'rectangle': {
        const r = shape.rect!;
        polylines.push([
          { x: r.x, y: r.y },
          { x: r.x + r.width - 1, y: r.y },
          { x: r.x + r.width - 1, y: r.y + r.height - 1 },
          { x: r.x, y: r.y + r.height - 1 },
          { x: r.x, y: r.y }
        ]);
        break;
      }
      case 'ellipse': {
        const r = shape.rect!;
        const cx = r.x + r.width / 2 - 0.5;
        const cy = r.y + r.height / 2 - 0.5;
        const steps = Math.max(24, Math.ceil(Math.PI * Math.max(r.width, r.height)));
        const pts: Point[] = [];
        for (let k = 0; k <= steps; k++) {
          const th = (2 * Math.PI * k) / steps;
          pts.push({ x: cx + (r.width / 2) * Math.cos(th), y: cy + (r.height / 2) * Math.sin(th) });
        }
        polylines.push(pts);
        break;
      }
      case 'line':
        polylines.push([shape.from!, shape.to!]);
        break;
      case 'polygon': {
        const pts = shape.points!;
        polylines.push([...pts, pts[0]]);
        break;
      }
      case 'path': {
        const segs = shape.segments!;
        for (const seg of segs) polylines.push(flattenBezierSegment(seg));
        if (shape.closed && segs.length > 0) polylines.push([segs[segs.length - 1].p1, segs[0].p0]);
        break;
      }
    }
    for (const pts of polylines) {
      if (pts.length >= 2) paintStroke(img, pts, shape.strokeWidth / 2, shape.stroke, false, undefined, false);
    }
  }
}

// ---------------------------------------------------------- content layers

/** Re-render a content layer's image cache from its data and placement. Raster and adjustment layers are untouched. */
function renderContentLayerInternal(project: ImageProject, layer: Layer): void {
  if (layer.kind !== 'text' && layer.kind !== 'shape') return;
  const raw = createPixelImage(project.width, project.height);
  if (layer.kind === 'text' && layer.text) renderTextInto(raw, layer.text);
  else if (layer.kind === 'shape' && layer.shape) renderShapeInto(raw, layer.shape);
  layer.image = layer.contentTransform ? warpImage(raw, layer.contentTransform as Mat3) : raw;
}

/** Re-render a layer's content from its editable data (no-op for raster layers). */
export function renderContentLayer(project: ImageProject, layerId: string): void {
  renderContentLayerInternal(project, getLayer(project, layerId));
}

/**
 * Phase 48: compose a warp into a content layer's placement matrix
 * and re-render — the content-layer half of the Phase 45 layer
 * transforms (they call this instead of warping the render cache).
 */
function composeContentPlacement(project: ImageProject, layer: Layer, m: Mat3): void {
  const current = (layer.contentTransform as Mat3 | null) ?? ([1, 0, 0, 0, 1, 0, 0, 0, 1] as Mat3);
  layer.contentTransform = [...mat3Multiply(m, current)];
  renderContentLayerInternal(project, layer);
}

function requireTextLayer(project: ImageProject, layerId: string): Layer {
  const layer = getLayer(project, layerId);
  if (layer.kind !== 'text' || !layer.text) throw new Error(`Layer is not a text layer: ${layerId}`);
  return layer;
}

function requireShapeLayer(project: ImageProject, layerId: string): Layer {
  const layer = getLayer(project, layerId);
  if (layer.kind !== 'shape' || !layer.shape) throw new Error(`Layer is not a shape layer: ${layerId}`);
  return layer;
}

/** Add an editable text layer (rendered immediately) and make it active. */
export function addTextLayer(
  project: ImageProject,
  data: Partial<TextLayerData> & Pick<TextLayerData, 'text'>,
  name?: string
): Layer {
  const layer: Layer = {
    id: crypto.randomUUID(),
    name: name || `Layer ${project.layers.length + 1}`,
    visible: true,
    opacity: 1,
    image: createPixelImage(project.width, project.height),
    ...layerDefaults(),
    kind: 'text',
    text: createTextLayerData(data)
  };
  project.layers.push(layer);
  project.activeLayerId = layer.id;
  renderContentLayerInternal(project, layer);
  return layer;
}

/** Add an editable vector shape layer (rendered immediately) and make it active. */
export function addShapeLayer(project: ImageProject, shape: VectorShapeData, name?: string): Layer {
  assertVectorShapeData(shape);
  const layer: Layer = {
    id: crypto.randomUUID(),
    name: name || `Layer ${project.layers.length + 1}`,
    visible: true,
    opacity: 1,
    image: createPixelImage(project.width, project.height),
    ...layerDefaults(),
    kind: 'shape',
    shape: cloneVectorShapeData(shape)
  };
  project.layers.push(layer);
  project.activeLayerId = layer.id;
  renderContentLayerInternal(project, layer);
  return layer;
}

/** The live editable text data of a text layer (mutate via updateTextLayer to re-render). */
export function getTextData(project: ImageProject, layerId: string): TextLayerData {
  return requireTextLayer(project, layerId).text!;
}

/** The live editable shape data of a shape layer (mutate via updateShapeLayer to re-render). */
export function getShapeData(project: ImageProject, layerId: string): VectorShapeData {
  return requireShapeLayer(project, layerId).shape!;
}

/** Patch a text layer's data (nested outline/shadow/color objects replace wholesale) and re-render. */
export function updateTextLayer(project: ImageProject, layerId: string, patch: Partial<TextLayerData>): void {
  const layer = requireTextLayer(project, layerId);
  const merged: TextLayerData = { ...layer.text!, ...patch };
  assertTextLayerData(merged);
  layer.text = cloneTextLayerData(merged);
  renderContentLayerInternal(project, layer);
}

/** Patch a shape layer's data (geometry fields replace wholesale) and re-render. */
export function updateShapeLayer(project: ImageProject, layerId: string, patch: Partial<VectorShapeData>): void {
  const layer = requireShapeLayer(project, layerId);
  const merged: VectorShapeData = { ...layer.shape!, ...patch };
  assertVectorShapeData(merged);
  layer.shape = cloneVectorShapeData(merged);
  renderContentLayerInternal(project, layer);
}

/** Set a content layer's placement from a Phase 45 Transform2D (null = identity) and re-render. */
export function setContentTransform(project: ImageProject, layerId: string, t: Transform2D | null): void {
  const layer = getLayer(project, layerId);
  if (layer.kind !== 'text' && layer.kind !== 'shape') throw new Error(`Layer is not a content layer: ${layerId}`);
  layer.contentTransform = t ? [...transformMatrix(t)] : null;
  renderContentLayerInternal(project, layer);
}

/** Compose a Phase 45 Transform2D into a content layer's placement and re-render. */
export function transformContentLayer(project: ImageProject, layerId: string, t: Transform2D): void {
  const layer = getLayer(project, layerId);
  if (layer.kind !== 'text' && layer.kind !== 'shape') throw new Error(`Layer is not a content layer: ${layerId}`);
  composeContentPlacement(project, layer, transformMatrix(t) as Mat3);
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
  target.groups = source.groups;
  target.activeLayerId = source.activeLayerId;
  target.guides = source.guides;
  target.grid = source.grid;
}

// ---------------------------------------------------------------- persistence

export function serializeProject(project: ImageProject): SerializedProject {
  return {
    format: 'squadforge-image-project',
    version: 2,
    width: project.width,
    height: project.height,
    activeLayerId: project.activeLayerId,
    guides: project.guides.map((g) => ({ orientation: g.orientation, position: g.position })),
    grid: { ...project.grid },
    groups: project.groups.map((g) => ({
      id: g.id,
      name: g.name,
      parentId: g.parentId,
      visible: g.visible,
      opacity: g.opacity,
      blendMode: g.blendMode
    })),
    layers: project.layers.map((l) => ({
      id: l.id,
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      pixelsBase64: Buffer.from(l.image.data).toString('base64'),
      blendMode: l.blendMode,
      alphaLock: l.alphaLock,
      clipped: l.clipped,
      groupId: l.groupId,
      maskBase64: l.mask ? Buffer.from(l.mask.data).toString('base64') : null,
      kind: l.kind,
      text: l.text ? cloneTextLayerData(l.text) : null,
      shape: l.shape ? cloneVectorShapeData(l.shape) : null,
      contentTransform: l.contentTransform ? [...l.contentTransform] : null,
      effects: l.effects.map(cloneLayerEffect),
      placement: l.placement ? [...l.placement] : null
    }))
  };
}

export function deserializeProject(data: SerializedProject): ImageProject {
  if (!data || data.format !== 'squadforge-image-project' || (data.version !== 1 && data.version !== 2)) {
    throw new Error('Not a SquadForge image project (bad format/version)');
  }
  if (!Array.isArray(data.layers) || data.layers.length === 0) {
    throw new Error('Project has no layers');
  }
  // Phase 44 groups: validate ids, parent references and acyclicity up
  // front — corrupt hierarchy data is rejected, never silently loaded.
  const groups: LayerGroup[] = (data.groups ?? []).map((g) => {
    assertBlendMode(g.blendMode ?? 'normal');
    if (typeof g.opacity !== 'number' || g.opacity < 0 || g.opacity > 1) {
      throw new Error(`Group "${g.name}" opacity out of range: ${g.opacity}`);
    }
    return {
      id: g.id,
      name: g.name,
      parentId: g.parentId ?? null,
      visible: g.visible !== false,
      opacity: g.opacity,
      blendMode: g.blendMode ?? 'normal'
    };
  });
  const groupIds = new Set<string>();
  for (const g of groups) {
    if (groupIds.has(g.id)) throw new Error(`Duplicate group id: ${g.id}`);
    groupIds.add(g.id);
  }
  for (const g of groups) {
    if (g.parentId !== null && !groupIds.has(g.parentId)) {
      throw new Error(`Group "${g.name}" references missing parent group ${g.parentId}`);
    }
    const seen = new Set<string>();
    let cur: string | null = g.id;
    while (cur !== null) {
      if (seen.has(cur)) throw new Error(`Layer group cycle detected at group ${cur}`);
      seen.add(cur);
      cur = groups.find((x) => x.id === cur)?.parentId ?? null;
    }
  }
  const expected = data.width * data.height * 4;
  const layers: Layer[] = data.layers.map((l) => {
    const buf = Buffer.from(l.pixelsBase64, 'base64');
    if (buf.length !== expected) {
      throw new Error(`Layer "${l.name}" pixel data size mismatch: ${buf.length} != ${expected}`);
    }
    assertBlendMode(l.blendMode ?? 'normal');
    const groupId = l.groupId ?? null;
    if (groupId !== null && !groupIds.has(groupId)) {
      throw new Error(`Layer "${l.name}" references missing group ${groupId}`);
    }
    let mask: LayerMask | null = null;
    if (l.maskBase64 != null) {
      const mbuf = Buffer.from(l.maskBase64, 'base64');
      if (mbuf.length !== data.width * data.height) {
        throw new Error(`Layer "${l.name}" mask data size mismatch: ${mbuf.length} != ${data.width * data.height}`);
      }
      mask = { width: data.width, height: data.height, data: new Uint8ClampedArray(mbuf) };
    }
    // Phase 48: content-layer data. Absent kind = a pre-Phase-48 file,
    // where the layer is a raster layer and its pixels are the content.
    // Present data is validated like any other corrupt input: rejected,
    // never silently loaded.
    const kind = (l.kind ?? 'raster') as LayerKind;
    if (!LAYER_KINDS.includes(kind)) {
      throw new Error(`Layer "${l.name}" has unknown kind: ${l.kind}`);
    }
    let text: TextLayerData | null = null;
    let shape: VectorShapeData | null = null;
    if (kind === 'text') {
      if (!l.text) throw new Error(`Text layer "${l.name}" is missing its text data`);
      assertTextLayerData(l.text);
      text = cloneTextLayerData(l.text);
    }
    if (kind === 'shape') {
      if (!l.shape) throw new Error(`Shape layer "${l.name}" is missing its shape data`);
      assertVectorShapeData(l.shape);
      shape = cloneVectorShapeData(l.shape);
    }
    let contentTransform: number[] | null = null;
    if (l.contentTransform != null) {
      if (
        !Array.isArray(l.contentTransform) ||
        l.contentTransform.length !== 9 ||
        !l.contentTransform.every((v) => Number.isFinite(v))
      ) {
        throw new Error(`Layer "${l.name}" content transform must be 9 finite numbers`);
      }
      contentTransform = [...l.contentTransform];
    }
    // Phase 52: an adjustment layer carries no content of its own —
    // text/shape data or a content transform on one is corrupt.
    if (kind === 'adjustment') {
      if (l.text != null || l.shape != null) {
        throw new Error(`Adjustment layer "${l.name}" must not carry text or shape data`);
      }
      if (contentTransform !== null) {
        throw new Error(`Adjustment layer "${l.name}" must not carry a content transform`);
      }
    }
    // Phase 52: the effect stack. Absent = a pre-Phase-52 file (empty
    // stack). Present entries are validated against the Phase 47
    // registry exactly as at add time: unknown filter ids, unknown
    // parameter names and out-of-range values are rejected, never
    // silently loaded; the stored params are the resolved set.
    const effects: LayerEffect[] = [];
    if (l.effects != null) {
      if (!Array.isArray(l.effects)) {
        throw new Error(`Layer "${l.name}" effects must be an array`);
      }
      for (const e of l.effects) {
        if (!e || typeof e.filterId !== 'string') {
          throw new Error(`Layer "${l.name}" has an effect with a missing or invalid filter id`);
        }
        if (e.enabled != null && typeof e.enabled !== 'boolean') {
          throw new Error(`Layer "${l.name}" effect '${e.filterId}' has a non-boolean enabled flag`);
        }
        effects.push({
          filterId: e.filterId,
          params: resolveFilterParams(e.filterId, e.params ?? {}),
          enabled: e.enabled ?? true
        });
      }
    }
    // Phase 52: the raster placement matrix, validated like the
    // content transform (9 finite numbers; raster layers only).
    let placement: number[] | null = null;
    if (l.placement != null) {
      if (kind !== 'raster') {
        throw new Error(`Layer "${l.name}" is a ${kind} layer; placement applies to raster layers only`);
      }
      if (!Array.isArray(l.placement) || l.placement.length !== 9 || !l.placement.every((v) => Number.isFinite(v))) {
        throw new Error(`Layer "${l.name}" placement must be 9 finite numbers`);
      }
      placement = [...l.placement];
    }
    return {
      id: l.id,
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      image: { width: data.width, height: data.height, data: new Uint8ClampedArray(buf) },
      blendMode: l.blendMode ?? 'normal',
      mask,
      alphaLock: l.alphaLock ?? false,
      clipped: l.clipped ?? false,
      groupId,
      kind,
      text,
      shape,
      contentTransform,
      effects,
      placement
    };
  });
  // Phase 54: guides and grid. Absent = a pre-Phase-54 file (no guides,
  // default grid). Present values are validated like any other corrupt
  // input: rejected, never silently loaded.
  const guides = (data.guides ?? []).map((g) => {
    if (!g || !GUIDE_ORIENTATIONS.includes(g.orientation)) {
      throw new Error(`Project guide has unknown orientation: ${g?.orientation}`);
    }
    if (typeof g.position !== 'number' || !Number.isFinite(g.position)) {
      throw new Error(`Project ${g.orientation} guide position is not finite: ${g.position}`);
    }
    return { orientation: g.orientation, position: g.position };
  });
  const grid = data.grid ? { ...data.grid } : { ...DEFAULT_GRID_SETTINGS };
  if (
    !Number.isFinite(grid.spacingX) || grid.spacingX <= 0 ||
    !Number.isFinite(grid.spacingY) || grid.spacingY <= 0 ||
    !Number.isFinite(grid.offsetX) || !Number.isFinite(grid.offsetY)
  ) {
    throw new Error(`Project grid settings out of range: ${JSON.stringify(data.grid)}`);
  }
  const project: ImageProject = { width: data.width, height: data.height, layers, groups, activeLayerId: data.activeLayerId, guides, grid };
  // Phase 48: a content layer's data is the source of truth — re-render
  // its cache from the data so a loaded project is editable and renders
  // exactly what the data describes (rendering is deterministic, so the
  // composite is pixel-identical to the saved one).
  for (const layer of layers) {
    if (layer.kind === 'text' || layer.kind === 'shape') renderContentLayerInternal(project, layer);
  }
  return project;
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
