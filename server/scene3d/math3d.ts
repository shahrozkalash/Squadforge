/**
 * Phase 21: minimal, correct 3D math — vectors, quaternions and 4x4
 * matrices (column-vector convention, right-handed, Y-up). Everything
 * the scene graph, camera and software renderer build on.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => vec3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, s: number): Vec3 => vec3(a.x * s, a.y * s, a.z * s);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const normalize = (a: Vec3): Vec3 => {
  const len = length(a);
  return len < 1e-12 ? vec3(0, 0, 0) : scale(a, 1 / len);
};
export const lerpVec3 = (a: Vec3, b: Vec3, t: number): Vec3 =>
  vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

/** Row-major 4x4 matrix as a 16-element array (m[row*4+col]). */
export type Mat4 = Float64Array;

export function mat4Identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[r * 4 + k] * b[k * 4 + c];
      out[r * 4 + c] = sum;
    }
  }
  return out;
}

export function mat4Translation(t: Vec3): Mat4 {
  const m = mat4Identity();
  m[3] = t.x;
  m[7] = t.y;
  m[11] = t.z;
  return m;
}

export function mat4Scale(s: Vec3): Mat4 {
  const m = mat4Identity();
  m[0] = s.x;
  m[5] = s.y;
  m[10] = s.z;
  return m;
}

export function mat4RotationEuler(e: Vec3): Mat4 {
  // XYZ intrinsic order: R = Rx * Ry * Rz applied as Rz first to vectors.
  const cx = Math.cos(e.x), sx = Math.sin(e.x);
  const cy = Math.cos(e.y), sy = Math.sin(e.y);
  const cz = Math.cos(e.z), sz = Math.sin(e.z);
  const rx = new Float64Array([1, 0, 0, 0, 0, cx, -sx, 0, 0, sx, cx, 0, 0, 0, 0, 1]);
  const ry = new Float64Array([cy, 0, sy, 0, 0, 1, 0, 0, -sy, 0, cy, 0, 0, 0, 0, 1]);
  const rz = new Float64Array([cz, -sz, 0, 0, sz, cz, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return mat4Multiply(rx, mat4Multiply(ry, rz));
}

/** Compose T * R * S. */
export function mat4Compose(position: Vec3, rotationEuler: Vec3, scl: Vec3): Mat4 {
  return mat4Multiply(mat4Translation(position), mat4Multiply(mat4RotationEuler(rotationEuler), mat4Scale(scl)));
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  const w = m[12] * p.x + m[13] * p.y + m[14] * p.z + m[15];
  return vec3(
    (m[0] * p.x + m[1] * p.y + m[2] * p.z + m[3]) / w,
    (m[4] * p.x + m[5] * p.y + m[6] * p.z + m[7]) / w,
    (m[8] * p.x + m[9] * p.y + m[10] * p.z + m[11]) / w
  );
}

/** Transform a direction (ignores translation, no perspective divide). */
export function transformDirection(m: Mat4, p: Vec3): Vec3 {
  return vec3(
    m[0] * p.x + m[1] * p.y + m[2] * p.z,
    m[4] * p.x + m[5] * p.y + m[6] * p.z,
    m[8] * p.x + m[9] * p.y + m[10] * p.z
  );
}

export function mat4Perspective(fovYDeg: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(((fovYDeg * Math.PI) / 180) / 2);
  const m = new Float64Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = (2 * far * near) / (near - far);
  m[14] = -1;
  return m;
}

export function mat4LookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const zAxis = normalize(sub(eye, target));
  const xAxis = normalize(cross(up, zAxis));
  const yAxis = cross(zAxis, xAxis);
  const m = mat4Identity();
  m[0] = xAxis.x; m[1] = xAxis.y; m[2] = xAxis.z; m[3] = -dot(xAxis, eye);
  m[4] = yAxis.x; m[5] = yAxis.y; m[6] = yAxis.z; m[7] = -dot(yAxis, eye);
  m[8] = zAxis.x; m[9] = zAxis.y; m[10] = zAxis.z; m[11] = -dot(zAxis, eye);
  return m;
}

/** Orbit camera: position on a sphere around the target. */
export function orbitPosition(target: Vec3, azimuthDeg: number, elevationDeg: number, distance: number): Vec3 {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  return vec3(
    target.x + distance * Math.cos(el) * Math.sin(az),
    target.y + distance * Math.sin(el),
    target.z + distance * Math.cos(el) * Math.cos(az)
  );
}
