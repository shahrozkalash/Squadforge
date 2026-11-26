import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBrushSettings,
  createProject,
  deserializeProject,
  serializeProject
} from '../server/imageEditor/imageCore.js';
import {
  DEFAULT_SNAP_THRESHOLD,
  EDITOR_COMMANDS,
  EDITOR_COMMAND_IDS,
  addGuide,
  clearGuides,
  createDefaultShortcuts,
  createDefaultToolState,
  createDefaultWorkspace,
  createFocusWorkspace,
  deserializeShortcuts,
  deserializeWorkspace,
  formatKeyChord,
  getPanelLayout,
  getWorkspacePreset,
  listWorkspacePresets,
  moveGuide,
  movePanel,
  parseKeyChord,
  removeGuide,
  resetColors,
  resolveShortcut,
  serializeShortcuts,
  serializeWorkspace,
  setActiveTool,
  setBrushSettings,
  setForegroundColor,
  setGridSettings,
  setPanelVisible,
  setPanelWeight,
  setShortcut,
  snapCoordinate,
  snapPoint,
  swapColors
} from '../server/imageEditor/workspace.js';
import { ImageProjectGenerator } from '../server/imageEditor/imageProjectGenerator.js';

// Phase 54 — Professional Workspace and Usability.
// The workspace layer is data + pure logic in the TS engine (panels,
// shortcuts, tool state, guides/grid/snapping); the generated C#
// shell receives the same data from the generator. Keyboard-only
// operation is the testable accessibility claim: every documented
// command has a default binding (asserted below). Visual
// accessibility is not verified anywhere and is not claimed.

describe('54.1 workspace panel layouts and presets', () => {
  test('default preset has the six real panels with exact docks, visibility and weights', () => {
    const ws = createDefaultWorkspace();
    assert.deepEqual(
      ws.panels.map((p) => [p.id, p.dock, p.visible, p.weight]),
      [
        ['tools', 'left', true, 1],
        ['layers', 'right', true, 3],
        ['colors', 'right', true, 2],
        ['filters', 'left', true, 2],
        ['history', 'right', true, 2],
        ['properties', 'right', true, 2]
      ]
    );
  });

  test('focus preset hides the secondary panels and keeps tools/layers/colors', () => {
    const ws = createFocusWorkspace();
    const vis = Object.fromEntries(ws.panels.map((p) => [p.id, p.visible]));
    assert.deepEqual(vis, {
      tools: true,
      layers: true,
      colors: true,
      filters: false,
      history: false,
      properties: false
    });
    // Docks and weights are unchanged from the default preset.
    for (const p of ws.panels) {
      const d = getPanelLayout(createDefaultWorkspace(), p.id);
      assert.equal(p.dock, d.dock);
      assert.equal(p.weight, d.weight);
    }
  });

  test('presets are listed, named, and independent copies', () => {
    assert.deepEqual(listWorkspacePresets(), ['default', 'focus']);
    const a = getWorkspacePreset('default');
    setPanelWeight(a, 'layers', 9);
    setPanelVisible(a, 'tools', false);
    const fresh = getWorkspacePreset('default');
    assert.equal(getPanelLayout(fresh, 'layers').weight, 3);
    assert.equal(getPanelLayout(fresh, 'tools').visible, true);
    assert.throws(() => getWorkspacePreset('minimal'), /Unknown workspace preset/);
  });

  test('layout operations mutate validated state', () => {
    const ws = createDefaultWorkspace();
    setPanelVisible(ws, 'filters', false);
    assert.equal(getPanelLayout(ws, 'filters').visible, false);
    movePanel(ws, 'layers', 'left');
    assert.equal(getPanelLayout(ws, 'layers').dock, 'left');
    setPanelWeight(ws, 'layers', 4.5);
    assert.equal(getPanelLayout(ws, 'layers').weight, 4.5);
  });

  test('layout operations reject unknown panels, docks and bad weights', () => {
    const ws = createDefaultWorkspace();
    assert.throws(() => setPanelVisible(ws, 'nope' as never, true), /Unknown workspace panel/);
    assert.throws(() => movePanel(ws, 'tools', 'floating' as never), /Unknown panel dock/);
    assert.throws(() => setPanelWeight(ws, 'tools', 0), /weight/);
    assert.throws(() => setPanelWeight(ws, 'tools', -2), /weight/);
    assert.throws(() => setPanelWeight(ws, 'tools', Number.NaN), /weight/);
    assert.throws(() => getPanelLayout(ws, 'nope' as never), /Unknown workspace panel/);
  });
});

describe('54.2 keyboard shortcuts', () => {
  test('every documented command has exactly one default binding (keyboard-only coverage)', () => {
    const map = createDefaultShortcuts();
    assert.equal(EDITOR_COMMANDS.length, 21);
    assert.deepEqual(Object.keys(map).sort(), [...EDITOR_COMMAND_IDS].sort());
    // No two commands share a chord in the default map.
    const chords = Object.values(map).map(formatKeyChord);
    assert.equal(new Set(chords).size, chords.length);
  });

  test('default bindings are the documented chords', () => {
    const map = createDefaultShortcuts();
    const text = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, formatKeyChord(v)]));
    assert.equal(text['edit.undo'], 'Ctrl+Z');
    assert.equal(text['edit.redo'], 'Ctrl+Shift+Z');
    assert.equal(text['file.save'], 'Ctrl+S');
    assert.equal(text['file.exportPng'], 'Ctrl+Shift+E');
    assert.equal(text['tool.brush'], 'B');
    assert.equal(text['layer.delete'], 'Delete');
    assert.equal(text['layer.moveUp'], 'Ctrl+]');
    assert.equal(text['view.zoomIn'], 'Ctrl+=');
  });

  test('resolution is modifier-exact', () => {
    const map = createDefaultShortcuts();
    assert.equal(resolveShortcut(map, { key: 'z', ctrl: true }), 'edit.undo');
    assert.equal(resolveShortcut(map, { key: 'Z', ctrl: true, shift: true }), 'edit.redo');
    // Ctrl+Shift+Z must NOT fire the Ctrl+Z binding, and plain Z fires nothing.
    assert.notEqual(resolveShortcut(map, { key: 'z', ctrl: true, shift: true }), 'edit.undo');
    assert.equal(resolveShortcut(map, { key: 'z' }), null);
    // A plain-letter tool binding must not fire with an extra modifier.
    assert.equal(resolveShortcut(map, { key: 'b' }), 'tool.brush');
    assert.equal(resolveShortcut(map, { key: 'B' }), 'tool.brush');
    assert.equal(resolveShortcut(map, { key: 'b', ctrl: true }), null);
    assert.equal(resolveShortcut(map, { key: 'Delete' }), 'layer.delete');
    assert.equal(resolveShortcut(map, { key: 'F5' }), null);
    // Un-canonicalizable event keys resolve to null, never throw.
    assert.equal(resolveShortcut(map, { key: 'Unidentified' }), null);
  });

  test('chord parse/format round-trips, including the + key and named keys', () => {
    assert.equal(formatKeyChord(parseKeyChord('Ctrl+Shift+Z')), 'Ctrl+Shift+Z');
    assert.deepEqual(parseKeyChord('ctrl+z'), { key: 'Z', ctrl: true, shift: false, alt: false });
    assert.equal(parseKeyChord('Ctrl++').key, '+');
    assert.equal(formatKeyChord(parseKeyChord('delete')), 'Delete');
    assert.throws(() => parseKeyChord('Meta+Z'), /modifier/);
    assert.throws(() => parseKeyChord('Ctrl+'), /[Kk]ey/);
  });

  test('rebinding rejects conflicts naming the holder; rebinding the owner works', () => {
    const map = createDefaultShortcuts();
    assert.throws(() => setShortcut(map, 'file.save', { key: 'z', ctrl: true }), /conflict.*edit\.undo/);
    // Re-assigning a command its own chord is a no-op, not a conflict.
    setShortcut(map, 'edit.undo', { key: 'Z', ctrl: true });
    assert.equal(resolveShortcut(map, { key: 'z', ctrl: true }), 'edit.undo');
    // Move undo to Ctrl+Y: the old chord frees up, the new one resolves.
    setShortcut(map, 'edit.undo', { key: 'y', ctrl: true });
    assert.equal(resolveShortcut(map, { key: 'z', ctrl: true }), null);
    assert.equal(resolveShortcut(map, { key: 'y', ctrl: true }), 'edit.undo');
    assert.throws(() => setShortcut(map, 'nope.command', { key: 'q' }), /Unknown editor command/);
  });

  test('shortcut maps serialize field-exactly and reject corrupt data', () => {
    const map = createDefaultShortcuts();
    setShortcut(map, 'edit.undo', { key: 'y', ctrl: true });
    const back = deserializeShortcuts(serializeShortcuts(map));
    assert.deepEqual(back, map);
    assert.throws(
      () => deserializeShortcuts({ 'bogus.command': { key: 'Q', ctrl: false, shift: false, alt: false } }),
      /Unknown editor command/
    );
    assert.throws(
      () =>
        deserializeShortcuts({
          'edit.undo': { key: 'Z', ctrl: true, shift: false, alt: false },
          'file.save': { key: 'Z', ctrl: true, shift: false, alt: false }
        }),
      /conflict/
    );
    assert.throws(
      () => deserializeShortcuts({ 'edit.undo': { key: 'Not A Key!', ctrl: true, shift: false, alt: false } }),
      /key/
    );
  });
});

describe('54.3 tool settings and color panel state', () => {
  test('defaults: brush tool, Phase 46 default brush settings, black on white', () => {
    const state = createDefaultToolState();
    assert.equal(state.activeTool, 'brush');
    assert.deepEqual(state.brush, createBrushSettings());
    assert.deepEqual(state.foreground, { r: 0, g: 0, b: 0, a: 255 });
    assert.deepEqual(state.background, { r: 255, g: 255, b: 255, a: 255 });
  });

  test('active tool is validated against the engine tool set', () => {
    const state = createDefaultToolState();
    setActiveTool(state, 'fill');
    assert.equal(state.activeTool, 'fill');
    assert.throws(() => setActiveTool(state, 'spray' as never), /tool/);
  });

  test('brush settings go through the Phase 46 validators', () => {
    const state = createDefaultToolState();
    setBrushSettings(state, { size: 30, opacity: 0.5 });
    assert.equal(state.brush.size, 30);
    assert.equal(state.brush.opacity, 0.5);
    assert.equal(state.brush.hardness, createBrushSettings().hardness);
    assert.throws(() => setBrushSettings(state, { size: -1 }), /size/);
    assert.throws(() => setBrushSettings(state, { opacity: 2 }), /opacity/);
  });

  test('colors are validated engine colors; swap and reset work', () => {
    const state = createDefaultToolState();
    setForegroundColor(state, { r: 10, g: 20, b: 30, a: 255 });
    assert.deepEqual(state.foreground, { r: 10, g: 20, b: 30, a: 255 });
    assert.throws(() => setForegroundColor(state, { r: 256, g: 0, b: 0, a: 255 }), /Foreground color/);
    assert.throws(() => setForegroundColor(state, { r: Number.NaN, g: 0, b: 0, a: 255 }), /Foreground color/);
    swapColors(state);
    assert.deepEqual(state.foreground, { r: 255, g: 255, b: 255, a: 255 });
    assert.deepEqual(state.background, { r: 10, g: 20, b: 30, a: 255 });
    resetColors(state);
    assert.deepEqual(state.foreground, { r: 0, g: 0, b: 0, a: 255 });
    assert.deepEqual(state.background, { r: 255, g: 255, b: 255, a: 255 });
  });
});

describe('54.4 workspace serialization', () => {
  test('a customized workspace round-trips field-exactly', () => {
    const ws = createDefaultWorkspace();
    setPanelVisible(ws, 'filters', false);
    movePanel(ws, 'layers', 'left');
    setPanelWeight(ws, 'colors', 5);
    setShortcut(ws.shortcuts, 'edit.undo', { key: 'y', ctrl: true });
    setActiveTool(ws.tool, 'text');
    setBrushSettings(ws.tool, { size: 30 });
    setForegroundColor(ws.tool, { r: 1, g: 2, b: 3, a: 200 });
    const data = serializeWorkspace(ws);
    const back = deserializeWorkspace(data);
    assert.deepEqual(back, ws);
    assert.equal(JSON.stringify(serializeWorkspace(back)), JSON.stringify(data));
  });

  test('corrupt workspace data is rejected form by form', () => {
    const good = serializeWorkspace(createDefaultWorkspace());
    const clone = () => JSON.parse(JSON.stringify(good)) as typeof good;

    const badFormat = clone();
    (badFormat as { format: string }).format = 'something-else';
    assert.throws(() => deserializeWorkspace(badFormat), /format/);

    const unknownPanel = clone();
    (unknownPanel.panels[0] as { id: string }).id = 'nope';
    assert.throws(() => deserializeWorkspace(unknownPanel), /panel/);

    const dupPanel = clone();
    (dupPanel.panels[1] as { id: string }).id = 'tools';
    assert.throws(() => deserializeWorkspace(dupPanel), /[Dd]uplicate/);

    const missingPanel = clone();
    missingPanel.panels = missingPanel.panels.slice(0, 5);
    assert.throws(() => deserializeWorkspace(missingPanel), /panel/);

    const badDock = clone();
    (badDock.panels[0] as { dock: string }).dock = 'floating';
    assert.throws(() => deserializeWorkspace(badDock), /dock/);

    const badWeight = clone();
    (badWeight.panels[0] as { weight: number }).weight = -2;
    assert.throws(() => deserializeWorkspace(badWeight), /weight/);

    const badShortcutCommand = clone();
    (badShortcutCommand.shortcuts as Record<string, unknown>)['bogus.command'] = {
      key: 'Q',
      ctrl: false,
      shift: false,
      alt: false
    };
    assert.throws(() => deserializeWorkspace(badShortcutCommand), /command/);

    const badColor = clone();
    (badColor.tool.foreground as { r: number }).r = 300;
    assert.throws(() => deserializeWorkspace(badColor), /color/);

    const badTool = clone();
    (badTool.tool as { activeTool: string }).activeTool = 'spray';
    assert.throws(() => deserializeWorkspace(badTool), /tool/);

    const badBrush = clone();
    (badBrush.tool.brush as { size: number }).size = -5;
    assert.throws(() => deserializeWorkspace(badBrush), /size/);
  });
});

describe('54.5 guides, grid and project persistence', () => {
  test('guides add/move/remove/clear with validation', () => {
    const p = createProject(400, 300);
    assert.deepEqual(p.guides, []);
    const g = addGuide(p, 'vertical', 100);
    assert.deepEqual(g, { orientation: 'vertical', position: 100 });
    addGuide(p, 'horizontal', 40);
    assert.equal(p.guides.length, 2);
    moveGuide(p, 0, 120);
    assert.equal(p.guides[0].position, 120);
    const removed = removeGuide(p, 1);
    assert.equal(removed.orientation, 'horizontal');
    assert.equal(p.guides.length, 1);
    assert.throws(() => addGuide(p, 'diagonal' as never, 10), /orientation/);
    assert.throws(() => addGuide(p, 'vertical', Number.NaN), /position/);
    assert.throws(() => moveGuide(p, 9, 10), /index/);
    assert.throws(() => removeGuide(p, -1), /index/);
    clearGuides(p);
    assert.deepEqual(p.guides, []);
  });

  test('grid settings are validated and stored as a copy', () => {
    const p = createProject(400, 300);
    assert.deepEqual(p.grid, { spacingX: 16, spacingY: 16, offsetX: 0, offsetY: 0 });
    const grid = { spacingX: 10, spacingY: 20, offsetX: 2, offsetY: 3 };
    setGridSettings(p, grid);
    grid.spacingX = 999;
    assert.equal(p.grid.spacingX, 10);
    assert.throws(() => setGridSettings(p, { spacingX: 0, spacingY: 8, offsetX: 0, offsetY: 0 }), /Grid settings out of range/);
    assert.throws(() => setGridSettings(p, { spacingX: 8, spacingY: 8, offsetX: Number.NaN, offsetY: 0 }), /Grid settings out of range/);
  });

  test('guides and grid persist through the v2 project format, field-exact', () => {
    const p = createProject(400, 300);
    addGuide(p, 'vertical', 100);
    addGuide(p, 'horizontal', 40);
    setGridSettings(p, { spacingX: 10, spacingY: 20, offsetX: 2, offsetY: 3 });
    const back = deserializeProject(serializeProject(p));
    assert.deepEqual(back.guides, p.guides);
    assert.deepEqual(back.grid, p.grid);
  });

  test('a pre-Phase-54 project (no guides/grid fields) loads with defaults', () => {
    const p = createProject(64, 64);
    const data = serializeProject(p) as unknown as Record<string, unknown>;
    delete data.guides;
    delete data.grid;
    const back = deserializeProject(data as never);
    assert.deepEqual(back.guides, []);
    assert.deepEqual(back.grid, { spacingX: 16, spacingY: 16, offsetX: 0, offsetY: 0 });
  });

  test('corrupt guide/grid data is rejected on load', () => {
    const p = createProject(64, 64);
    const badGuide = serializeProject(p) as unknown as Record<string, unknown>;
    badGuide.guides = [{ orientation: 'diagonal', position: 5 }];
    assert.throws(() => deserializeProject(badGuide as never), /guide/);
    const nanGuide = serializeProject(p) as unknown as Record<string, unknown>;
    nanGuide.guides = [{ orientation: 'vertical', position: Number.NaN }];
    assert.throws(() => deserializeProject(nanGuide as never), /guide/);
    const badGrid = serializeProject(p) as unknown as Record<string, unknown>;
    badGrid.grid = { spacingX: 0, spacingY: 16, offsetX: 0, offsetY: 0 };
    assert.throws(() => deserializeProject(badGrid as never), /grid/);
  });
});

describe('54.6 snapping', () => {
  test('a guide inside the threshold snaps; the threshold is inclusive', () => {
    const p = createProject(400, 300);
    addGuide(p, 'vertical', 100);
    const r = snapCoordinate(103, 'x', p);
    assert.deepEqual([r.value, r.snapped, r.source, r.target], [100, true, 'guide', 100]);
    const edge = snapCoordinate(108, 'x', p, { grid: false, canvas: false });
    assert.equal(edge.value, 100);
    const beyond = snapCoordinate(109, 'x', p, { grid: false, canvas: false });
    assert.deepEqual([beyond.value, beyond.snapped, beyond.source], [109, false, null]);
    assert.equal(DEFAULT_SNAP_THRESHOLD, 8);
  });

  test('outside every candidate, the coordinate is unchanged', () => {
    const p = createProject(400, 300);
    setGridSettings(p, { spacingX: 100, spacingY: 100, offsetX: 0, offsetY: 0 });
    addGuide(p, 'vertical', 300);
    const r = snapCoordinate(55, 'x', p);
    assert.deepEqual([r.value, r.snapped, r.source, r.target], [55, false, null, null]);
  });

  test('the nearest guide wins', () => {
    const p = createProject(400, 300);
    addGuide(p, 'vertical', 100);
    addGuide(p, 'vertical', 108);
    const r = snapCoordinate(105, 'x', p, { grid: false, canvas: false });
    assert.deepEqual([r.value, r.source], [108, 'guide']);
  });

  test('grid snapping uses spacing and offset', () => {
    const p = createProject(400, 300);
    const r = snapCoordinate(47, 'x', p, { guides: false, canvas: false });
    assert.deepEqual([r.value, r.source], [48, 'grid']);
    setGridSettings(p, { spacingX: 16, spacingY: 16, offsetX: 4, offsetY: 0 });
    const shifted = snapCoordinate(47, 'x', p, { guides: false, canvas: false });
    assert.equal(shifted.value, 52); // lines at 4, 20, 36, 52 — 52 is 5 away, 36 is 11
  });

  test('priority rule: closest wins; exact ties go guide, then canvas, then grid', () => {
    const p = createProject(400, 300);
    addGuide(p, 'vertical', 52);
    // Guide at 52 and grid line at 48 are both exactly 2 from 50: guide wins the tie.
    const tie = snapCoordinate(50, 'x', p, { canvas: false });
    assert.deepEqual([tie.value, tie.source], [52, 'guide']);
    // A strictly closer grid line beats a farther guide.
    const p2 = createProject(400, 300);
    addGuide(p2, 'vertical', 100);
    const closer = snapCoordinate(103, 'x', p2, { canvas: false, threshold: 8 });
    assert.equal(closer.source, 'guide'); // guide is 3 away, grid line 96 is 7 away
    const p3 = createProject(400, 300);
    addGuide(p3, 'vertical', 200);
    const gridCloser = snapCoordinate(103, 'x', p3, { canvas: false });
    assert.deepEqual([gridCloser.value, gridCloser.source], [96, 'grid']);
  });

  test('canvas edges and center snap', () => {
    const p = createProject(400, 300);
    const edge = snapCoordinate(3, 'x', p, { guides: false });
    assert.deepEqual([edge.value, edge.source], [0, 'canvas']);
    const center = snapCoordinate(203, 'x', p, { guides: false });
    assert.deepEqual([center.value, center.source], [200, 'canvas']);
    const farEdge = snapCoordinate(397, 'x', p, { guides: false, grid: false });
    assert.deepEqual([farEdge.value, farEdge.source], [400, 'canvas']);
  });

  test('snapPoint maps vertical guides to x and horizontal guides to y', () => {
    const p = createProject(400, 300);
    addGuide(p, 'vertical', 100);
    addGuide(p, 'horizontal', 60);
    const r = snapPoint({ x: 103, y: 57 }, p);
    assert.deepEqual(r.point, { x: 100, y: 60 });
    assert.equal(r.x.source, 'guide');
    assert.equal(r.y.source, 'guide');
  });

  test('snap inputs are validated', () => {
    const p = createProject(400, 300);
    assert.throws(() => snapCoordinate(Number.NaN, 'x', p), /finite/);
    assert.throws(() => snapCoordinate(10, 'x', p, { threshold: -1 }), /threshold/);
  });
});

describe('54.7 generated desktop app wiring', () => {
  const files = ImageProjectGenerator.generateProjectFiles(ImageProjectGenerator.getDefaultConfig());

  test('the generator emits Workspace.cs carrying the model data', () => {
    const ws = files['src/PixelForge/Workspace.cs'];
    assert.ok(ws, 'Workspace.cs is generated');
    assert.match(ws, /record PanelLayoutEntry/);
    assert.match(ws, /new\("layers", "right", true, 3\)/);
    assert.match(ws, /new\("filters", "left", false, 2\)/); // focus preset hides filters
    assert.match(ws, /class ShortcutResolver/);
    // Every default shortcut from the TS model appears in the generated data.
    const map = createDefaultShortcuts();
    for (const [id, chord] of Object.entries(map)) {
      assert.ok(ws.includes(`["${id}"] = "${formatKeyChord(chord)}"`), `shortcut ${id} emitted`);
    }
  });

  test('MainForm docks panels from the layout and dispatches keys through the resolver', () => {
    const main = files['src/PixelForge/MainForm.cs'];
    assert.match(main, /WorkspaceData\.DefaultLayout/);
    assert.match(main, /KeyPreview = true/);
    assert.match(main, /ShortcutResolver\.Resolve\(e\)/);
    assert.match(main, /DispatchCommand/);
    assert.match(main, /Swap colors/);
    // Phase 19 regression needles: the snapshot Undo and JPEG export survive the refactor.
    assert.match(main, /Undo\(\)/);
    assert.match(main, /ExportImage\(ImageFormat\.Jpeg\)/);
  });

  test('canvas and document gained the operations the shortcuts dispatch to', () => {
    assert.match(files['src/PixelForge/EditorCanvas.cs'], /public void ZoomBy\(float factor\)/);
    assert.match(files['src/PixelForge/EditorCanvas.cs'], /BackColor2/);
    assert.match(files['src/PixelForge/ImageDocument.cs'], /public void RemoveLayer\(int index\)/);
    assert.match(files['src/PixelForge/ImageDocument.cs'], /public void MoveLayer\(int index, int delta\)/);
  });
});
