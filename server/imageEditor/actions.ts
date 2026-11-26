/**
 * Phase 53: Actions and Batch Processing.
 *
 * An *action* is a reusable, serializable recording of real engine
 * operations: an ordered list of steps `{ op, params }`, where every
 * `op` names one entry point of this engine (Phase 47 registry
 * filters, the Phase 19 adjustments, layer operations, canvas
 * operations, composite export). Actions are data, but they are not a
 * second implementation of anything — replay (`applyAction`) executes
 * the steps by calling the engine functions themselves, so an action
 * can never do something the engine cannot, and its result is exactly
 * the result of performing the operations by hand.
 *
 * Validation is total and happens before any pixel is touched:
 * `validateAction` checks the structure, rejects unknown operations
 * and unknown parameter keys, and validates filter steps through the
 * Phase 47 registry (`getFilterDescriptor` + `resolveFilterParams`,
 * which also fills in schema defaults, so a validated action's filter
 * parameters are complete and stable). Adjustment ranges mirror what
 * the engine itself enforces or documents (`setLayerOpacity` throws
 * outside 0..1; `adjustSaturation` documents amount as -1..1;
 * brightness/contrast are validated as finite numbers because the
 * Phase 19 formula accepts any finite value). An invalid action is
 * rejected at definition/load time — never halfway through a replay.
 *
 * `ActionRecorder` produces actions by *doing*: each of its methods
 * performs the operation on a live project through the engine and
 * appends the corresponding step (target layers are recorded by name,
 * the portable handle — engine layer ids are per-project UUIDs).
 *
 * Batch processing (`startBatch`) is the export queue: it runs one
 * action over many image files (PNG/BMP via the existing codec),
 * starting files in input order through a configurable number of
 * lanes (default 1), reporting per-file status and aggregate
 * progress, honouring cancellation between files, and recording a
 * corrupt input as that file's failure without aborting the batch.
 * The job drains to a summary of `{ done, failed, cancelled }`
 * counts. Per-file work between filesystem awaits is synchronous
 * engine work, so a file that has started always finishes; cancella-
 * tion stops *new* files from starting, and files that never started
 * are reported as cancelled.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  addLayer,
  adjustBrightnessContrast,
  adjustSaturation,
  applyFilter,
  composite,
  createProject,
  fillRect,
  getFilterDescriptor,
  getLayer,
  grayscale,
  invert,
  resizeProject,
  resolveFilterParams,
  rotateProject,
  setLayerBlendMode,
  setLayerOpacity,
  setLayerVisibility
} from './imageCore.js';
import { encodePng, exportImage, importImage } from './imageCodec.js';
import type { ImageFormat } from './imageCodec.js';
import { BLEND_MODES } from './types.js';
import type { BlendMode, ImageProject, Layer, PixelImage, Rect, RgbaColor } from './types.js';

// ------------------------------------------------------------------ model

/** One recorded operation. `params` is validated per operation id. */
export interface ActionStep {
  op: string;
  params: Record<string, unknown>;
}

/** A named, ordered, replayable list of engine operations. */
export interface ImageAction {
  name: string;
  steps: ActionStep[];
}

/** One snapshot produced by an `export` step during replay. */
export interface ActionOutput {
  /** File name the snapshot carries (plain name, no directories). */
  name: string;
  format: ImageFormat;
  buffer: Buffer;
  /** Index of the step that produced this output. */
  stepIndex: number;
}

interface OpSpec {
  /** Parameter keys the operation accepts; anything else is rejected. */
  keys: readonly string[];
  /** Short human description, for UIs and docs. */
  description: string;
}

/**
 * The action vocabulary. Every id maps to a real engine entry point
 * (named in the description); there is no operation here that the
 * engine does not genuinely implement.
 */
export const ACTION_OPS: Readonly<Record<string, OpSpec>> = {
  filter: {
    keys: ['filter', 'params', 'layer'],
    description: 'Apply a Phase 47 registry filter to a layer (applyFilter)'
  },
  'brightness-contrast': {
    keys: ['brightness', 'contrast', 'layer'],
    description: 'Phase 19 brightness/contrast adjustment (adjustBrightnessContrast)'
  },
  saturation: {
    keys: ['amount', 'layer'],
    description: 'Phase 19 saturation adjustment, amount -1..1 (adjustSaturation)'
  },
  invert: { keys: ['layer'], description: 'Phase 19 invert adjustment (invert)' },
  grayscale: { keys: ['layer'], description: 'Phase 19 grayscale adjustment (grayscale)' },
  'add-layer': { keys: ['name'], description: 'Add a new transparent layer and make it active (addLayer)' },
  'fill-rect': {
    keys: ['rect', 'color', 'layer'],
    description: 'Fill a rectangle with a color (fillRect)'
  },
  'set-opacity': { keys: ['opacity', 'layer'], description: 'Set a layer opacity 0..1 (setLayerOpacity)' },
  'set-visibility': { keys: ['visible', 'layer'], description: 'Show or hide a layer (setLayerVisibility)' },
  'set-blend-mode': { keys: ['mode', 'layer'], description: 'Set a layer blend mode (setLayerBlendMode)' },
  flatten: {
    keys: [],
    description: 'Replace the whole layer stack with the composited image (composite)'
  },
  resize: { keys: ['width', 'height'], description: 'Resize the canvas and every layer (resizeProject)' },
  rotate: { keys: ['degrees'], description: 'Rotate the canvas by 90, 180 or 270 degrees (rotateProject)' },
  export: {
    keys: ['format', 'name'],
    description: 'Snapshot the current composite as PNG or BMP (composite + exportImage)'
  }
};

/** The operation ids an action may use, in vocabulary order. */
export function listActionOps(): { id: string; description: string; params: readonly string[] }[] {
  return Object.entries(ACTION_OPS).map(([id, spec]) => ({ id, description: spec.description, params: spec.keys }));
}

// ------------------------------------------------------------- validation

function fail(message: string): never {
  throw new Error(`Invalid action: ${message}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reqFinite(params: Record<string, unknown>, key: string, where: string): number {
  const v = params[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${where}: parameter '${key}' must be a finite number`);
  return v;
}

function optLayer(params: Record<string, unknown>, where: string): string | undefined {
  const v = params.layer;
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length === 0) fail(`${where}: parameter 'layer' must be a non-empty layer name`);
  return v;
}

/** Plain file name: no directories, no traversal, not empty. */
function assertPlainFileName(name: unknown, where: string): string {
  if (typeof name !== 'string' || name.length === 0) fail(`${where}: export 'name' must be a non-empty file name`);
  if (name !== path.basename(name) || name === '.' || name === '..') {
    fail(`${where}: export 'name' must be a plain file name without directories: '${name}'`);
  }
  return name;
}

function validateStep(raw: unknown, index: number): ActionStep {
  const where = `step ${index}`;
  if (!isPlainObject(raw)) fail(`${where}: each step must be an object { op, params }`);
  const op = raw.op;
  if (typeof op !== 'string' || !(op in ACTION_OPS)) {
    fail(`${where}: unknown operation '${String(op)}' (known: ${Object.keys(ACTION_OPS).join(', ')})`);
  }
  const spec = ACTION_OPS[op];
  const rawParams = raw.params ?? {};
  if (!isPlainObject(rawParams)) fail(`${where} (${op}): 'params' must be an object`);
  for (const key of Object.keys(rawParams)) {
    if (!spec.keys.includes(key)) fail(`${where} (${op}): unknown parameter '${key}'`);
  }
  const params: Record<string, unknown> = {};
  switch (op) {
    case 'filter': {
      const filterId = rawParams.filter;
      if (typeof filterId !== 'string') fail(`${where} (filter): parameter 'filter' must be a filter id string`);
      // The registry itself is the validator: unknown ids throw here,
      // and resolveFilterParams validates names/ranges and fills the
      // schema defaults, so the stored params are complete. Registry
      // errors are rethrown with the step context attached.
      const given = rawParams.params ?? {};
      if (!isPlainObject(given)) fail(`${where} (filter): parameter 'params' must be an object of numbers`);
      const numeric: Record<string, number> = {};
      for (const [k, v] of Object.entries(given)) {
        if (typeof v !== 'number') fail(`${where} (filter): parameter '${k}' for filter '${filterId}' must be a number`);
        numeric[k] = v;
      }
      params.filter = filterId;
      try {
        getFilterDescriptor(filterId);
        params.params = resolveFilterParams(filterId, numeric);
      } catch (err) {
        fail(`${where} (filter): ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }
    case 'brightness-contrast':
      params.brightness = reqFinite(rawParams, 'brightness', `${where} (brightness-contrast)`);
      params.contrast = reqFinite(rawParams, 'contrast', `${where} (brightness-contrast)`);
      break;
    case 'saturation': {
      const amount = reqFinite(rawParams, 'amount', `${where} (saturation)`);
      // The engine documents amount as -1 (grayscale) .. 1 (double).
      if (amount < -1 || amount > 1) fail(`${where} (saturation): 'amount' out of range -1..1: ${amount}`);
      params.amount = amount;
      break;
    }
    case 'invert':
    case 'grayscale':
      break;
    case 'add-layer': {
      if (rawParams.name !== undefined) {
        if (typeof rawParams.name !== 'string' || rawParams.name.length === 0) {
          fail(`${where} (add-layer): 'name' must be a non-empty string`);
        }
        params.name = rawParams.name;
      }
      break;
    }
    case 'fill-rect': {
      const rect = rawParams.rect;
      if (!isPlainObject(rect)) fail(`${where} (fill-rect): 'rect' must be an object { x, y, width, height }`);
      const r: Record<string, number> = {};
      for (const k of ['x', 'y', 'width', 'height']) {
        const v = rect[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${where} (fill-rect): rect.${k} must be a finite number`);
        r[k] = v;
      }
      if (r.width <= 0 || r.height <= 0) fail(`${where} (fill-rect): rect width/height must be positive`);
      params.rect = r;
      const color = rawParams.color;
      if (!isPlainObject(color)) fail(`${where} (fill-rect): 'color' must be an object { r, g, b, a }`);
      const c: Record<string, number> = {};
      for (const k of ['r', 'g', 'b', 'a']) {
        const v = color[k];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 255) {
          fail(`${where} (fill-rect): color.${k} must be a number in 0..255`);
        }
        c[k] = v;
      }
      params.color = c;
      break;
    }
    case 'set-opacity': {
      const opacity = reqFinite(rawParams, 'opacity', `${where} (set-opacity)`);
      // Mirrors setLayerOpacity, which throws outside 0..1.
      if (opacity < 0 || opacity > 1) fail(`${where} (set-opacity): 'opacity' out of range 0..1: ${opacity}`);
      params.opacity = opacity;
      break;
    }
    case 'set-visibility': {
      if (typeof rawParams.visible !== 'boolean') fail(`${where} (set-visibility): 'visible' must be a boolean`);
      params.visible = rawParams.visible;
      break;
    }
    case 'set-blend-mode': {
      const mode = rawParams.mode;
      if (typeof mode !== 'string' || !(BLEND_MODES as readonly string[]).includes(mode)) {
        fail(`${where} (set-blend-mode): 'mode' must be one of ${BLEND_MODES.join(', ')}`);
      }
      params.mode = mode;
      break;
    }
    case 'flatten':
      break;
    case 'resize': {
      const width = reqFinite(rawParams, 'width', `${where} (resize)`);
      const height = reqFinite(rawParams, 'height', `${where} (resize)`);
      // Action-level safety bound: the engine would happily try to
      // allocate whatever it is asked for; an action file may not.
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384) {
        fail(`${where} (resize): width/height must be integers in 1..16384`);
      }
      params.width = width;
      params.height = height;
      break;
    }
    case 'rotate': {
      const degrees = reqFinite(rawParams, 'degrees', `${where} (rotate)`);
      if (degrees !== 90 && degrees !== 180 && degrees !== 270) {
        fail(`${where} (rotate): 'degrees' must be 90, 180 or 270`);
      }
      params.degrees = degrees;
      break;
    }
    case 'export': {
      const format = rawParams.format ?? 'png';
      if (format !== 'png' && format !== 'bmp') fail(`${where} (export): 'format' must be 'png' or 'bmp'`);
      params.format = format;
      if (rawParams.name !== undefined) params.name = assertPlainFileName(rawParams.name, where);
      break;
    }
  }
  if (spec.keys.includes('layer')) {
    const layer = optLayer(rawParams, where);
    if (layer !== undefined) params.layer = layer;
  }
  return { op, params };
}

/**
 * Validate unknown data as an action and return the canonical form:
 * a deep copy whose filter parameters are resolved (defaults filled)
 * and whose export formats are explicit. Throws on the first problem
 * — an action that passes this function replays without validation
 * surprises.
 */
export function validateAction(data: unknown): ImageAction {
  if (!isPlainObject(data)) fail('an action must be an object { name, steps }');
  if (typeof data.name !== 'string' || data.name.length === 0) fail('an action needs a non-empty string name');
  if (!Array.isArray(data.steps)) fail(`action '${data.name}': 'steps' must be an array`);
  return { name: data.name, steps: data.steps.map((s, i) => validateStep(s, i)) };
}

/** Define an action from steps, validating immediately. */
export function defineAction(name: string, steps: ActionStep[]): ImageAction {
  return validateAction({ name, steps });
}

/** Serialize an action (a preset) to JSON text. */
export function serializeAction(action: ImageAction): string {
  return JSON.stringify(validateAction(action), null, 2);
}

/** Load an action from JSON text, validating on load. Throws on bad JSON or an invalid action. */
export function parseAction(json: string): ImageAction {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new Error(`Invalid action: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  return validateAction(data);
}

// ----------------------------------------------------------------- replay

/** Resolve a step's target layer: by recorded name, else the project's active layer. */
function resolveLayerId(project: ImageProject, layerName: string | undefined, op: string): string {
  if (layerName !== undefined) {
    const layer = project.layers.find((l) => l.name === layerName);
    if (!layer) throw new Error(`Action step '${op}': layer not found by name: '${layerName}'`);
    return layer.id;
  }
  if (project.activeLayerId && project.layers.some((l) => l.id === project.activeLayerId)) {
    return project.activeLayerId;
  }
  const top = project.layers[project.layers.length - 1];
  if (!top) throw new Error(`Action step '${op}': the project has no layers`);
  return top.id;
}

/**
 * Replay an action on a project by calling the engine functions the
 * steps name, in order. The project is mutated exactly as if the
 * operations had been performed by hand; `export` steps do not mutate
 * — they collect a snapshot of the current composite into the
 * returned outputs. The action is validated first (see
 * `validateAction`), so a bad action fails before any pixel changes.
 */
export function applyAction(project: ImageProject, action: ImageAction): { outputs: ActionOutput[] } {
  const valid = validateAction(action);
  const outputs: ActionOutput[] = [];
  valid.steps.forEach((step, stepIndex) => {
    const p = step.params;
    switch (step.op) {
      case 'filter':
        applyFilter(project, resolveLayerId(project, p.layer as string | undefined, step.op), p.filter as string, p.params as Record<string, number>);
        break;
      case 'brightness-contrast':
        adjustBrightnessContrast(project, resolveLayerId(project, p.layer as string | undefined, step.op), p.brightness as number, p.contrast as number);
        break;
      case 'saturation':
        adjustSaturation(project, resolveLayerId(project, p.layer as string | undefined, step.op), p.amount as number);
        break;
      case 'invert':
        invert(project, resolveLayerId(project, p.layer as string | undefined, step.op));
        break;
      case 'grayscale':
        grayscale(project, resolveLayerId(project, p.layer as string | undefined, step.op));
        break;
      case 'add-layer':
        addLayer(project, p.name as string | undefined);
        break;
      case 'fill-rect':
        fillRect(
          project,
          resolveLayerId(project, p.layer as string | undefined, step.op),
          p.rect as Rect,
          p.color as RgbaColor
        );
        break;
      case 'set-opacity':
        setLayerOpacity(project, resolveLayerId(project, p.layer as string | undefined, step.op), p.opacity as number);
        break;
      case 'set-visibility':
        setLayerVisibility(project, resolveLayerId(project, p.layer as string | undefined, step.op), p.visible as boolean);
        break;
      case 'set-blend-mode':
        setLayerBlendMode(project, resolveLayerId(project, p.layer as string | undefined, step.op), p.mode as BlendMode);
        break;
      case 'flatten': {
        const flat = composite(project);
        const layer: Layer = {
          id: crypto.randomUUID(),
          name: 'Flattened',
          visible: true,
          opacity: 1,
          image: flat,
          kind: 'raster',
          text: null,
          shape: null,
          contentTransform: null,
          blendMode: 'normal',
          mask: null,
          alphaLock: false,
          clipped: false,
          groupId: null,
          effects: [],
          placement: null
        };
        project.layers = [layer];
        project.groups = [];
        project.activeLayerId = layer.id;
        break;
      }
      case 'resize':
        resizeProject(project, p.width as number, p.height as number);
        break;
      case 'rotate':
        rotateProject(project, p.degrees as 90 | 180 | 270);
        break;
      case 'export': {
        const format = p.format as ImageFormat;
        outputs.push({
          name: (p.name as string | undefined) ?? `export-${stepIndex}.${format}`,
          format,
          buffer: exportImage(composite(project), format),
          stepIndex
        });
        break;
      }
    }
  });
  return { outputs };
}

// --------------------------------------------------------------- recorder

/**
 * Records an action by performing it. Every method calls the real
 * engine operation on the wrapped project and appends the step that
 * reproduces it; target layers are recorded by name. `action()`
 * returns the validated recording.
 */
export class ActionRecorder {
  private readonly steps: ActionStep[] = [];

  constructor(
    private readonly project: ImageProject,
    private readonly name: string
  ) {}

  private layerName(layerId?: string): string {
    const id = layerId ?? resolveLayerId(this.project, undefined, 'record');
    return getLayer(this.project, id).name;
  }

  filter(filterId: string, params?: Record<string, number>, layerId?: string): this {
    const layer = this.layerName(layerId);
    applyFilter(this.project, layerId ?? resolveLayerId(this.project, undefined, 'filter'), filterId, params);
    this.steps.push({ op: 'filter', params: { filter: filterId, params: resolveFilterParams(filterId, params), layer } });
    return this;
  }

  brightnessContrast(brightness: number, contrast: number, layerId?: string): this {
    const layer = this.layerName(layerId);
    adjustBrightnessContrast(this.project, layerId ?? resolveLayerId(this.project, undefined, 'brightness-contrast'), brightness, contrast);
    this.steps.push({ op: 'brightness-contrast', params: { brightness, contrast, layer } });
    return this;
  }

  saturation(amount: number, layerId?: string): this {
    const layer = this.layerName(layerId);
    adjustSaturation(this.project, layerId ?? resolveLayerId(this.project, undefined, 'saturation'), amount);
    this.steps.push({ op: 'saturation', params: { amount, layer } });
    return this;
  }

  invert(layerId?: string): this {
    const layer = this.layerName(layerId);
    invert(this.project, layerId ?? resolveLayerId(this.project, undefined, 'invert'));
    this.steps.push({ op: 'invert', params: { layer } });
    return this;
  }

  grayscale(layerId?: string): this {
    const layer = this.layerName(layerId);
    grayscale(this.project, layerId ?? resolveLayerId(this.project, undefined, 'grayscale'));
    this.steps.push({ op: 'grayscale', params: { layer } });
    return this;
  }

  addLayer(name?: string): Layer {
    const layer = addLayer(this.project, name);
    this.steps.push({ op: 'add-layer', params: name !== undefined ? { name } : {} });
    return layer;
  }

  fillRect(rect: Rect, color: RgbaColor, layerId?: string): this {
    const layer = this.layerName(layerId);
    fillRect(this.project, layerId ?? resolveLayerId(this.project, undefined, 'fill-rect'), rect, color);
    this.steps.push({ op: 'fill-rect', params: { rect: { ...rect }, color: { ...color }, layer } });
    return this;
  }

  setOpacity(opacity: number, layerId?: string): this {
    const layer = this.layerName(layerId);
    setLayerOpacity(this.project, layerId ?? resolveLayerId(this.project, undefined, 'set-opacity'), opacity);
    this.steps.push({ op: 'set-opacity', params: { opacity, layer } });
    return this;
  }

  setVisibility(visible: boolean, layerId?: string): this {
    const layer = this.layerName(layerId);
    setLayerVisibility(this.project, layerId ?? resolveLayerId(this.project, undefined, 'set-visibility'), visible);
    this.steps.push({ op: 'set-visibility', params: { visible, layer } });
    return this;
  }

  setBlendMode(mode: BlendMode, layerId?: string): this {
    const layer = this.layerName(layerId);
    setLayerBlendMode(this.project, layerId ?? resolveLayerId(this.project, undefined, 'set-blend-mode'), mode);
    this.steps.push({ op: 'set-blend-mode', params: { mode, layer } });
    return this;
  }

  flatten(): this {
    applyAction(this.project, { name: this.name, steps: [{ op: 'flatten', params: {} }] });
    this.steps.push({ op: 'flatten', params: {} });
    return this;
  }

  resize(width: number, height: number): this {
    resizeProject(this.project, width, height);
    this.steps.push({ op: 'resize', params: { width, height } });
    return this;
  }

  rotate(degrees: 90 | 180 | 270): this {
    rotateProject(this.project, degrees);
    this.steps.push({ op: 'rotate', params: { degrees } });
    return this;
  }

  /** Record an export step and return the snapshot it names, taken now. */
  exportSnapshot(format: ImageFormat = 'png', name?: string): ActionOutput {
    const buffer = exportImage(composite(this.project), format);
    this.steps.push({ op: 'export', params: name !== undefined ? { format, name } : { format } });
    return { name: name ?? `export-${this.steps.length - 1}.${format}`, format, buffer, stepIndex: this.steps.length - 1 };
  }

  /** The recording so far, validated into canonical form. */
  action(): ImageAction {
    return validateAction({ name: this.name, steps: this.steps });
  }
}

// ------------------------------------------------------------------ batch

export type BatchFileStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface BatchFileResult {
  /** Input path, as given. */
  input: string;
  /** Output path written, or null when nothing was written. */
  output: string | null;
  status: BatchFileStatus;
  /** The failure's message when status is 'failed', else null. */
  error: string | null;
}

export interface BatchProgress {
  total: number;
  /** Files that reached done/failed. */
  settled: number;
  done: number;
  failed: number;
  cancelled: number;
  running: number;
  pending: number;
}

export interface BatchSummary {
  total: number;
  done: number;
  failed: number;
  cancelled: number;
  results: BatchFileResult[];
}

export interface BatchOptions {
  /** Input image files (PNG or BMP — whatever `importImage` decodes). */
  inputs: string[];
  /** Directory outputs are written into (created if missing). */
  outputDir: string;
  /** The action to run on every input. Validated before the job starts. */
  action: ImageAction;
  /**
   * How many files the queue works on at once. Default 1 (strictly
   * sequential). Files always *start* in input order; with more lanes
   * they may finish out of order.
   */
  concurrency?: number;
  /** Override the output file name for an input (plain name; default derives from the input name). */
  outputName?: (inputPath: string, index: number) => string;
  /**
   * Called after every file settles (done or failed) with a progress
   * snapshot and the per-file results so far. Calling `job.cancel()`
   * from here is the deterministic way to stop a batch early.
   */
  onProgress?: (progress: BatchProgress, results: readonly BatchFileResult[]) => void;
}

export interface BatchJob {
  /** Resolves when the queue has drained (never rejects for per-file failures). */
  readonly done: Promise<BatchSummary>;
  /** Ask the queue to stop starting new files. In-flight files finish. */
  cancel(): void;
  /** Aggregate progress snapshot. */
  progress(): BatchProgress;
  /** Per-file results, in input order (copies). */
  fileResults(): BatchFileResult[];
}

/** Build the single-layer project a batch file is processed as. */
function projectFromImage(img: PixelImage): ImageProject {
  const project = createProject(img.width, img.height);
  // The decoded image becomes the Background layer's pixels (the same
  // assignment the engine's own tests and routes use for imports).
  project.layers[0].image = img;
  return project;
}

function defaultOutputName(inputPath: string, format: ImageFormat): string {
  const base = path.basename(inputPath).replace(/\.[^.]*$/, '');
  return `${base}.edited.${format}`;
}

/**
 * Start a batch: run `options.action` over every input file and write
 * each result into `options.outputDir`. The written bytes are the
 * action's last `export` snapshot when the action exports, else the
 * final composite encoded as PNG. The output file name comes from
 * `options.outputName` when given, else from the input name (the
 * export step's *name* is deliberately not used per file — one fixed
 * name would make every file overwrite the previous one).
 *
 * Throws synchronously on invalid options or an invalid action;
 * per-file failures (missing/corrupt inputs, replay errors) are
 * recorded on that file's result and never abort the batch.
 */
export function startBatch(options: BatchOptions): BatchJob {
  const action = validateAction(options.action);
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`Invalid batch: concurrency must be a positive integer, got ${options.concurrency}`);
  }
  if (!Array.isArray(options.inputs) || options.inputs.some((i) => typeof i !== 'string')) {
    throw new Error('Invalid batch: inputs must be an array of file paths');
  }
  if (typeof options.outputDir !== 'string' || options.outputDir.length === 0) {
    throw new Error('Invalid batch: outputDir must be a non-empty path');
  }

  const results: BatchFileResult[] = options.inputs.map((input) => ({
    input,
    output: null,
    status: 'pending',
    error: null
  }));
  let cancelRequested = false;
  let nextIndex = 0;

  const progress = (): BatchProgress => {
    const p: BatchProgress = {
      total: results.length,
      settled: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
      running: 0,
      pending: 0
    };
    for (const r of results) {
      if (r.status === 'done') p.done++;
      else if (r.status === 'failed') p.failed++;
      else if (r.status === 'cancelled') p.cancelled++;
      else if (r.status === 'running') p.running++;
      else p.pending++;
    }
    p.settled = p.done + p.failed;
    return p;
  };

  const processFile = async (index: number): Promise<void> => {
    const result = results[index];
    result.status = 'running';
    try {
      const bytes = await fs.readFile(result.input);
      const img = importImage(bytes);
      const project = projectFromImage(img);
      const { outputs } = applyAction(project, action);
      let buffer: Buffer;
      let format: ImageFormat = 'png';
      if (outputs.length > 0) {
        const last = outputs[outputs.length - 1];
        buffer = last.buffer;
        format = last.format;
      } else {
        buffer = encodePng(composite(project));
      }
      const name = options.outputName
        ? assertPlainFileName(options.outputName(result.input, index), `output name for '${result.input}'`)
        : defaultOutputName(result.input, format);
      const outputPath = path.join(options.outputDir, name);
      await fs.writeFile(outputPath, buffer);
      result.output = outputPath;
      result.status = 'done';
    } catch (err) {
      result.status = 'failed';
      result.error = err instanceof Error ? err.message : String(err);
    }
    options.onProgress?.(progress(), results);
  };

  const run = async (): Promise<BatchSummary> => {
    await fs.mkdir(options.outputDir, { recursive: true });
    const lanes = Math.max(1, Math.min(concurrency, results.length));
    const lane = async (): Promise<void> => {
      for (;;) {
        if (cancelRequested) return;
        const index = nextIndex++;
        if (index >= results.length) return;
        await processFile(index);
      }
    };
    await Promise.all(Array.from({ length: lanes }, () => lane()));
    // Anything never started is cancelled, whether by cancel() or by
    // the queue having drained around it.
    for (const r of results) {
      if (r.status === 'pending' || r.status === 'running') r.status = 'cancelled';
    }
    const p = progress();
    return {
      total: p.total,
      done: p.done,
      failed: p.failed,
      cancelled: p.cancelled,
      results: results.map((r) => ({ ...r }))
    };
  };

  return {
    done: run(),
    cancel: () => {
      cancelRequested = true;
    },
    progress,
    fileResults: () => results.map((r) => ({ ...r }))
  };
}
