import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  createProject,
  addLayer,
  removeLayer,
  moveLayer,
  setLayerVisibility,
  setLayerOpacity,
  composite,
  getPixel,
  brushStroke,
  eraserStroke,
  fillRect,
  drawEllipse,
  drawText,
  cropProject,
  resizeProject,
  rotateProject,
  adjustBrightnessContrast,
  adjustSaturation,
  invert,
  HistoryStack,
  serializeProject,
  deserializeProject,
  screenToImage,
  imageToScreen,
  zoomAt,
  panBy
} from '../server/imageEditor/imageCore.js';
import { encodePng, decodePng, encodeBmp, decodeBmp, importImage, exportImage, detectFormat } from '../server/imageEditor/imageCodec.js';
import { ImageProjectGenerator } from '../server/imageEditor/imageProjectGenerator.js';

const RED = { r: 255, g: 0, b: 0, a: 255 };
const BLUE = { r: 0, g: 0, b: 255, a: 255 };
const WHITE = { r: 255, g: 255, b: 255, a: 255 };

describe('SquadForge Phase 19: Image Editing Engine Test Suite', () => {
  describe('1. Layers & Compositing', () => {
    test('1.1 Composite respects stack order (top layer wins when opaque)', () => {
      const p = createProject(4, 4, RED);
      const top = addLayer(p, 'top');
      fillRect(p, top.id, { x: 0, y: 0, width: 4, height: 4 }, BLUE);
      const flat = composite(p);
      assert.deepEqual(getPixel(flat, 2, 2), BLUE);
    });

    test('1.2 Hidden layers are excluded from the composite', () => {
      const p = createProject(4, 4, RED);
      const top = addLayer(p);
      fillRect(p, top.id, { x: 0, y: 0, width: 4, height: 4 }, BLUE);
      setLayerVisibility(p, top.id, false);
      assert.deepEqual(getPixel(composite(p), 1, 1), RED);
    });

    test('1.3 Opacity blends mathematically (50% blue over red = purple)', () => {
      const p = createProject(2, 2, RED);
      const top = addLayer(p);
      fillRect(p, top.id, { x: 0, y: 0, width: 2, height: 2 }, BLUE);
      setLayerOpacity(p, top.id, 0.5);
      const px = getPixel(composite(p), 0, 0);
      assert.equal(px.a, 255);
      assert.ok(Math.abs(px.r - 128) <= 1 && Math.abs(px.b - 127) <= 1, `expected ~purple, got ${JSON.stringify(px)}`);
    });

    test('1.4 Reordering layers changes the composite; last layer cannot be removed', () => {
      const p = createProject(2, 2, RED);
      const top = addLayer(p);
      fillRect(p, top.id, { x: 0, y: 0, width: 2, height: 2 }, BLUE);
      moveLayer(p, top.id, 0); // blue goes to the bottom
      assert.deepEqual(getPixel(composite(p), 0, 0), RED);
      removeLayer(p, top.id);
      assert.equal(p.layers.length, 1);
      assert.throws(() => removeLayer(p, p.layers[0].id), /last layer/);
    });

    test('1.5 Invalid opacity and missing layers are rejected', () => {
      const p = createProject(2, 2);
      assert.throws(() => setLayerOpacity(p, p.layers[0].id, 1.5), /out of range/);
      assert.throws(() => setLayerVisibility(p, 'nope', true), /not found/);
    });
  });

  describe('2. Tools', () => {
    test('2.1 Brush paints real pixels along the stroke, interpolated', () => {
      const p = createProject(20, 20);
      const layer = p.layers[0];
      brushStroke(p, layer.id, [{ x: 2, y: 10 }, { x: 17, y: 10 }], 1, RED);
      assert.deepEqual(getPixel(layer.image, 2, 10), RED);
      assert.deepEqual(getPixel(layer.image, 10, 10), RED); // midpoint proves interpolation
      assert.deepEqual(getPixel(layer.image, 17, 10), RED);
      assert.equal(getPixel(layer.image, 10, 2).a, 0); // untouched stays transparent
    });

    test('2.2 Eraser removes alpha instead of painting a color', () => {
      const p = createProject(10, 10, WHITE);
      const layer = p.layers[0];
      eraserStroke(p, layer.id, [{ x: 5, y: 5 }], 2);
      assert.equal(getPixel(layer.image, 5, 5).a, 0);
      assert.equal(getPixel(layer.image, 0, 0).a, 255);
    });

    test('2.3 Selection scopes tool effects', () => {
      const p = createProject(10, 10);
      const layer = p.layers[0];
      const sel = { x: 0, y: 0, width: 5, height: 10 };
      brushStroke(p, layer.id, [{ x: 2, y: 5 }, { x: 8, y: 5 }], 1, RED, sel);
      assert.deepEqual(getPixel(layer.image, 2, 5), RED);
      assert.equal(getPixel(layer.image, 8, 5).a, 0); // outside selection untouched
    });

    test('2.4 Ellipse shape fills its interior only', () => {
      const p = createProject(20, 20);
      const layer = p.layers[0];
      drawEllipse(p, layer.id, { x: 2, y: 2, width: 16, height: 16 }, BLUE);
      assert.deepEqual(getPixel(layer.image, 10, 10), BLUE);
      assert.equal(getPixel(layer.image, 2, 2).a, 0); // corner outside ellipse
    });

    test('2.5 Text rasterizes real glyph pixels', () => {
      const p = createProject(40, 12);
      const layer = p.layers[0];
      drawText(p, layer.id, { x: 1, y: 1 }, 'A', 1, RED);
      // 'A' top row is .XXX. -> pixels at (2..4, 1) painted, (1,1) not
      assert.deepEqual(getPixel(layer.image, 3, 1), RED);
      assert.equal(getPixel(layer.image, 1, 1).a, 0);
    });
  });

  describe('3. Transforms & Adjustments', () => {
    test('3.1 Crop shrinks the project and keeps the right pixels', () => {
      const p = createProject(10, 10, RED);
      const top = addLayer(p);
      fillRect(p, top.id, { x: 5, y: 5, width: 5, height: 5 }, BLUE);
      cropProject(p, { x: 5, y: 5, width: 5, height: 5 });
      assert.equal(p.width, 5);
      assert.deepEqual(getPixel(composite(p), 0, 0), BLUE);
      assert.throws(() => cropProject(p, { x: 4, y: 0, width: 5, height: 5 }), /inside/);
    });

    test('3.2 Resize resamples to the new dimensions', () => {
      const p = createProject(10, 10, RED);
      resizeProject(p, 5, 20);
      assert.equal(p.width, 5);
      assert.equal(p.height, 20);
      assert.deepEqual(getPixel(composite(p), 4, 19), RED);
    });

    test('3.3 Rotate 90 swaps dimensions and moves pixels exactly', () => {
      const p = createProject(4, 2, RED);
      const layer = p.layers[0];
      fillRect(p, layer.id, { x: 0, y: 0, width: 1, height: 1 }, BLUE);
      // paint marker at (0,0) on the base via brush on base layer
      brushStroke(p, layer.id, [{ x: 3, y: 0 }], 0.5, BLUE);
      rotateProject(p, 90);
      assert.equal(p.width, 2);
      assert.equal(p.height, 4);
      // (3,0) rotated 90 CW -> (height-1-0, 3) = (1,3)
      assert.deepEqual(getPixel(layer.image, 1, 3), BLUE);
    });

    test('3.4 Brightness and invert produce exact values', () => {
      const p = createProject(2, 2, { r: 100, g: 100, b: 100, a: 255 });
      const layer = p.layers[0];
      adjustBrightnessContrast(p, layer.id, 50, 0);
      assert.deepEqual(getPixel(layer.image, 0, 0), { r: 150, g: 150, b: 150, a: 255 });
      invert(p, layer.id);
      assert.deepEqual(getPixel(layer.image, 0, 0), { r: 105, g: 105, b: 105, a: 255 });
    });

    test('3.5 Saturation -1 yields true grayscale', () => {
      const p = createProject(2, 2, { r: 200, g: 100, b: 0, a: 255 });
      adjustSaturation(p, p.layers[0].id, -1);
      const px = getPixel(p.layers[0].image, 0, 0);
      assert.equal(px.r, px.g);
      assert.equal(px.g, px.b);
      assert.ok(Math.abs(px.r - 118) <= 1); // 0.299*200 + 0.587*100 = 118.5
    });
  });

  describe('4. Undo/Redo & Persistence', () => {
    test('4.1 Undo restores the pre-edit state; redo reapplies it', () => {
      const p = createProject(6, 6, WHITE);
      const history = new HistoryStack();
      history.commit(p);
      brushStroke(p, p.layers[0].id, [{ x: 3, y: 3 }], 1, RED);
      assert.deepEqual(getPixel(p.layers[0].image, 3, 3), RED);
      assert.equal(history.undo(p), true);
      assert.deepEqual(getPixel(p.layers[0].image, 3, 3), WHITE);
      assert.equal(history.redo(p), true);
      assert.deepEqual(getPixel(p.layers[0].image, 3, 3), RED);
      assert.equal(history.undo(p), true);
      assert.equal(history.undo(p), false); // stack exhausted honestly
    });

    test('4.2 Project serialize/deserialize round-trips pixels and layer state', () => {
      const p = createProject(8, 8, RED);
      const top = addLayer(p, 'paint');
      brushStroke(p, top.id, [{ x: 4, y: 4 }], 1, BLUE);
      setLayerOpacity(p, top.id, 0.75);
      const restored = deserializeProject(JSON.parse(JSON.stringify(serializeProject(p))));
      assert.equal(restored.layers.length, 2);
      assert.equal(restored.layers[1].opacity, 0.75);
      assert.deepEqual(getPixel(restored.layers[1].image, 4, 4), BLUE);
      assert.deepEqual(getPixel(composite(restored), 0, 0), RED);
    });

    test('4.3 Corrupt project data is rejected, not silently loaded', () => {
      assert.throws(() => deserializeProject({ format: 'nope' } as any), /format\/version/);
      const p = createProject(4, 4);
      const bad = serializeProject(p);
      bad.layers[0].pixelsBase64 = Buffer.from([1, 2, 3]).toString('base64');
      assert.throws(() => deserializeProject(bad), /size mismatch/);
    });
  });

  describe('5. Import/Export Codecs', () => {
    test('5.1 PNG export produces a real PNG that decodes to identical pixels', () => {
      const p = createProject(6, 4, RED);
      brushStroke(p, p.layers[0].id, [{ x: 1, y: 1 }], 1, BLUE);
      const flat = composite(p);
      const png = exportImage(flat, 'png');
      assert.equal(detectFormat(png), 'png');
      assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
      const decoded = decodePng(png);
      assert.equal(decoded.width, 6);
      assert.deepEqual(getPixel(decoded, 1, 1), BLUE);
      assert.deepEqual(getPixel(decoded, 5, 3), RED);
      assert.ok(Buffer.from(decoded.data).equals(Buffer.from(flat.data)));
    });

    test('5.2 BMP round-trips pixels (24-bit, alpha becomes opaque)', () => {
      const p = createProject(5, 3, { r: 10, g: 20, b: 30, a: 255 });
      const bmp = exportImage(composite(p), 'bmp');
      assert.equal(detectFormat(bmp), 'bmp');
      const decoded = decodeBmp(bmp);
      assert.deepEqual(getPixel(decoded, 4, 2), { r: 10, g: 20, b: 30, a: 255 });
    });

    test('5.3 Import dispatches by real signature and rejects garbage', () => {
      const p = createProject(3, 3, RED);
      const png = encodePng(composite(p));
      assert.deepEqual(getPixel(importImage(png), 0, 0), RED);
      assert.throws(() => importImage(Buffer.from('definitely not an image')), /Unsupported image format/);
      assert.throws(() => decodePng(Buffer.from('definitely not an image')), /bad signature/);
    });
  });

  describe('6. Viewport (zoom/pan) Math', () => {
    test('6.1 Screen/image conversions are inverse', () => {
      const vp = { zoom: 2, panX: 10, panY: 20 };
      const img = screenToImage(vp, 110, 220);
      assert.deepEqual(img, { x: 50, y: 100 });
      assert.deepEqual(imageToScreen(vp, img.x, img.y), { x: 110, y: 220 });
    });

    test('6.2 Zoom anchors the image point under the cursor; pan shifts origin', () => {
      const vp = { zoom: 1, panX: 0, panY: 0 };
      const zoomed = zoomAt(vp, { x: 100, y: 100 }, 2);
      assert.equal(zoomed.zoom, 2);
      assert.deepEqual(screenToImage(zoomed, 100, 100), { x: 100, y: 100 });
      const panned = panBy(zoomed, 5, -3);
      assert.equal(panned.panX, zoomed.panX + 5);
      assert.equal(panned.panY, zoomed.panY - 3);
    });
  });

  describe('7. Generated Application Source', () => {
    test('7.1 Generator emits a complete image-editor app on the desktop stack', () => {
      const config = ImageProjectGenerator.getDefaultConfig('PixelForge');
      const files = ImageProjectGenerator.generateProjectFiles(config);
      for (const expected of [
        'PixelForge.sln',
        'src/PixelForge/PixelForge.csproj',
        'src/PixelForge/Program.cs',
        'src/PixelForge/MainForm.cs',
        'src/PixelForge/EditorCanvas.cs',
        'src/PixelForge/ImageDocument.cs'
      ]) {
        assert.ok(files[expected], `missing ${expected}`);
      }
      const doc = files['src/PixelForge/ImageDocument.cs'];
      assert.match(doc, /public Bitmap Flatten\(\)/);
      assert.match(doc, /SaveProject/);
      assert.match(doc, /LoadProject/);
      const canvas = files['src/PixelForge/EditorCanvas.cs'];
      assert.match(canvas, /OnMouseWheel/); // zoom
      assert.match(canvas, /EditorTool\.Eraser/);
      assert.match(canvas, /CompositingMode\.SourceCopy/); // true alpha erase
      const form = files['src/PixelForge/MainForm.cs'];
      assert.match(form, /Undo\(\)/);
      assert.match(form, /ExportImage\(ImageFormat\.Jpeg\)/);
    });
  });
});
