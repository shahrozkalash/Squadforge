import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  vec3,
  mat4Compose,
  transformPoint,
  orbitPosition
} from '../server/scene3d/math3d.js';
import {
  createScene,
  addNode,
  removeNode,
  setParent,
  worldPosition,
  createCubeMesh,
  createSphereMesh,
  createPlaneMesh,
  bakeTransform,
  translateVertices,
  meshStats,
  addKeyframe,
  evaluateSceneAt,
  serializeScene,
  deserializeScene,
  defaultMaterial,
  identityTransform
} from '../server/scene3d/scene.js';
import { renderScene } from '../server/scene3d/renderer.js';
import { exportObj, exportGltf } from '../server/scene3d/exporters.js';
import { Scene3dProjectGenerator } from '../server/scene3d/scene3dProjectGenerator.js';
import { getPixel } from '../server/imageEditor/imageCore.js';

function sceneWithCube(): { scene: ReturnType<typeof createScene>; cubeId: string } {
  const scene = createScene('Test');
  const cube = addNode(scene, 'Cube');
  cube.mesh = createCubeMesh(2);
  cube.material = { ...defaultMaterial('Red'), color: { r: 1, g: 0, b: 0 } };
  return { scene, cubeId: cube.id };
}

describe('SquadForge Phase 21: 3D Creation Engine Test Suite', () => {
  describe('1. Math & camera', () => {
    test('1.1 TRS composition moves points as expected', () => {
      const m = mat4Compose(vec3(1, 2, 3), vec3(0, 0, 0), vec3(2, 2, 2));
      const p = transformPoint(m, vec3(1, 0, 0));
      assert.deepEqual([p.x, p.y, p.z], [3, 2, 3]);
    });

    test('1.2 Orbit camera stays at the requested distance', () => {
      const eye = orbitPosition(vec3(0, 0, 0), 0, 0, 10);
      assert.ok(Math.abs(Math.hypot(eye.x, eye.y, eye.z) - 10) < 1e-9);
      const top = orbitPosition(vec3(0, 0, 0), 0, 90, 5);
      assert.ok(Math.abs(top.y - 5) < 1e-9);
    });
  });

  describe('2. Primitives & mesh editing', () => {
    test('2.1 Cube has 24 vertices, 12 triangles, unit normals', () => {
      const cube = createCubeMesh(2);
      const stats = meshStats(cube);
      assert.equal(stats.vertices, 24);
      assert.equal(stats.triangles, 12);
      for (let i = 0; i < cube.normals.length; i += 3) {
        const len = Math.hypot(cube.normals[i], cube.normals[i + 1], cube.normals[i + 2]);
        assert.ok(Math.abs(len - 1) < 1e-9);
      }
      assert.equal(Math.max(...cube.positions), 1);
    });

    test('2.2 Sphere geometry is closed and sized; plane lies in XZ', () => {
      const sphere = createSphereMesh(1, 8, 6);
      assert.equal(meshStats(sphere).vertices, 9 * 7);
      const maxR = Math.max(...Array.from({ length: sphere.positions.length / 3 }, (_, i) =>
        Math.hypot(sphere.positions[i * 3], sphere.positions[i * 3 + 1], sphere.positions[i * 3 + 2])));
      assert.ok(Math.abs(maxR - 1) < 1e-9);
      const plane = createPlaneMesh(4, 4);
      assert.ok(plane.positions.every((v, i) => i % 3 !== 1 || v === 0));
    });

    test('2.3 Vertex translation edits only the selected vertices; bake applies TRS', () => {
      const cube = createCubeMesh(1);
      const xBefore = cube.positions[0];
      const yBefore = cube.positions[1];
      translateVertices(cube, [0], vec3(0, 5, 0));
      assert.equal(cube.positions[0], xBefore); // x untouched
      assert.equal(cube.positions[1], yBefore + 5); // y moved by the offset
      assert.equal(cube.positions[4], -0.5); // vertex 1 untouched
      assert.throws(() => translateVertices(cube, [9999], vec3()), /out of range/);
      const baked = bakeTransform(createCubeMesh(1), { position: vec3(10, 0, 0), rotationEuler: vec3(), scale: vec3(1, 1, 1) });
      assert.equal(Math.max(...baked.positions.filter((_, i) => i % 3 === 0)), 10.5);
    });
  });

  describe('3. Scene hierarchy', () => {
    test('3.1 Child world position inherits parent transforms', () => {
      const scene = createScene();
      const parent = addNode(scene, 'Parent');
      parent.transform.position = vec3(10, 0, 0);
      const child = addNode(scene, 'Child', parent.id);
      child.transform.position = vec3(0, 2, 0);
      const wp = worldPosition(scene, child.id);
      assert.deepEqual([wp.x, wp.y, wp.z], [10, 2, 0]);
    });

    test('3.2 Reparenting rejects cycles; removal reparents children', () => {
      const scene = createScene();
      const a = addNode(scene, 'A');
      const b = addNode(scene, 'B', a.id);
      assert.throws(() => setParent(scene, a.id, b.id), /cycle/);
      assert.throws(() => setParent(scene, a.id, a.id), /own parent/);
      removeNode(scene, a.id);
      assert.equal(b.parentId, null);
      assert.equal(scene.nodes.length, 1);
    });
  });

  describe('4. Animation', () => {
    test('4.1 Keyframe sampling interpolates linearly and clamps at the ends', () => {
      const { scene, cubeId } = sceneWithCube();
      addKeyframe(scene, cubeId, 'position', 0, vec3(0, 0, 0));
      addKeyframe(scene, cubeId, 'position', 2, vec3(4, 2, 0));
      const mid = evaluateSceneAt(scene, 1);
      const node = mid.nodes.find((n) => n.id === cubeId)!;
      assert.deepEqual([node.transform.position.x, node.transform.position.y], [2, 1]);
      const before = evaluateSceneAt(scene, -5).nodes.find((n) => n.id === cubeId)!;
      assert.equal(before.transform.position.x, 0);
      const after = evaluateSceneAt(scene, 99).nodes.find((n) => n.id === cubeId)!;
      assert.equal(after.transform.position.x, 4);
      assert.equal(scene.durationSec, 2);
      // The original scene is not mutated by evaluation
      assert.equal(scene.nodes.find((n) => n.id === cubeId)!.transform.position.x, 0);
    });
  });

  describe('5. Persistence', () => {
    test('5.1 Scene round-trips; malformed scenes are rejected', () => {
      const { scene } = sceneWithCube();
      const restored = deserializeScene(JSON.parse(JSON.stringify(serializeScene(scene))));
      assert.equal(restored.nodes.length, scene.nodes.length);
      assert.equal(restored.nodes[0].mesh!.indices.length, 36);
      assert.throws(() => deserializeScene({ format: 'nope' } as any), /format\/version/);
      const bad = serializeScene(scene);
      (bad.scene.nodes[0].mesh as any).indices = [0, 1, 9999];
      assert.throws(() => deserializeScene(JSON.parse(JSON.stringify(bad))), /out-of-range/);
    });
  });

  describe('6. Export validation', () => {
    test('6.1 OBJ export contains world-baked vertices and faces', () => {
      const { scene, cubeId } = sceneWithCube();
      scene.nodes.find((n) => n.id === cubeId)!.transform.position = vec3(5, 0, 0);
      const { obj, mtl } = exportObj(scene);
      const vLines = obj.split('\n').filter((l) => l.startsWith('v '));
      const fLines = obj.split('\n').filter((l) => l.startsWith('f '));
      assert.equal(vLines.length, 24);
      assert.equal(fLines.length, 12);
      const maxX = Math.max(...vLines.map((l) => parseFloat(l.split(' ')[1])));
      assert.equal(maxX, 6); // 5 + half size 1
      assert.match(mtl, /newmtl Red/);
    });

    test('6.2 glTF export is structurally valid (accessors, buffer, animation)', () => {
      const { scene, cubeId } = sceneWithCube();
      addKeyframe(scene, cubeId, 'position', 0, vec3(0, 0, 0));
      addKeyframe(scene, cubeId, 'position', 1, vec3(1, 0, 0));
      const gltf: any = exportGltf(scene);
      assert.equal(gltf.asset.version, '2.0');
      assert.equal(gltf.meshes.length, 1);
      const bin = Buffer.from(gltf.buffers[0].uri.split(',')[1], 'base64');
      assert.equal(bin.length, gltf.buffers[0].byteLength);
      for (const view of gltf.bufferViews) {
        assert.ok(view.byteOffset + view.byteLength <= bin.length, 'bufferView exceeds buffer');
      }
      const posAcc = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION];
      assert.equal(posAcc.count, 24);
      assert.deepEqual(posAcc.max, [1, 1, 1]);
      const idxAcc = gltf.accessors[gltf.meshes[0].primitives[0].indices];
      assert.equal(idxAcc.count, 36);
      assert.equal(gltf.animations.length, 1);
      assert.equal(gltf.animations[0].channels[0].target.path, 'translation');
      assert.equal(gltf.scenes[0].nodes.length, 1);
    });
  });

  describe('7. Software renderer (real rasterization)', () => {
    test('7.1 A cube renders visible, shaded pixels — not a blank frame', () => {
      const { scene } = sceneWithCube();
      const img = renderScene(scene, { width: 160, height: 120, background: { r: 24, g: 24, b: 32 } });
      let nonBg = 0;
      let redish = 0;
      for (let y = 0; y < 120; y++) {
        for (let x = 0; x < 160; x++) {
          const px = getPixel(img, x, y);
          if (!(px.r === 24 && px.g === 24 && px.b === 32)) {
            nonBg++;
            if (px.r > 100 && px.g < 80) redish++;
          }
        }
      }
      assert.ok(nonBg > 500, `expected a substantial silhouette, got ${nonBg} pixels`);
      assert.ok(redish > 400, `expected red-lit faces, got ${redish}`);
    });

    test('7.2 Occlusion: the nearer object hides the farther one', () => {
      const scene = createScene();
      scene.camera = { fovYDeg: 50, near: 0.1, far: 100, target: vec3(0, 0, 0), azimuthDeg: 0, elevationDeg: 0, distance: 10 };
      const near = addNode(scene, 'Near');
      near.mesh = createCubeMesh(3);
      near.material = { ...defaultMaterial('Green'), color: { r: 0, g: 1, b: 0 } };
      near.transform.position = vec3(0, 0, 2);
      const far = addNode(scene, 'Far');
      far.mesh = createCubeMesh(3);
      far.material = { ...defaultMaterial('Blue'), color: { r: 0, g: 0, b: 1 } };
      far.transform.position = vec3(0, 0, -3);
      const img = renderScene(scene, { width: 120, height: 90, background: { r: 0, g: 0, b: 0 } });
      const center = getPixel(img, 60, 45);
      assert.ok(center.g > 80 && center.b < 60, `center should be the green near cube, got ${JSON.stringify(center)}`);
    });

    test('7.3 Lighting changes the render: removing lights darkens the scene', () => {
      const { scene } = sceneWithCube();
      const lit = renderScene(scene, { width: 80, height: 60, background: { r: 0, g: 0, b: 0 } });
      scene.lights = [];
      const dark = renderScene(scene, { width: 80, height: 60, background: { r: 0, g: 0, b: 0 } });
      const sum = (img: typeof lit) => {
        let s = 0;
        for (let i = 0; i < img.data.length; i += 4) s += img.data[i];
        return s;
      };
      assert.ok(sum(lit) > sum(dark) + 1000, 'lit scene must be brighter');
      assert.equal(sum(dark), 0);
    });

    test('7.4 Animation evaluation changes the render (object moves)', () => {
      const { scene, cubeId } = sceneWithCube();
      addKeyframe(scene, cubeId, 'position', 0, vec3(0, 0, 0));
      addKeyframe(scene, cubeId, 'position', 1, vec3(50, 0, 0)); // moves out of frame
      const atStart = renderScene(evaluateSceneAt(scene, 0), { width: 80, height: 60, background: { r: 0, g: 0, b: 0 } });
      const atEnd = renderScene(evaluateSceneAt(scene, 1), { width: 80, height: 60, background: { r: 0, g: 0, b: 0 } });
      const nonBg = (img: typeof atStart) => {
        let n = 0;
        for (let i = 0; i < img.data.length; i += 4) if (img.data[i] + img.data[i + 1] + img.data[i + 2] > 0) n++;
        return n;
      };
      assert.ok(nonBg(atStart) > 100);
      assert.equal(nonBg(atEnd), 0);
    });
  });

  describe('8. Generated Application Source', () => {
    test('8.1 Generator emits a complete 3D app on the desktop stack', () => {
      const config = Scene3dProjectGenerator.getDefaultConfig('ModelForge');
      const files = Scene3dProjectGenerator.generateProjectFiles(config);
      for (const expected of [
        'ModelForge.sln',
        'src/ModelForge/ModelForge.csproj',
        'src/ModelForge/Program.cs',
        'src/ModelForge/MainForm.cs',
        'src/ModelForge/SceneDocument.cs',
        'src/ModelForge/Viewport3D.cs'
      ]) {
        assert.ok(files[expected], `missing ${expected}`);
      }
      assert.match(files['src/ModelForge/SceneDocument.cs'], /CreateCube/);
      assert.match(files['src/ModelForge/SceneDocument.cs'], /ExportObj/);
      assert.match(files['src/ModelForge/Viewport3D.cs'], /OnMouseWheel/);
      assert.match(files['src/ModelForge/Viewport3D.cs'], /software/i);
    });

    test('8.2 identityTransform is a true identity', () => {
      const t = identityTransform();
      assert.deepEqual([t.position.x, t.scale.x], [0, 1]);
    });
  });
});
