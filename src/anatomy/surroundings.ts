import * as THREE from 'three';
import { SURROUNDINGS } from '../config/anatomy';
import { createCortexMaterial } from './lobes';
import { createTissueMaterial } from './materials';
import { fbm3, noise3 } from './noise';
import type { TextureSet } from './textures';
import { buildTube, splineFrom } from './tube';

/**
 * Structures in the depth of the field that give the scene its landmarks and background:
 * the anterior clinoid process, the tentorial edge, the insula and the deep cistern floor.
 */

function lumpyEllipsoid(radii: [number, number, number], seed: number, amp: number, freq: number, detail = 32): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const n = noise3(seed);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const d = 1 + fbm3(n, v.x * freq, v.y * freq, v.z * freq, 3) * amp;
    pos.setXYZ(i, v.x * radii[0] * d, v.y * radii[1] * d, v.z * radii[2] * d);
  }
  g.computeVertexNormals();
  return g;
}

export function buildSurroundings(tex: { bone: TextureSet; membrane: TextureSet; cortex: TextureSet }): THREE.Group {
  const group = new THREE.Group();
  group.name = 'surroundings';
  const S = SURROUNDINGS;

  // Anterior clinoid process — bone. The ICA emerges from the distal dural ring beneath it.
  {
    const geom = lumpyEllipsoid(S.clinoid.radii, 31, 0.12, 1.4, 24);
    // Spherical UVs from IcosahedronGeometry are fine for a speckled bone texture.
    const mat = createTissueMaterial({
      color: 0xffffff,
      map: tex.bone.map,
      normalMap: tex.bone.normalMap,
      normalScale: new THREE.Vector2(0.6, 0.6),
      roughness: 0.55,
      clearcoat: 0.6,
      clearcoatRoughness: 0.25,
      envMapIntensity: 0.3,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(...S.clinoid.center);
    mesh.rotation.set(0.3, -0.2, 0.5);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData = { kind: 'bone', id: 'clinoid', label: 'Anterior clinoid process' };
    group.add(mesh);
  }

  // Tentorial free edge — glistening grey-white dura.
  {
    const curve = splineFrom(S.tentorium.points);
    const geom = buildTube(curve, {
      tubular: 90,
      radial: 20,
      radius: () => S.tentorium.radius,
      ellipse: [0.45, 1.6],
      up: new THREE.Vector3(0, 0, 1),
      capStart: true,
      capEnd: true,
    });
    const map = tex.membrane.map.clone();
    map.repeat.set(3, 1);
    map.needsUpdate = true;
    const mat = createTissueMaterial({
      color: 0xf0e2d8,
      map,
      normalMap: tex.membrane.normalMap,
      roughness: 0.32,
      clearcoat: 1,
      clearcoatRoughness: 0.1,
      envMapIntensity: 0.4,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData = { kind: 'dura', id: 'tentorium', label: 'Tentorial edge' };
    group.add(mesh);
  }

  // Deep cistern floor: arachnoid-covered membranes, dark and moist.
  {
    const [w, h] = S.floor.size;
    const geom = new THREE.PlaneGeometry(w, h, 120, 90);
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    const n = noise3(41);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      pos.setZ(i, fbm3(n, x * 0.06, y * 0.06, 0.5, 4) * 2.2);
    }
    geom.computeVertexNormals();
    const map = tex.membrane.map.clone();
    const nm = tex.membrane.normalMap.clone();
    map.repeat.set(4, 3);
    nm.repeat.set(4, 3);
    map.needsUpdate = nm.needsUpdate = true;
    const mat = createTissueMaterial({
      color: 0x5e2622,
      map,
      normalMap: nm,
      normalScale: new THREE.Vector2(0.25, 0.25),
      roughness: 0.55,
      clearcoat: 0.35,
      clearcoatRoughness: 0.35,
      envMapIntensity: 0.05,
      pulseAmp: 0.02,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(6, -2, S.floor.z);
    mesh.receiveShadow = true;
    mesh.userData = { kind: 'membrane', id: 'floor', label: 'Basal cistern' };
    group.add(mesh);
  }

  // Insula at the bottom of the lateral sylvian fissure — cortex, with short gyri.
  {
    const geom = lumpyEllipsoid(S.insula.radii, 51, 0.08, 1.8, 40);
    const colors = new Float32Array(geom.getAttribute('position').count * 3).fill(0.92);
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = createCortexMaterial(tex.cortex, [2, 1]);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(...S.insula.center);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData = { kind: 'brain', id: 'insula', label: 'Insula' };
    group.add(mesh);
  }

  return group;
}
