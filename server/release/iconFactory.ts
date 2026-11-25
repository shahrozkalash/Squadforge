import { createPixelImage, setPixel, encodePng, drawTextBitmap } from '../imageEditor/index.js';

/**
 * Phase 23: application icons. Generates a genuine Windows .ico
 * (PNG-compressed entry, the Vista+ form Windows accepts) rendered
 * from the app's initial with the Phase 19 pixel engine, and
 * validates ICO files structurally before they are packaged.
 */

export interface IcoValidation {
  valid: boolean;
  imageCount: number;
  sizes: number[];
  error?: string;
}

export function generateIconIco(appName: string, size: number = 64): Buffer {
  const img = createPixelImage(size, size, { r: 37, g: 99, b: 235, a: 255 });
  const letter = (appName.trim()[0] ?? 'A').toUpperCase();
  const scaleFactor = Math.max(2, Math.floor(size / 16));
  const white = { r: 255, g: 255, b: 255, a: 255 };
  drawTextBitmap(
    (x, y) => setPixel(img, x, y, white),
    { x: Math.floor(size / 2) - 3 * scaleFactor, y: Math.floor(size / 2) - 4 * scaleFactor },
    letter,
    scaleFactor
  );
  const png = encodePng(img);
  return wrapPngAsIco(png, size);
}

export function wrapPngAsIco(png: Buffer, size: number): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
  entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
  entry.writeUInt8(0, 2); // palette colors
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8); // image size
  entry.writeUInt32LE(6 + 16, 12); // image offset
  return Buffer.concat([header, entry, png]);
}

export function validateIco(buffer: Buffer): IcoValidation {
  if (buffer.length < 6) return { valid: false, imageCount: 0, sizes: [], error: 'File too small for an ICO header' };
  const reserved = buffer.readUInt16LE(0);
  const type = buffer.readUInt16LE(2);
  const count = buffer.readUInt16LE(4);
  if (reserved !== 0 || (type !== 1 && type !== 2) || count < 1) {
    return { valid: false, imageCount: 0, sizes: [], error: 'Bad ICO header (reserved/type/count)' };
  }
  if (buffer.length < 6 + count * 16) return { valid: false, imageCount: count, sizes: [], error: 'Truncated ICO directory' };
  const sizes: number[] = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    const widthByte = buffer.readUInt8(off);
    const sizeBytes = buffer.readUInt32LE(off + 8);
    const imageOffset = buffer.readUInt32LE(off + 12);
    if (imageOffset + sizeBytes > buffer.length) {
      return { valid: false, imageCount: count, sizes, error: `ICO image ${i} extends past the file` };
    }
    sizes.push(widthByte === 0 ? 256 : widthByte);
  }
  return { valid: true, imageCount: count, sizes };
}
