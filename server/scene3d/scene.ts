import * as crypto from 'crypto';
import {
  Mat4,
  Vec3,
  mat4Compose,
  mat4Identity,
  mat4Multiply,
  transformPoint,
  vec3
} from './math3d.js';

/**
 * Phase 21: scene graph, meshes, materials, lights, camera and
 * keyframe animation. All geometry is real vertex/index data; world
 * transforms come from walking the hierarchy with matrix composition.
 */

export interface MeshData {
  /** Flat xyz triples. */
  positions: number[];
  /** Flat xyz triples, one per vertex. */
  normals: number[];
  /** Flat uv pairs (may be empty). */
  uvs: number[];
  /** Triangle indices. */
  indices: number[];
}

export interface Material {
  name: string;
  color: { r: number; g: number; b: number }; // 0..1
  metalness: number; // 0..1 (stored for export; the software renderer is diffuse-based)
  roughness: number; // 0..1
  opacity: number; // 0..1
  texturePath?: string;
}

export interface Transform {
  position: Vec3;
  rotationEuler: Vec3; // radians
  scale: Vec3;
}

export interface SceneNode {
  id: string;
  name: string;
  parentId: string | null;
  visible: boolean;
  transform: Transform;
  mesh?: MeshData;
  material?: Material;
}

export type LightKind = 'ambient' | 'directional' | 'point';

export interface SceneLight {
  id: string;
  kind: LightKind;
  color: { r: number; g: number; b: number };
  intensity: number;
  position: Vec3; // point lights
  direction: Vec3; // directional lights (pointing from light toward scene)
}

export interface Camera {
  fovYDeg: number;
  near: number;
  far: number;
  target: Vec3;
  azimuthDeg: number;
  elevationDeg: number;
  distance: number;
}

export type AnimatableProperty = 'position' | 'rotation' | 'scale';

export interface Keyframe {
  time: number; // seconds
  value: Vec3;
}

export interface AnimationTrack {
  nodeId: string;
  property: AnimatableProperty;
  keyframes: Keyframe[]; // sorted by time
}

export interface Scene {
  name: string;
  nodes: SceneNode[];
  lights: SceneLight[];
  camera: Camera;
  animation: AnimationTrack[];
  durationSec: number;
}

export const defaultMaterial = (name: string = 'Material'): Material => ({
  name,
  color: { r: 0.8, g: 0.8, b: 0.8 },
  metalness: 0,
  roughness: 0.8,
  opacity: 1
});

export const identityTransform = (): Transform => ({
  position: vec3(0, 0, 0),
  rotationEuler: vec3(0, 0, 0),
  scale: vec3(1, 1, 1)
});

export function createScene(name: string = 'Scene'): Scene {
  return {
    name,
    nodes: [],
    lights: [
      { id: crypto.randomUUID(), kind: 'ambient', color: { r: 1, g: 1, b: 1 }, intensity: 0.25, position: vec3(), direction: vec3(0, -1, 0) },
      { id: crypto.randomUUID(), kind: 'directional', color: { r: 1, g: 1, b: 1 }, intensity: 0.9, position: vec3(5, 10, 5), direction: vec3(-0.4, -1, -0.4) }
    ],
    camera: { fovYDeg: 50, near: 0.1, far: 1000, target: vec3(0, 0, 0), azimuthDeg: 35, elevationDeg: 25, distance: 10 },
    animation: [],
    durationSec: 0
  };
}

export function addNode(scene: Scene, name: string, parentId: string | null = null): SceneNode {
  if (parentId && !scene.nodes.some((n) => n.id === parentId)) throw new Error(`Parent node not found: ${parentId}`);
  const node: SceneNode = {
    id: crypto.randomUUID(),
    name,
    parentId,
    visible: true,
    transform: identityTransform()
  };
  scene.nodes.push(node);
  return node;
}

export function getNode(scene: Scene, nodeId: string): SceneNode {
  const node = scene.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  return node;
}

export function removeNode(scene: Scene, nodeId: string): void {
  const node = getNode(scene, nodeId);
  // Reparent children to the removed node's parent (no orphan subtrees).
  for (const child of scene.nodes) {
    if (child.parentId === nodeId) child.parentId = node.parentId;
  }
  scene.nodes = scene.nodes.filter((n) => n.id !== nodeId);
  scene.animation = scene.animation.filter((t) => t.nodeId !== nodeId);
}

export function setParent(scene: Scene, nodeId: string, parentId: string | null): void {
  const node = getNode(scene, nodeId);
  if (parentId === nodeId) throw new Error('A node cannot be its own parent');
  if (parentId) {
    getNode(scene, parentId);
    // Cycle check: the new parent must not be a descendant of this node.
    let cursor: string | null = parentId;
    while (cursor) {
      if (cursor === nodeId) throw new Error('Reparenting would create a cycle');
      cursor = getNode(scene, cursor).parentId;
    }
  }
  node.parentId = parentId;
}

export function childrenOf(scene: Scene, nodeId: string | null): SceneNode[] {
  return scene.nodes.filter((n) => n.parentId === nodeId);
}

export function localMatrix(node: SceneNode): Mat4 {
  return mat4Compose(node.transform.position, node.transform.rotationEuler, node.transform.scale);
}

export function worldMatrix(scene: Scene, nodeId: string): Mat4 {
  const node = getNode(scene, nodeId);
  const local = localMatrix(node);
  if (!node.parentId) return local;
  return mat4Multiply(worldMatrix(scene, node.parentId), local);
}

export function worldPosition(scene: Scene, nodeId: string): Vec3 {
  return transformPoint(worldMatrix(scene, nodeId), vec3(0, 0, 0));
}

// ------------------------------------------------------------ primitives

function pushQuad(pos: number[], nor: number[], uv: number[], idx: number[], verts: Vec3[], normal: Vec3): void {
  const base = pos.length / 3;
  for (const v of verts) pos.push(v.x, v.y, v.z);
  for (let i = 0; i < 4; i++) {
    nor.push(normal.x, normal.y, normal.z);
    uv.push(i === 1 || i === 2 ? 1 : 0, i >= 2 ? 1 : 0);
  }
  idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** Unit cube centered at origin (24 verts, 36 indices, flat normals). */
export function createCubeMesh(size: number = 1): MeshData {
  const h = size / 2;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const faces: { n: Vec3; v: [Vec3, Vec3, Vec3, Vec3] }[] = [
    { n: vec3(0, 0, 1), v: [vec3(-h, -h, h), vec3(h, -h, h), vec3(h, h, h), vec3(-h, h, h)] },
    { n: vec3(0, 0, -1), v: [vec3(h, -h, -h), vec3(-h, -h, -h), vec3(-h, h, -h), vec3(h, h, -h)] },
    { n: vec3(1, 0, 0), v: [vec3(h, -h, h), vec3(h, -h, -h), vec3(h, h, -h), vec3(h, h, h)] },
    { n: vec3(-1, 0, 0), v: [vec3(-h, -h, -h), vec3(-h, -h, h), vec3(-h, h, h), vec3(-h, h, -h)] },
    { n: vec3(0, 1, 0), v: [vec3(-h, h, h), vec3(h, h, h), vec3(h, h, -h), vec3(-h, h, -h)] },
    { n: vec3(0, -1, 0), v: [vec3(-h, -h, -h), vec3(h, -h, -h), vec3(h, -h, h), vec3(-h, -h, h)] }
  ];
  for (const f of faces) pushQuad(pos, nor, uv, idx, f.v, f.n);
  return { positions: pos, normals: nor, uvs: uv, indices: idx };
}

/** UV sphere with smooth normals. */
export function createSphereMesh(radius: number = 0.5, widthSegs: number = 16, heightSegs: number = 12): MeshData {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let iy = 0; iy <= heightSegs; iy++) {
    const theta = (iy / heightSegs) * Math.PI;
    for (let ix = 0; ix <= widthSegs; ix++) {
      const phi = (ix / widthSegs) * Math.PI * 2;
      const x = radius * Math.sin(theta) * Math.cos(phi);
      const y = radius * Math.cos(theta);
      const z = radius * Math.sin(theta) * Math.sin(phi);
      pos.push(x, y, z);
      const inv = radius === 0 ? 0 : 1 / radius;
      nor.push(x * inv, y * inv, z * inv);
      uv.push(ix / widthSegs, 1 - iy / heightSegs);
    }
  }
  for (let iy = 0; iy < heightSegs; iy++) {
    for (let ix = 0; ix < widthSegs; ix++) {
      const a = iy * (widthSegs + 1) + ix;
      const b = a + widthSegs + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return { positions: pos, normals: nor, uvs: uv, indices: idx };
}

/** Ground plane in XZ. */
export function createPlaneMesh(width: number = 10, depth: number = 10): MeshData {
  const w = width / 2;
  const d = depth / 2;
  return {
    positions: [-w, 0, -d, w, 0, -d, w, 0, d, -w, 0, d],
    normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    uvs: [0, 0, 1, 0, 1, 1, 0, 1],
    indices: [0, 2, 1, 0, 3, 2]
  };
}

// ------------------------------------------------------------ mesh editing

/** Bake a transform into mesh vertices (positions + normals). */
export function bakeTransform(mesh: MeshData, transform: Transform): MeshData {
  const m = mat4Compose(transform.position, transform.rotationEuler, transform.scale);
  const positions: number[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const p = transformPoint(m, vec3(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]));
    positions.push(p.x, p.y, p.z);
  }
  // Normal matrix approximated by the rotation part (uniform-ish editing use).
  const rotOnly = mat4Compose(vec3(), transform.rotationEuler, vec3(1, 1, 1));
  const normals: number[] = [];
  for (let i = 0; i < mesh.normals.length; i += 3) {
    const n = transformPoint(rotOnly, vec3(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]));
    const len = Math.hypot(n.x, n.y, n.z) || 1;
    normals.push(n.x / len, n.y / len, n.z / len);
  }
  return { positions, normals, uvs: [...mesh.uvs], indices: [...mesh.indices] };
}

/** Move selected vertices by an offset (basic mesh editing). */
export function translateVertices(mesh: MeshData, vertexIndices: number[], offset: Vec3): void {
  for (const vi of vertexIndices) {
    if (vi < 0 || vi * 3 + 2 >= mesh.positions.length) throw new Error(`Vertex index out of range: ${vi}`);
    mesh.positions[vi * 3] += offset.x;
    mesh.positions[vi * 3 + 1] += offset.y;
    mesh.positions[vi * 3 + 2] += offset.z;
  }
}

export function meshStats(mesh: MeshData): { vertices: number; triangles: number } {
  return { vertices: mesh.positions.length / 3, triangles: mesh.indices.length / 3 };
}

// ------------------------------------------------------------ animation

export function addKeyframe(scene: Scene, nodeId: string, property: AnimatableProperty, time: number, value: Vec3): void {
  getNode(scene, nodeId);
  if (time < 0) throw new Error('Keyframe time cannot be negative');
  let track = scene.animation.find((t) => t.nodeId === nodeId && t.property === property);
  if (!track) {
    track = { nodeId, property, keyframes: [] };
    scene.animation.push(track);
  }
  track.keyframes = track.keyframes.filter((k) => k.time !== time);
  track.keyframes.push({ time, value: { ...value } });
  track.keyframes.sort((a, b) => a.time - b.time);
  scene.durationSec = Math.max(scene.durationSec, time);
}

function sampleTrack(track: AnimationTrack, time: number): Vec3 {
  const keys = track.keyframes;
  if (keys.length === 0) return vec3();
  if (time <= keys[0].time) return { ...keys[0].value };
  if (time >= keys[keys.length - 1].time) return { ...keys[keys.length - 1].value };
  for (let i = 1; i < keys.length; i++) {
    if (time <= keys[i].time) {
      const a = keys[i - 1];
      const b = keys[i];
      const t = (time - a.time) / (b.time - a.time);
      return {
        x: a.value.x + (b.value.x - a.value.x) * t,
        y: a.value.y + (b.value.y - a.value.y) * t,
        z: a.value.z + (b.value.z - a.value.z) * t
      };
    }
  }
  return { ...keys[keys.length - 1].value };
}

/** Return a deep copy of the scene with animation applied at `time`. */
export function evaluateSceneAt(scene: Scene, time: number): Scene {
  const copy: Scene = JSON.parse(JSON.stringify(scene));
  for (const track of copy.animation) {
    const node = copy.nodes.find((n: SceneNode) => n.id === track.nodeId);
    if (!node) continue;
    const value = sampleTrack(track, time);
    if (track.property === 'position') node.transform.position = value;
    else if (track.property === 'rotation') node.transform.rotationEuler = value;
    else node.transform.scale = value;
  }
  return copy;
}

// ------------------------------------------------------------ persistence

export interface SerializedScene {
  format: 'squadforge-scene3d';
  version: 1;
  scene: Scene;
}

export function serializeScene(scene: Scene): SerializedScene {
  return { format: 'squadforge-scene3d', version: 1, scene };
}

export function deserializeScene(data: SerializedScene): Scene {
  if (!data || data.format !== 'squadforge-scene3d' || data.version !== 1) {
    throw new Error('Not a SquadForge 3D scene (bad format/version)');
  }
  const scene = data.scene;
  if (!scene || !Array.isArray(scene.nodes)) throw new Error('Scene has no node list');
  const ids = new Set<string>();
  for (const node of scene.nodes) {
    if (ids.has(node.id)) throw new Error(`Duplicate node id: ${node.id}`);
    ids.add(node.id);
    if (node.mesh) {
      if (node.mesh.positions.length % 3 !== 0 || node.mesh.normals.length !== node.mesh.positions.length) {
        throw new Error(`Node "${node.name}" has malformed mesh data`);
      }
      const maxIndex = node.mesh.positions.length / 3 - 1;
      for (const ix of node.mesh.indices) {
        if (ix < 0 || ix > maxIndex) throw new Error(`Node "${node.name}" has an out-of-range mesh index`);
      }
    }
  }
  for (const node of scene.nodes) {
    if (node.parentId && !ids.has(node.parentId)) throw new Error(`Node "${node.name}" references a missing parent`);
  }
  return scene;
}
