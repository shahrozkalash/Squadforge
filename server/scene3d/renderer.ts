import type { PixelImage } from '../imageEditor/types.js';
import { createPixelImage, setPixel } from '../imageEditor/imageCore.js';
import {
  Vec3,
  cross,
  dot,
  mat4LookAt,
  mat4Multiply,
  mat4Perspective,
  normalize,
  orbitPosition,
  scale,
  sub,
  transformDirection,
  transformPoint,
  vec3
} from './math3d.js';
import { Scene, worldMatrix } from './scene.js';

/**
 * Phase 21: a genuine software renderer. It projects scene geometry
 * through the camera (orbit + lookAt + perspective), rasterizes
 * triangles with a z-buffer, and shades them with the scene's lights
 * (ambient + directional diffuse + point falloff). The output is a
 * real pixel buffer (Phase 19 PixelImage → PNG). It is not a mock
 * preview: occlusion, shading and silhouettes all come from the math.
 */

export interface RenderOptions {
  width: number;
  height: number;
  background: { r: number; g: number; b: number };
}

interface ScreenVert {
  x: number;
  y: number;
  z: number; // view depth (positive in front)
  nx: number;
  ny: number;
  nz: number;
  wx: number; // world position for point lights
  wy: number;
  wz: number;
}

export function renderScene(scene: Scene, options: RenderOptions): PixelImage {
  const { width, height } = options;
  const img = createPixelImage(width, height, { ...options.background, a: 255 });
  const zBuffer = new Float32Array(width * height).fill(Number.POSITIVE_INFINITY);

  const eye = orbitPosition(scene.camera.target, scene.camera.azimuthDeg, scene.camera.elevationDeg, scene.camera.distance);
  const view = mat4LookAt(eye, scene.camera.target, vec3(0, 1, 0));
  const proj = mat4Perspective(scene.camera.fovYDeg, width / height, scene.camera.near, scene.camera.far);
  const viewProj = mat4Multiply(proj, view);

  const ambient = scene.lights.filter((l) => l.kind === 'ambient');
  const directionals = scene.lights.filter((l) => l.kind === 'directional');
  const points = scene.lights.filter((l) => l.kind === 'point');

  const shade = (worldPos: Vec3, normal: Vec3, base: { r: number; g: number; b: number }): { r: number; g: number; b: number } => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const light of ambient) {
      r += light.color.r * light.intensity;
      g += light.color.g * light.intensity;
      b += light.color.b * light.intensity;
    }
    for (const light of directionals) {
      const toLight = normalize(scale(light.direction, -1));
      const diff = Math.max(0, dot(normal, toLight)) * light.intensity;
      r += light.color.r * diff;
      g += light.color.g * diff;
      b += light.color.b * diff;
    }
    for (const light of points) {
      const toLight = sub(light.position, worldPos);
      const dist = Math.max(0.0001, Math.hypot(toLight.x, toLight.y, toLight.z));
      const diff = (Math.max(0, dot(normal, normalize(toLight))) * light.intensity) / (1 + 0.15 * dist * dist);
      r += light.color.r * diff;
      g += light.color.g * diff;
      b += light.color.b * diff;
    }
    return {
      r: Math.min(255, Math.round(base.r * 255 * r)),
      g: Math.min(255, Math.round(base.g * 255 * g)),
      b: Math.min(255, Math.round(base.b * 255 * b))
    };
  };

  for (const node of scene.nodes) {
    if (!node.visible || !node.mesh || !node.material) continue;
    const mesh = node.mesh;
    const world = worldMatrix(scene, node.id);
    const verts: ScreenVert[] = [];
    let clipped = false;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const wp = transformPoint(world, vec3(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]));
      const wn = normalize(transformDirection(world, vec3(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2])));
      const clip = transformPoint(viewProj, wp);
      // transformPoint already divided by w; points behind the camera produce w<0 upstream —
      // guard via view-space depth instead:
      const viewPos = transformPoint(view, wp);
      if (viewPos.z > -scene.camera.near) clipped = true;
      verts.push({
        x: (clip.x * 0.5 + 0.5) * width,
        y: (1 - (clip.y * 0.5 + 0.5)) * height,
        z: -viewPos.z,
        nx: wn.x,
        ny: wn.y,
        nz: wn.z,
        wx: wp.x,
        wy: wp.y,
        wz: wp.z
      });
    }
    if (clipped && verts.every((v) => v.z <= 0)) continue;

    for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
      const a = verts[mesh.indices[t]];
      const b = verts[mesh.indices[t + 1]];
      const c = verts[mesh.indices[t + 2]];
      if (a.z <= 0 || b.z <= 0 || c.z <= 0) continue;
      // Backface culling in screen space. With the y-down screen
      // transform, outward-wound front faces have NEGATIVE signed
      // area, so positive-area triangles are back faces.
      const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (area >= 0) continue;
      const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
      const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
      // Flat shading from the face normal (world)
      const faceNormal = normalize(
        cross(sub(vec3(b.wx, b.wy, b.wz), vec3(a.wx, a.wy, a.wz)), sub(vec3(c.wx, c.wy, c.wz), vec3(a.wx, a.wy, a.wz)))
      );
      const centroid = vec3((a.wx + b.wx + c.wx) / 3, (a.wy + b.wy + c.wy) / 3, (a.wz + b.wz + c.wz) / 3);
      const shaded = shade(centroid, faceNormal, node.material.color);
      const alpha = node.material.opacity;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const w0 = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / ((b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y));
          const w1 = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / ((b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y));
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const depth = w0 * a.z + w1 * b.z + w2 * c.z;
          const zi = y * width + x;
          if (depth >= zBuffer[zi]) continue;
          zBuffer[zi] = depth;
          if (alpha >= 1) {
            setPixel(img, x, y, { ...shaded, a: 255 });
          } else {
            const existing = img.data[zi * 4 + 3] > 0 ? { r: img.data[zi * 4], g: img.data[zi * 4 + 1], b: img.data[zi * 4 + 2] } : options.background;
            setPixel(img, x, y, {
              r: Math.round(shaded.r * alpha + existing.r * (1 - alpha)),
              g: Math.round(shaded.g * alpha + existing.g * (1 - alpha)),
              b: Math.round(shaded.b * alpha + existing.b * (1 - alpha)),
              a: 255
            });
          }
        }
      }
    }
  }
  return img;
}
