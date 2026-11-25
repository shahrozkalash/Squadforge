import { Scene, SceneNode, worldMatrix } from './scene.js';
import { transformPoint, vec3 } from './math3d.js';

/**
 * Phase 21: real 3D file export.
 *
 * OBJ (+MTL): world-space geometry, standard text format readable by
 * Blender/MeshLab/Unity. glTF 2.0: a self-contained JSON + binary
 * buffer (embedded base64) with nodes, meshes, PBR materials and
 * keyframe animations — the interchange format of the web/AR world.
 * Both are generated from the same scene graph; nothing is stubbed.
 */

export function exportObj(scene: Scene): { obj: string; mtl: string } {
  const objLines: string[] = [`# SquadForge 3D scene: ${scene.name}`, 'mtllib scene.mtl'];
  const mtlLines: string[] = ['# SquadForge materials'];
  const materialNames = new Map<string, string>();
  let vertexOffset = 0;
  let normalOffset = 0;
  let uvOffset = 0;

  const materialNameFor = (node: SceneNode): string => {
    if (!node.material) return 'default';
    if (!materialNames.has(node.material.name)) {
      materialNames.set(node.material.name, node.material.name.replace(/\s+/g, '_'));
      const m = node.material;
      mtlLines.push(
        `newmtl ${materialNames.get(node.material.name)}`,
        `Kd ${m.color.r} ${m.color.g} ${m.color.b}`,
        `d ${m.opacity}`,
        ''
      );
    }
    return materialNames.get(node.material.name)!;
  };

  for (const node of scene.nodes) {
    if (!node.mesh) continue;
    // OBJ has no scene graph: bake each node's full world transform in.
    const wm = worldMatrix(scene, node.id);
    objLines.push(`o ${node.name.replace(/\s+/g, '_')}`);
    objLines.push(`usemtl ${materialNameFor(node)}`);
    for (let i = 0; i < node.mesh.positions.length; i += 3) {
      const p = transformPoint(wm, vec3(node.mesh.positions[i], node.mesh.positions[i + 1], node.mesh.positions[i + 2]));
      objLines.push(`v ${p.x.toFixed(6)} ${p.y.toFixed(6)} ${p.z.toFixed(6)}`);
    }
    for (let i = 0; i < node.mesh.normals.length; i += 3) {
      objLines.push(`vn ${node.mesh.normals[i].toFixed(6)} ${node.mesh.normals[i + 1].toFixed(6)} ${node.mesh.normals[i + 2].toFixed(6)}`);
    }
    for (let i = 0; i < node.mesh.uvs.length; i += 2) {
      objLines.push(`vt ${node.mesh.uvs[i].toFixed(6)} ${node.mesh.uvs[i + 1].toFixed(6)}`);
    }
    for (let t = 0; t + 2 < node.mesh.indices.length; t += 3) {
      const f = [0, 1, 2].map((k) => {
        const ix = node.mesh!.indices[t + k] + 1;
        return `${ix + vertexOffset}/${ix + uvOffset}/${ix + normalOffset}`;
      });
      objLines.push(`f ${f[0]} ${f[1]} ${f[2]}`);
    }
    vertexOffset += node.mesh.positions.length / 3;
    normalOffset += node.mesh.normals.length / 3;
    uvOffset += node.mesh.uvs.length / 2;
  }
  return { obj: objLines.join('\n') + '\n', mtl: mtlLines.join('\n') + '\n' };
}

// ------------------------------------------------------------------ glTF

interface GltfBuffer {
  chunks: Buffer[];
  length: number;
  push(data: Buffer): number; // returns byteOffset
}

function makeBuffer(): GltfBuffer {
  const chunks: Buffer[] = [];
  let length = 0;
  return {
    chunks,
    get length() {
      return length;
    },
    push(data: Buffer) {
      const offset = length;
      chunks.push(data);
      length += data.length;
      const pad = (4 - (length % 4)) % 4;
      if (pad) {
        chunks.push(Buffer.alloc(pad));
        length += pad;
      }
      return offset;
    }
  };
}

export function exportGltf(scene: Scene): object {
  const buffer = makeBuffer();
  const bufferViews: any[] = [];
  const accessors: any[] = [];

  const addAccessor = (data: Buffer, componentType: number, type: string, count: number, min?: number[], max?: number[]): number => {
    const byteOffset = buffer.push(data);
    bufferViews.push({ buffer: 0, byteOffset, byteLength: data.length });
    const accessor: any = { bufferView: bufferViews.length - 1, componentType, type, count };
    if (min) accessor.min = min;
    if (max) accessor.max = max;
    accessors.push(accessor);
    return accessors.length - 1;
  };

  const materials: any[] = [];
  const materialIndex = new Map<string, number>();
  const meshes: any[] = [];
  const meshIndexByNode = new Map<string, number>();

  for (const node of scene.nodes) {
    if (!node.mesh) continue;
    const mesh = node.mesh;
    const pos = Float32Array.from(mesh.positions);
    const nor = Float32Array.from(mesh.normals);
    const uv = Float32Array.from(mesh.uvs);
    const idx = Uint32Array.from(mesh.indices);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], pos[i + k]);
        max[k] = Math.max(max[k], pos[i + k]);
      }
    }
    const posAcc = addAccessor(Buffer.from(pos.buffer), 5126, 'VEC3', pos.length / 3, min, max);
    const norAcc = addAccessor(Buffer.from(nor.buffer), 5126, 'VEC3', nor.length / 3);
    const uvAcc = uv.length > 0 ? addAccessor(Buffer.from(uv.buffer), 5126, 'VEC2', uv.length / 2) : undefined;
    const idxAcc = addAccessor(Buffer.from(idx.buffer), 5125, 'SCALAR', idx.length);

    let matIdx: number | undefined;
    if (node.material) {
      if (!materialIndex.has(node.material.name)) {
        materialIndex.set(node.material.name, materials.length);
        materials.push({
          name: node.material.name,
          pbrMetallicRoughness: {
            baseColorFactor: [node.material.color.r, node.material.color.g, node.material.color.b, node.material.opacity],
            metallicFactor: node.material.metalness,
            roughnessFactor: node.material.roughness
          }
        });
      }
      matIdx = materialIndex.get(node.material.name);
    }
    const attributes: any = { POSITION: posAcc, NORMAL: norAcc };
    if (uvAcc !== undefined) attributes.TEXCOORD_0 = uvAcc;
    meshes.push({ name: node.name, primitives: [{ attributes, indices: idxAcc, material: matIdx }] });
    meshIndexByNode.set(node.id, meshes.length - 1);
  }

  const nodeIndexById = new Map<string, number>();
  const gltfNodes: any[] = scene.nodes.map((node, i) => {
    nodeIndexById.set(node.id, i);
    const g: any = {
      name: node.name,
      translation: [node.transform.position.x, node.transform.position.y, node.transform.position.z],
      rotation: eulerToQuaternion(node.transform.rotationEuler),
      scale: [node.transform.scale.x, node.transform.scale.y, node.transform.scale.z]
    };
    if (meshIndexByNode.has(node.id)) g.mesh = meshIndexByNode.get(node.id);
    return g;
  });
  scene.nodes.forEach((node, i) => {
    const children = scene.nodes.filter((n) => n.parentId === node.id).map((n) => nodeIndexById.get(n.id)!);
    if (children.length > 0) gltfNodes[i].children = children;
  });
  const roots = scene.nodes.filter((n) => !n.parentId).map((n) => nodeIndexById.get(n.id)!);

  // Animations: one glTF animation per scene, channels per track.
  const animations: any[] = [];
  if (scene.animation.length > 0) {
    const samplers: any[] = [];
    const channels: any[] = [];
    for (const track of scene.animation) {
      const times = Float32Array.from(track.keyframes.map((k) => k.time));
      const values = new Float32Array(track.keyframes.length * (track.property === 'rotation' ? 4 : 3));
      track.keyframes.forEach((k, i) => {
        if (track.property === 'rotation') {
          const q = eulerToQuaternion(k.value);
          values.set(q, i * 4);
        } else {
          values.set([k.value.x, k.value.y, k.value.z], i * 3);
        }
      });
      const timeAcc = addAccessor(Buffer.from(times.buffer), 5126, 'SCALAR', times.length, [times[0]], [times[times.length - 1]]);
      const valAcc = addAccessor(
        Buffer.from(values.buffer),
        5126,
        track.property === 'rotation' ? 'VEC4' : 'VEC3',
        track.keyframes.length
      );
      samplers.push({ input: timeAcc, output: valAcc, interpolation: 'LINEAR' });
      channels.push({
        sampler: samplers.length - 1,
        target: {
          node: nodeIndexById.get(track.nodeId),
          path: track.property === 'position' ? 'translation' : track.property === 'rotation' ? 'rotation' : 'scale'
        }
      });
    }
    animations.push({ name: 'SceneAnimation', samplers, channels });
  }

  const bin = Buffer.concat(buffer.chunks);
  const gltf: any = {
    asset: { version: '2.0', generator: 'SquadForge Phase 21 3D Creation Engine' },
    scene: 0,
    scenes: [{ nodes: roots }],
    nodes: gltfNodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length, uri: `data:application/octet-stream;base64,${bin.toString('base64')}` }]
  };
  if (animations.length > 0) gltf.animations = animations;
  return gltf;
}

function eulerToQuaternion(e: { x: number; y: number; z: number }): [number, number, number, number] {
  const cx = Math.cos(e.x / 2), sx = Math.sin(e.x / 2);
  const cy = Math.cos(e.y / 2), sy = Math.sin(e.y / 2);
  const cz = Math.cos(e.z / 2), sz = Math.sin(e.z / 2);
  // q = qx * qy * qz
  const qx = [sx, 0, 0, cx];
  const qy = [0, sy, 0, cy];
  const qz = [0, 0, sz, cz];
  const mul = (a: number[], b: number[]): number[] => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ];
  const q = mul(mul(qx, qy), qz);
  return [q[0], q[1], q[2], q[3]];
}
