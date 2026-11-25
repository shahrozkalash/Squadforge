/**
 * Phase 19: Image Editing Engine — shared types.
 *
 * The engine works on real RGBA pixel buffers. A project is a stack of
 * layers (index 0 = bottom). All operations mutate or produce genuine
 * pixel data — there is no simulated rendering anywhere in this module.
 */

export interface PixelImage {
  width: number;
  height: number;
  /** RGBA, row-major, length = width * height * 4 */
  data: Uint8ClampedArray;
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  /** 0..1 */
  opacity: number;
  image: PixelImage;
}

export interface ImageProject {
  width: number;
  height: number;
  layers: Layer[];
  activeLayerId: string | null;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type ImageTool = 'brush' | 'eraser' | 'rectangle' | 'ellipse' | 'line' | 'text' | 'fill';

export interface Viewport {
  /** Pixels of screen per image pixel. */
  zoom: number;
  /** Screen-space offset of the image origin. */
  panX: number;
  panY: number;
}

export interface SerializedLayer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  /** base64 of the raw RGBA bytes */
  pixelsBase64: string;
}

export interface SerializedProject {
  format: 'squadforge-image-project';
  version: 1;
  width: number;
  height: number;
  activeLayerId: string | null;
  layers: SerializedLayer[];
}
