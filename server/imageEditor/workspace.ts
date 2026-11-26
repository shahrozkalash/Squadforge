/**
 * Phase 54: Professional Workspace and Usability.
 *
 * The workspace layer of the image editor, as real data and pure
 * logic over the existing engine — nothing here renders pixels:
 *
 *  - Panel layout: the six editor panels placed on dock edges with
 *    visibility and relative weights, plus named presets. Layout
 *    operations validate their targets (unknown panel/dock and
 *    non-positive weights are rejected).
 *  - Keyboard shortcuts: every editor command (each one names a real
 *    engine entry point or a real control of the generated desktop
 *    app) bound to a key chord. Matching is modifier-exact, rebinding
 *    detects conflicts, and the map serializes with the workspace.
 *    Because every command in EDITOR_COMMANDS carries a default
 *    binding, the whole documented command set is keyboard-reachable.
 *  - Tool state: the active tool, its validated Phase 46 brush
 *    settings, and the color panel's foreground/background pair with
 *    swap/reset.
 *  - Guides, grid and snapping: guide lines and the grid are project
 *    data (persisted by serializeProject since Phase 54); the snap
 *    functions are pure and exact — a coordinate snaps to the closest
 *    candidate within the threshold, with guide > canvas > grid
 *    priority on an exact distance tie.
 *
 * What this module is NOT: a renderer. Whether a shell draws the
 * panels is the shell's business (the generated C# app consumes the
 * same layout/shortcut data — see imageProjectGenerator.ts); visual
 * accessibility of any shell is unverified on this host and is not
 * claimed here.
 */
import type {
  BrushSettings,
  EditorWorkspace,
  GridSettings,
  GuideLine,
  GuideOrientation,
  ImageProject,
  ImageTool,
  KeyChord,
  KeyEventLike,
  PanelDock,
  PanelLayout,
  Point,
  RgbaColor,
  SerializedWorkspace,
  WorkspacePanelId,
  WorkspaceToolState
} from './types.js';
import { GUIDE_ORIENTATIONS, IMAGE_TOOLS, PANEL_DOCKS, WORKSPACE_PANEL_IDS } from './types.js';
import { createBrushSettings, deserializeBrushPreset, serializeBrushPreset } from './imageCore.js';

// ---------------------------------------------------------------- panels

function panel(id: WorkspacePanelId, dock: PanelDock, visible: boolean, weight: number): PanelLayout {
  return { id, dock, visible, weight };
}

/** The default layout: tools and filters on the left; layers, colors, history and properties on the right. */
export function defaultPanels(): PanelLayout[] {
  return [
    panel('tools', 'left', true, 1),
    panel('layers', 'right', true, 3),
    panel('colors', 'right', true, 2),
    panel('filters', 'left', true, 2),
    panel('history', 'right', true, 2),
    panel('properties', 'right', true, 2)
  ];
}

/** The focus layout: only the tools, layers and colors panels stay visible. */
export function focusPanels(): PanelLayout[] {
  return [
    panel('tools', 'left', true, 1),
    panel('layers', 'right', true, 3),
    panel('colors', 'right', true, 2),
    panel('filters', 'left', false, 2),
    panel('history', 'right', false, 2),
    panel('properties', 'right', false, 2)
  ];
}

function requirePanel(ws: EditorWorkspace, panelId: WorkspacePanelId): PanelLayout {
  if (!WORKSPACE_PANEL_IDS.includes(panelId)) {
    throw new Error(`Unknown workspace panel: ${panelId}`);
  }
  const found = ws.panels.find((p) => p.id === panelId);
  if (!found) throw new Error(`Workspace has no panel: ${panelId}`);
  return found;
}

/** Look up one panel's layout entry. Unknown panel ids are rejected. */
export function getPanelLayout(ws: EditorWorkspace, panelId: WorkspacePanelId): PanelLayout {
  return requirePanel(ws, panelId);
}

/** Show or hide a panel. Unknown panel ids are rejected. */
export function setPanelVisible(ws: EditorWorkspace, panelId: WorkspacePanelId, visible: boolean): EditorWorkspace {
  requirePanel(ws, panelId).visible = visible === true;
  return ws;
}

/** Move a panel to another dock edge. Unknown panels and docks are rejected. */
export function movePanel(ws: EditorWorkspace, panelId: WorkspacePanelId, dock: PanelDock): EditorWorkspace {
  if (!PANEL_DOCKS.includes(dock)) {
    throw new Error(`Unknown panel dock: ${dock}`);
  }
  requirePanel(ws, panelId).dock = dock;
  return ws;
}

/** Set a panel's relative weight within its dock. Weight must be a positive finite number. */
export function setPanelWeight(ws: EditorWorkspace, panelId: WorkspacePanelId, weight: number): EditorWorkspace {
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
    throw new Error(`Panel weight must be a positive finite number: ${weight}`);
  }
  requirePanel(ws, panelId).weight = weight;
  return ws;
}

// ---------------------------------------------------------------- commands & shortcuts

/**
 * The editor's command set. Every command names a capability that
 * genuinely exists: an engine entry point in this module's engine
 * (imageCore.ts / imageCodec.ts) or a control of the generated
 * desktop app (imageProjectGenerator.ts), noted in its title.
 */
export interface EditorCommand {
  id: string;
  title: string;
}

export const EDITOR_COMMANDS: readonly EditorCommand[] = [
  { id: 'file.new', title: 'New project (engine: createProject)' },
  { id: 'file.open', title: 'Open project (engine: deserializeProject)' },
  { id: 'file.save', title: 'Save project (engine: serializeProject)' },
  { id: 'file.exportPng', title: 'Export flattened PNG (engine: composite + encodePng)' },
  { id: 'edit.undo', title: 'Undo (engine: HistoryStack.undo)' },
  { id: 'edit.redo', title: 'Redo (engine: HistoryStack.redo)' },
  { id: 'tool.brush', title: 'Brush tool (engine: ImageTool "brush")' },
  { id: 'tool.eraser', title: 'Eraser tool (engine: ImageTool "eraser")' },
  { id: 'tool.rectangle', title: 'Rectangle tool (engine: ImageTool "rectangle")' },
  { id: 'tool.ellipse', title: 'Ellipse tool (engine: ImageTool "ellipse")' },
  { id: 'tool.line', title: 'Line tool (engine: ImageTool "line")' },
  { id: 'tool.text', title: 'Text tool (engine: ImageTool "text")' },
  { id: 'tool.fill', title: 'Fill tool (engine: ImageTool "fill")' },
  { id: 'layer.add', title: 'Add layer (engine: addLayer)' },
  { id: 'layer.delete', title: 'Delete active layer (engine: removeLayer)' },
  { id: 'layer.moveUp', title: 'Move active layer up (engine: moveLayer)' },
  { id: 'layer.moveDown', title: 'Move active layer down (engine: moveLayer)' },
  { id: 'view.zoomIn', title: 'Zoom in (engine: zoomAt)' },
  { id: 'view.zoomOut', title: 'Zoom out (engine: zoomAt)' },
  { id: 'image.rotate90', title: 'Rotate canvas 90° (engine: rotateProject)' },
  { id: 'image.flipHorizontal', title: 'Flip canvas horizontally (engine: flipImage applied per layer; generated app: RotateFlip)' }
];

export const EDITOR_COMMAND_IDS: readonly string[] = EDITOR_COMMANDS.map((c) => c.id);

function requireCommand(commandId: string): void {
  if (!EDITOR_COMMAND_IDS.includes(commandId)) {
    throw new Error(`Unknown editor command: ${commandId}`);
  }
}

const NAMED_KEYS: Record<string, string> = {
  delete: 'Delete',
  del: 'Delete',
  backspace: 'Backspace',
  enter: 'Enter',
  return: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  space: 'Space',
  ' ': 'Space',
  tab: 'Tab',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  insert: 'Insert'
};

/**
 * Canonical form of a key name: single characters are uppercased,
 * known named keys take their canonical spelling, F1–F24 are
 * recognized. Anything else is rejected — bindings are authored data
 * and a misspelled key must not silently become a dead shortcut.
 */
export function normalizeKeyName(key: string): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`Key name must be a non-empty string: ${key}`);
  }
  if (key.length === 1) return key.toUpperCase();
  const named = NAMED_KEYS[key.toLowerCase()];
  if (named) return named;
  const f = /^f(\d{1,2})$/i.exec(key);
  if (f) {
    const n = parseInt(f[1], 10);
    if (n >= 1 && n <= 24) return `F${n}`;
  }
  throw new Error(`Unknown key name: ${key}`);
}

/** Canonicalize a chord: canonical key name, modifiers defaulted to false. */
export function normalizeKeyChord(input: { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean }): KeyChord {
  if (!input || typeof input !== 'object') throw new Error('Key chord must be an object');
  return {
    key: normalizeKeyName(input.key),
    ctrl: input.ctrl === true,
    shift: input.shift === true,
    alt: input.alt === true
  };
}

/** The display/storage string of a chord, e.g. "Ctrl+Shift+S". */
export function formatKeyChord(chord: KeyChord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.shift) parts.push('Shift');
  if (chord.alt) parts.push('Alt');
  parts.push(chord.key);
  return parts.join('+');
}

/** Parse a chord string such as "Ctrl+Shift+S" (the form formatKeyChord produces). */
export function parseKeyChord(text: string): KeyChord {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error(`Key chord must be a non-empty string: ${text}`);
  }
  let body = text.trim();
  let key: string;
  if (body.endsWith('++')) {
    key = '+';
    body = body.slice(0, -2);
  } else {
    const cut = body.lastIndexOf('+');
    if (cut === -1) {
      key = body;
      body = '';
    } else {
      key = body.slice(cut + 1);
      body = body.slice(0, cut);
    }
  }
  const chord: KeyChord = { key: '', ctrl: false, shift: false, alt: false };
  if (body.length > 0) {
    for (const mod of body.split('+')) {
      const m = mod.trim().toLowerCase();
      if (m === 'ctrl' || m === 'control') chord.ctrl = true;
      else if (m === 'shift') chord.shift = true;
      else if (m === 'alt') chord.alt = true;
      else throw new Error(`Unknown key modifier in chord "${text}": ${mod}`);
    }
  }
  chord.key = normalizeKeyName(key);
  return chord;
}

export function chordsEqual(a: KeyChord, b: KeyChord): boolean {
  return a.key === b.key && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt;
}

function chord(ch: string): KeyChord {
  return parseKeyChord(ch);
}

/**
 * The default shortcut map. Every command in EDITOR_COMMANDS has
 * exactly one binding here, so the full documented command set is
 * reachable from the keyboard alone.
 */
export function createDefaultShortcuts(): Record<string, KeyChord> {
  return {
    'file.new': chord('Ctrl+N'),
    'file.open': chord('Ctrl+O'),
    'file.save': chord('Ctrl+S'),
    'file.exportPng': chord('Ctrl+Shift+E'),
    'edit.undo': chord('Ctrl+Z'),
    'edit.redo': chord('Ctrl+Shift+Z'),
    'tool.brush': chord('B'),
    'tool.eraser': chord('E'),
    'tool.rectangle': chord('U'),
    'tool.ellipse': chord('O'),
    'tool.line': chord('L'),
    'tool.text': chord('T'),
    'tool.fill': chord('G'),
    'layer.add': chord('Ctrl+Shift+N'),
    'layer.delete': chord('Delete'),
    'layer.moveUp': chord('Ctrl+]'),
    'layer.moveDown': chord('Ctrl+['),
    'view.zoomIn': chord('Ctrl+='),
    'view.zoomOut': chord('Ctrl+-'),
    'image.rotate90': chord('Ctrl+Shift+R'),
    'image.flipHorizontal': chord('Ctrl+Shift+H')
  };
}

/**
 * Bind a command to a chord. Rebinding the command that already owns
 * the chord is a no-op; binding a chord owned by a DIFFERENT command
 * is a conflict and is rejected, naming both commands.
 */
export function setShortcut(map: Record<string, KeyChord>, commandId: string, input: { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean }): Record<string, KeyChord> {
  requireCommand(commandId);
  const normalized = normalizeKeyChord(input);
  for (const [otherId, otherChord] of Object.entries(map)) {
    if (otherId !== commandId && chordsEqual(otherChord, normalized)) {
      throw new Error(`Shortcut conflict: "${formatKeyChord(normalized)}" is already bound to ${otherId}`);
    }
  }
  map[commandId] = normalized;
  return map;
}

/** The command a chord is bound to in a map, or null. */
export function findCommandForChord(map: Record<string, KeyChord>, input: { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean }): string | null {
  const normalized = normalizeKeyChord(input);
  for (const [commandId, bound] of Object.entries(map)) {
    if (chordsEqual(bound, normalized)) return commandId;
  }
  return null;
}

/**
 * Resolve a key event to a command id, or null when nothing matches.
 * Matching is modifier-exact: an event carrying Shift does not fire a
 * Ctrl+Z binding, and a plain Z does not fire Ctrl+Z. Events whose
 * key cannot be canonicalized resolve to null rather than throwing —
 * a live event stream must never crash the shell.
 */
export function resolveShortcut(map: Record<string, KeyChord>, event: KeyEventLike): string | null {
  let normalized: KeyChord;
  try {
    normalized = normalizeKeyChord(event);
  } catch {
    return null;
  }
  for (const [commandId, bound] of Object.entries(map)) {
    if (chordsEqual(bound, normalized)) return commandId;
  }
  return null;
}

/** JSON-safe copy of a shortcut map, with every chord validated and canonicalized. */
export function serializeShortcuts(map: Record<string, KeyChord>): Record<string, KeyChord> {
  const out: Record<string, KeyChord> = {};
  for (const [commandId, bound] of Object.entries(map)) {
    requireCommand(commandId);
    out[commandId] = normalizeKeyChord(bound);
  }
  return out;
}

/**
 * Load a shortcut map from serialized data. Unknown commands,
 * malformed chords and two commands sharing one chord are rejected,
 * never silently loaded.
 */
export function deserializeShortcuts(data: Record<string, KeyChord>): Record<string, KeyChord> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Serialized shortcuts must be an object');
  }
  const out: Record<string, KeyChord> = {};
  for (const [commandId, bound] of Object.entries(data)) {
    requireCommand(commandId);
    if (!bound || typeof bound !== 'object') {
      throw new Error(`Shortcut for ${commandId} must be a chord object`);
    }
    setShortcut(out, commandId, bound);
  }
  return out;
}

// ---------------------------------------------------------------- tool & color state

export const DEFAULT_FOREGROUND: RgbaColor = { r: 0, g: 0, b: 0, a: 255 };
export const DEFAULT_BACKGROUND: RgbaColor = { r: 255, g: 255, b: 255, a: 255 };

function assertWorkspaceColor(c: RgbaColor, what: string): void {
  if (!c || ![c.r, c.g, c.b, c.a].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 255)) {
    throw new Error(`${what} out of range`);
  }
}

function cloneColor(c: RgbaColor): RgbaColor {
  return { r: c.r, g: c.g, b: c.b, a: c.a };
}

/** Default tool state: brush active with the Phase 46 default settings, black over white. */
export function createDefaultToolState(): WorkspaceToolState {
  return {
    activeTool: 'brush',
    brush: createBrushSettings(),
    foreground: { ...DEFAULT_FOREGROUND },
    background: { ...DEFAULT_BACKGROUND }
  };
}

/** Select the active tool. Unknown tools are rejected. */
export function setActiveTool(state: WorkspaceToolState, tool: ImageTool): WorkspaceToolState {
  if (!IMAGE_TOOLS.includes(tool)) {
    throw new Error(`Unknown image tool: ${tool}`);
  }
  state.activeTool = tool;
  return state;
}

/**
 * Merge brush-setting overrides over the current settings. The
 * result passes through the Phase 46 validator (`createBrushSettings`),
 * so out-of-range values are rejected, never stored.
 */
export function setBrushSettings(state: WorkspaceToolState, partial: Partial<BrushSettings>): WorkspaceToolState {
  state.brush = createBrushSettings({ ...state.brush, ...(partial ?? {}) });
  return state;
}

/** Set the foreground (paint) color. Channels must be finite and within 0..255. */
export function setForegroundColor(state: WorkspaceToolState, color: RgbaColor): WorkspaceToolState {
  assertWorkspaceColor(color, 'Foreground color');
  state.foreground = cloneColor(color);
  return state;
}

/** Set the background color. Channels must be finite and within 0..255. */
export function setBackgroundColor(state: WorkspaceToolState, color: RgbaColor): WorkspaceToolState {
  assertWorkspaceColor(color, 'Background color');
  state.background = cloneColor(color);
  return state;
}

/** Exchange the foreground and background colors. */
export function swapColors(state: WorkspaceToolState): WorkspaceToolState {
  const fg = state.foreground;
  state.foreground = state.background;
  state.background = fg;
  return state;
}

/** Restore the default color pair (black foreground, white background). */
export function resetColors(state: WorkspaceToolState): WorkspaceToolState {
  state.foreground = { ...DEFAULT_FOREGROUND };
  state.background = { ...DEFAULT_BACKGROUND };
  return state;
}

// ---------------------------------------------------------------- workspace aggregate & presets

/** A fresh workspace in the default preset. */
export function createDefaultWorkspace(): EditorWorkspace {
  return { panels: defaultPanels(), shortcuts: createDefaultShortcuts(), tool: createDefaultToolState() };
}

/** A fresh workspace in the focus preset (same shortcuts and tool state, minimal panels). */
export function createFocusWorkspace(): EditorWorkspace {
  return { panels: focusPanels(), shortcuts: createDefaultShortcuts(), tool: createDefaultToolState() };
}

export const WORKSPACE_PRESET_NAMES: readonly string[] = ['default', 'focus'];

export function listWorkspacePresets(): string[] {
  return [...WORKSPACE_PRESET_NAMES];
}

/** A fresh workspace for a named preset. Unknown preset names are rejected. Each call returns independent state. */
export function getWorkspacePreset(name: string): EditorWorkspace {
  if (name === 'default') return createDefaultWorkspace();
  if (name === 'focus') return createFocusWorkspace();
  throw new Error(`Unknown workspace preset: ${name}`);
}

function clonePanel(p: PanelLayout): PanelLayout {
  return { id: p.id, dock: p.dock, visible: p.visible, weight: p.weight };
}

/** Serialize a workspace to its JSON-safe form. The workspace is validated as it is written. */
export function serializeWorkspace(ws: EditorWorkspace): SerializedWorkspace {
  return {
    format: 'squadforge-editor-workspace',
    version: 1,
    panels: ws.panels.map((p) => {
      requirePanel(ws, p.id);
      if (!PANEL_DOCKS.includes(p.dock)) throw new Error(`Panel ${p.id} has unknown dock: ${p.dock}`);
      if (typeof p.weight !== 'number' || !Number.isFinite(p.weight) || p.weight <= 0) {
        throw new Error(`Panel ${p.id} weight out of range: ${p.weight}`);
      }
      return clonePanel(p);
    }),
    shortcuts: serializeShortcuts(ws.shortcuts),
    tool: {
      activeTool: ws.tool.activeTool,
      brush: serializeBrushPreset({ name: 'Workspace brush', settings: ws.tool.brush }).settings,
      foreground: cloneColor(ws.tool.foreground),
      background: cloneColor(ws.tool.background)
    }
  };
}

/**
 * Load a workspace from its serialized form. The panel set must be
 * exactly the six known panels (no duplicates, none missing), every
 * dock/weight/color/tool value must be valid, and the shortcut map
 * must validate — corrupt data is rejected, never silently loaded.
 */
export function deserializeWorkspace(data: SerializedWorkspace): EditorWorkspace {
  if (!data || data.format !== 'squadforge-editor-workspace' || data.version !== 1) {
    throw new Error('Not a SquadForge editor workspace (bad format/version)');
  }
  if (!Array.isArray(data.panels)) throw new Error('Workspace panels must be an array');
  const seen = new Set<string>();
  const panels: PanelLayout[] = data.panels.map((p) => {
    if (!p || !WORKSPACE_PANEL_IDS.includes(p.id)) {
      throw new Error(`Workspace panel has unknown id: ${p?.id}`);
    }
    if (seen.has(p.id)) throw new Error(`Duplicate workspace panel: ${p.id}`);
    seen.add(p.id);
    if (!PANEL_DOCKS.includes(p.dock)) throw new Error(`Panel ${p.id} has unknown dock: ${p.dock}`);
    if (typeof p.visible !== 'boolean') throw new Error(`Panel ${p.id} visibility must be a boolean`);
    if (typeof p.weight !== 'number' || !Number.isFinite(p.weight) || p.weight <= 0) {
      throw new Error(`Panel ${p.id} weight out of range: ${p.weight}`);
    }
    return clonePanel(p);
  });
  for (const id of WORKSPACE_PANEL_IDS) {
    if (!seen.has(id)) throw new Error(`Workspace is missing panel: ${id}`);
  }
  const shortcuts = deserializeShortcuts(data.shortcuts ?? {});
  const toolData = data.tool;
  if (!toolData || typeof toolData !== 'object') throw new Error('Workspace has no tool state');
  if (!IMAGE_TOOLS.includes(toolData.activeTool)) {
    throw new Error(`Workspace has unknown active tool: ${toolData.activeTool}`);
  }
  assertWorkspaceColor(toolData.foreground, 'Foreground color');
  assertWorkspaceColor(toolData.background, 'Background color');
  const brush = deserializeBrushPreset({
    format: 'squadforge-brush-preset',
    version: 1,
    name: 'Workspace brush',
    settings: toolData.brush
  }).settings;
  return {
    panels,
    shortcuts,
    tool: {
      activeTool: toolData.activeTool,
      brush,
      foreground: cloneColor(toolData.foreground),
      background: cloneColor(toolData.background)
    }
  };
}

// ---------------------------------------------------------------- guides & grid (project data)

/** Append a guide line to the project. Orientation must be valid and the position finite. */
export function addGuide(project: ImageProject, orientation: GuideOrientation, position: number): GuideLine {
  if (!GUIDE_ORIENTATIONS.includes(orientation)) {
    throw new Error(`Unknown guide orientation: ${orientation}`);
  }
  if (typeof position !== 'number' || !Number.isFinite(position)) {
    throw new Error(`Guide position is not finite: ${position}`);
  }
  const guide: GuideLine = { orientation, position };
  project.guides.push(guide);
  return guide;
}

function requireGuide(project: ImageProject, index: number): GuideLine {
  if (!Number.isInteger(index) || index < 0 || index >= project.guides.length) {
    throw new Error(`Guide index out of range: ${index}`);
  }
  return project.guides[index];
}

/** Move the guide at `index` to a new position (finite). */
export function moveGuide(project: ImageProject, index: number, position: number): GuideLine {
  if (typeof position !== 'number' || !Number.isFinite(position)) {
    throw new Error(`Guide position is not finite: ${position}`);
  }
  const guide = requireGuide(project, index);
  guide.position = position;
  return guide;
}

/** Remove and return the guide at `index`. */
export function removeGuide(project: ImageProject, index: number): GuideLine {
  requireGuide(project, index);
  return project.guides.splice(index, 1)[0];
}

/** Remove every guide from the project. */
export function clearGuides(project: ImageProject): void {
  project.guides = [];
}

/** Validate grid settings: spacings finite and > 0, offsets finite. */
export function assertGridSettings(grid: GridSettings): void {
  if (
    !grid ||
    !Number.isFinite(grid.spacingX) || grid.spacingX <= 0 ||
    !Number.isFinite(grid.spacingY) || grid.spacingY <= 0 ||
    !Number.isFinite(grid.offsetX) || !Number.isFinite(grid.offsetY)
  ) {
    throw new Error(`Grid settings out of range: ${JSON.stringify(grid)}`);
  }
}

/** Replace the project's grid settings (validated, stored as a copy). */
export function setGridSettings(project: ImageProject, grid: GridSettings): GridSettings {
  assertGridSettings(grid);
  project.grid = { ...grid };
  return project.grid;
}

// ---------------------------------------------------------------- snapping

export const DEFAULT_SNAP_THRESHOLD = 8;

export interface SnapOptions {
  /** Maximum distance (image pixels) at which a candidate still snaps. Default DEFAULT_SNAP_THRESHOLD. Inclusive. */
  threshold?: number;
  /** Snap to guide lines. Default true. */
  guides?: boolean;
  /** Snap to the grid. Default true. */
  grid?: boolean;
  /** Snap to canvas edges and center. Default true. */
  canvas?: boolean;
}

export type SnapSource = 'guide' | 'canvas' | 'grid';

export interface SnapAxisResult {
  /** The resulting coordinate (the target when snapped, the input otherwise). */
  value: number;
  snapped: boolean;
  /** Which candidate family supplied the target, or null when nothing snapped. */
  source: SnapSource | null;
  /** The coordinate snapped to, or null when nothing snapped. */
  target: number | null;
}

export interface SnapPointResult {
  point: Point;
  x: SnapAxisResult;
  y: SnapAxisResult;
}

type SnapProject = Pick<ImageProject, 'width' | 'height' | 'guides' | 'grid'>;

/**
 * Snap one coordinate along an axis ('x' uses vertical guides and the
 * grid's X settings; 'y' uses horizontal guides and the grid's Y
 * settings). Candidates: the guide positions on that axis, the canvas
 * edges and center (0, size/2, size), and the nearest grid line. The
 * closest candidate within the threshold wins; on an exact distance
 * tie the priority is guide, then canvas, then grid.
 */
export function snapCoordinate(value: number, axis: 'x' | 'y', project: SnapProject, options: SnapOptions = {}): SnapAxisResult {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Snap value is not finite: ${value}`);
  }
  const threshold = options.threshold ?? DEFAULT_SNAP_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error(`Snap threshold out of range: ${threshold}`);
  }
  const size = axis === 'x' ? project.width : project.height;
  const orientation: GuideOrientation = axis === 'x' ? 'vertical' : 'horizontal';
  const spacing = axis === 'x' ? project.grid.spacingX : project.grid.spacingY;
  const offset = axis === 'x' ? project.grid.offsetX : project.grid.offsetY;

  // Candidates are considered in tie-priority order (guide, canvas,
  // grid); a later candidate only replaces the best when it is
  // STRICTLY closer, so equal distances keep the higher priority.
  let best: { target: number; source: SnapSource; distance: number } | null = null;
  const consider = (target: number, source: SnapSource): void => {
    const distance = Math.abs(target - value);
    if (distance > threshold) return;
    if (!best || distance < best.distance) best = { target, source, distance };
  };

  if (options.guides !== false) {
    for (const guide of project.guides) {
      if (guide.orientation === orientation) consider(guide.position, 'guide');
    }
  }
  if (options.canvas !== false) {
    consider(0, 'canvas');
    consider(size / 2, 'canvas');
    consider(size, 'canvas');
  }
  if (options.grid !== false) {
    consider(offset + Math.round((value - offset) / spacing) * spacing, 'grid');
  }

  if (!best) return { value, snapped: false, source: null, target: null };
  const winner: { target: number; source: SnapSource; distance: number } = best;
  return { value: winner.target, snapped: true, source: winner.source, target: winner.target };
}

/** Snap a point on both axes at once; the per-axis results report what happened on each. */
export function snapPoint(point: Point, project: SnapProject, options: SnapOptions = {}): SnapPointResult {
  const x = snapCoordinate(point.x, 'x', project, options);
  const y = snapCoordinate(point.y, 'y', project, options);
  return { point: { x: x.value, y: y.value }, x, y };
}
