import * as THREE from 'three';
import { ANEURYSM } from '../config/anatomy';
import { createTissueMaterial, type TissueMaterial } from './materials';
import { noise3 } from './noise';
import type { TextureSet } from './textures';
import type { Vessel } from './vessels';

/**
 * Saccular aneurysm at the IC-PC junction.
 *
 * Built as a surface of revolution around the dome axis (neck → apex), then deformed:
 *  - a narrower NECK where it leaves the ICA wall (this is what the clip blades must close),
 *  - a rounder DOME (6.6 mm) whose wall gets thinner, paler and more translucent toward the apex,
 *  - a small BLEB (daughter sac) — the thinnest, darkest, most rupture-prone spot,
 *  - mild surface irregularity.
 * Vertex attribute `aPulseW` makes the dome pulse more than the neck (thin wall).
 */
export interface Aneurysm {
  mesh: THREE.Mesh;
  material: TissueMaterial;
  /** World-space centre of the neck, on the ICA wall. */
  neckCenter: THREE.Vector3;
  /** Unit vector from neck toward the dome apex. */
  axis: THREE.Vector3;
  neckRadius: number;
  domeRadius: number;
  domeCenter: THREE.Vector3;
  apex: THREE.Vector3;
  bleb: THREE.Vector3;
  /** Parameter along the ICA where the neck sits. */
  icaT: number;
  /** Height of the dome above the ICA wall (mm). */
  height: number;
  /** Sac radius at height h above the wall, in the aneurysm's local frame (+Y = dome axis). */
  radiusAt(h: number): number;
  /** Texture coordinate v (0 neck … 1 apex) of the row at height h. */
  vAtHeight(h: number): number;
}

export function buildAneurysm(ica: Vessel, tex: TextureSet): Aneurysm {
  const A = ANEURYSM;
  const R = A.domeDiameter / 2;
  const rn = A.neckDiameter / 2;
  const H = A.height;

  // --- Where the neck sits on the ICA ---
  const icaPoint = ica.curve.getPointAt(A.icaT);
  const tangent = ica.curve.getTangentAt(A.icaT);
  const axis = new THREE.Vector3(...A.direction).normalize();
  // Put the neck on the ICA wall in the direction the dome points (perpendicular part only).
  const perp = axis.clone().addScaledVector(tangent, -axis.dot(tangent)).normalize();
  const neckCenter = icaPoint.clone().addScaledVector(perp, ica.radiusAt(A.icaT) * 0.78);

  // --- Profile (radius r at height h along the axis) ---
  const profile = new THREE.SplineCurve([
    new THREE.Vector2(rn * 0.85, -2.4), // buried inside the ICA
    new THREE.Vector2(rn * 0.96, -0.8),
    new THREE.Vector2(rn * 1.0, 0.25), // the neck
    new THREE.Vector2(rn * 1.07, 0.95),
    new THREE.Vector2(R * 0.87, 1.95),
    new THREE.Vector2(R * 0.99, H * 0.42),
    new THREE.Vector2(R * 1.0, H * 0.55), // widest part of the dome
    new THREE.Vector2(R * 0.9, H * 0.74),
    new THREE.Vector2(R * 0.62, H * 0.89),
    new THREE.Vector2(R * 0.3, H * 0.975),
    new THREE.Vector2(0.001, H),
  ]);
  const [radial, rows] = A.segments;
  const prof = profile.getSpacedPoints(rows);

  const positions = new Float32Array((rows + 1) * (radial + 1) * 3);
  const uvs = new Float32Array((rows + 1) * (radial + 1) * 2);
  const colors = new Float32Array((rows + 1) * (radial + 1) * 3);
  const pulseW = new Float32Array((rows + 1) * (radial + 1));

  const domeCenterLocal = new THREE.Vector3(0, H * 0.55, 0);
  const bp = THREE.MathUtils.degToRad(A.bleb.polarDeg);
  const ba = THREE.MathUtils.degToRad(A.bleb.azimuthDeg);
  const blebDir = new THREE.Vector3(Math.sin(bp) * Math.cos(ba), Math.cos(bp), Math.sin(bp) * Math.sin(ba)).normalize();
  const blebSigma = A.bleb.radius / R;
  const n = noise3(77);

  const neckColor = new THREE.Color(0xd04a3c);
  const domeColor = new THREE.Color(0xe9a595);
  const thinColor = new THREE.Color(0xf2c6b8);
  const blebColor = new THREE.Color(0x8a1f2c);
  const atheroma = new THREE.Color(0xd9b56e);
  const c = new THREE.Color();
  const v = new THREE.Vector3();
  const dirFromCenter = new THREE.Vector3();

  let k = 0;
  for (let i = 0; i <= rows; i++) {
    const { x: r, y: h } = prof[i];
    for (let j = 0; j <= radial; j++) {
      const phi = (j / radial) * Math.PI * 2;
      v.set(r * Math.cos(phi), h, r * Math.sin(phi));

      // Bleb bump + irregularity, applied radially from the dome centre (dome part only).
      dirFromCenter.copy(v).sub(domeCenterLocal).normalize();
      const domeMask = THREE.MathUtils.smoothstep(h, 1.2, 2.6);
      const ang = Math.acos(THREE.MathUtils.clamp(dirFromCenter.dot(blebDir), -1, 1));
      const blebAmt = Math.exp(-((ang / blebSigma) ** 2)) * domeMask;
      const irr = n(v.x * 0.55, v.y * 0.55, v.z * 0.55) * A.irregularity * domeMask;
      v.addScaledVector(dirFromCenter, blebAmt * A.bleb.height + irr);

      positions[k * 3] = v.x;
      positions[k * 3 + 1] = v.y;
      positions[k * 3 + 2] = v.z;
      uvs[k * 2] = j / radial;
      uvs[k * 2 + 1] = i / rows;

      // Wall colour: neck like the parent artery → dome paler and thinner → bleb dark red.
      const tDome = THREE.MathUtils.smoothstep(h, 0.5, H * 0.7);
      c.copy(neckColor).lerp(domeColor, tDome);
      c.lerp(thinColor, THREE.MathUtils.smoothstep(h, H * 0.7, H) * 0.6);
      // Patchy yellowish atherosclerotic change near the neck.
      const ath = THREE.MathUtils.smoothstep(n(v.x * 0.35 + 3, v.y * 0.35, v.z * 0.35), 0.2, 0.75) * (1 - tDome * 0.6) * 0.32;
      c.lerp(atheroma, ath);
      c.lerp(blebColor, Math.min(1, blebAmt * 1.4));
      colors[k * 3] = c.r;
      colors[k * 3 + 1] = c.g;
      colors[k * 3 + 2] = c.b;

      pulseW[k] = THREE.MathUtils.smoothstep(h, 0.3, H * 0.6) + blebAmt * 0.8;
      k++;
    }
  }

  const indices: number[] = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j;
      const b = (i + 1) * (radial + 1) + j;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.setAttribute('aPulseW', new THREE.BufferAttribute(pulseW, 1));
  geom.setIndex(indices);
  geom.computeVertexNormals();

  const map = tex.map.clone();
  const normalMap = tex.normalMap.clone();
  map.repeat.set(2, 1);
  normalMap.repeat.set(2, 1);
  map.needsUpdate = normalMap.needsUpdate = true;

  const material = createTissueMaterial({
    color: 0xffffff,
    vertexColors: true,
    map,
    normalMap,
    normalScale: new THREE.Vector2(0.25, 0.25),
    roughness: 0.3,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    sheen: 0.5,
    sheenColor: new THREE.Color(0xff9c88),
    rimColor: 0xfbe0d6,
    rimAmount: 0.35,
    rimPower: 2.2,
    pulseAmp: A.pulse,
    pulseWeightAttr: true,
    // The clip blades squeeze the neck (two indentation slots, aneurysm-local space).
    indentable: true,
    envMapIntensity: 0.55,
  });

  const mesh = new THREE.Mesh(geom, material);
  mesh.name = 'aneurysm';
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.userData = { kind: 'aneurysm', id: 'aneurysm', label: 'IC-PC aneurysm' };
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  mesh.position.copy(neckCenter);
  mesh.updateMatrixWorld(true);

  const toWorld = (p: THREE.Vector3) => p.clone().applyMatrix4(mesh.matrixWorld);
  return {
    mesh,
    material,
    neckCenter: neckCenter.clone(),
    axis,
    neckRadius: rn,
    domeRadius: R,
    domeCenter: toWorld(domeCenterLocal),
    apex: toWorld(new THREE.Vector3(0, H, 0)),
    bleb: toWorld(domeCenterLocal.clone().addScaledVector(blebDir, R + A.bleb.height * 0.6)),
    icaT: A.icaT,
    height: H,
    radiusAt(h: number) {
      if (h <= prof[0].y) return prof[0].x;
      for (let i = 1; i < prof.length; i++) {
        if (h <= prof[i].y) {
          const a = prof[i - 1], b = prof[i];
          return a.x + ((b.x - a.x) * (h - a.y)) / Math.max(1e-6, b.y - a.y);
        }
      }
      return 0;
    },
    vAtHeight(h: number) {
      for (let i = 1; i < prof.length; i++) if (prof[i].y >= h) return (i - 1 + (h - prof[i - 1].y) / Math.max(1e-6, prof[i].y - prof[i - 1].y)) / rows;
      return 1;
    },
  };
}
