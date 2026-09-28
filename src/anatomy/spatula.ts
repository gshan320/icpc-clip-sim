import * as THREE from 'three';
import { FISSURE, SPATULAS } from '../config/anatomy';
import { createSteelMaterial } from './materials';
import { projectOntoLobe, type Lobe } from './lobes';

/**
 * Brain spatulas: thin malleable steel blades on a self-retaining arm. In modern practice the
 * fissure is opened mostly by sharp arachnoid dissection and CSF release; the spatulas only
 * hold the lobes gently apart. Excessive or prolonged pressure causes retraction injury
 * (venous infarction, contusion), so the simulator tracks retraction pressure.
 */
export interface Spatula {
  lobe: Lobe;
  group: THREE.Group;
  blade: THREE.Mesh;
  /** Contact point at the blade tip and a point higher up the wall (lobe-local, undeformed). */
  tip: THREE.Vector3;
  top: THREE.Vector3;
  /** Outward cortex normal at the contact (lobe-local). */
  normal: THREE.Vector3;
  /**
   * Pose the blade. `inserted` 0…1 slides it in along the wall, `retraction` 0…1 is how hard it
   * holds the lobe back, `flare` is the current lip flare (mm).
   */
  update(inserted: number, retraction: number, flare: number): void;
}

function bladeGeometry(): THREE.BufferGeometry {
  const { width, tipWidth, length, thickness } = SPATULAS;
  const shape = new THREE.Shape();
  const steps = 24;
  const halfAt = (y: number) => THREE.MathUtils.lerp(tipWidth, width, Math.min(1, y / (length * 0.5))) / 2;
  const tipR = tipWidth / 2;
  // Rounded tip at y = 0, blade runs to y = length.
  shape.moveTo(-tipR, tipR);
  shape.absarc(0, tipR, tipR, Math.PI, 0, true);
  for (let i = 1; i <= steps; i++) {
    const y = tipR + ((length - tipR) * i) / steps;
    shape.lineTo(halfAt(y), y);
  }
  for (let i = steps; i >= 1; i--) {
    const y = tipR + ((length - tipR) * i) / steps;
    shape.lineTo(-halfAt(y), y);
  }
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: 0.08,
    bevelSize: 0.1,
    bevelSegments: 2,
    curveSegments: 20,
  });
  g.translate(0, 0, -thickness / 2);
  // Slight curvature: blade bends away from the brain toward the handle.
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    pos.setZ(i, pos.getZ(i) + 0.006 * y * y);
  }
  g.computeVertexNormals();
  return g;
}

export function buildSpatula(lobe: Lobe, tipXZ: [number, number]): Spatula {
  const cfg = lobe.config;
  const c = new THREE.Vector3(...cfg.center);
  const side = lobe.side;
  const L = SPATULAS.length;
  // Find the wall of the lobe facing the fissure at the tip depth and ~14 mm more superficial.
  const wallHit = (x: number, z: number) => {
    const origin = new THREE.Vector3(x, -3 * side, z).sub(c);
    const hit = projectOntoLobe(lobe, origin, new THREE.Vector3(0, side, 0));
    if (!hit) return { p: new THREE.Vector3(x, 0, z).sub(c), n: new THREE.Vector3(0, -side, 0) };
    return { p: hit.point.clone(), n: hit.face ? hit.face.normal.clone() : new THREE.Vector3(0, -side, 0) };
  };
  const a = wallHit(tipXZ[0], tipXZ[1]);
  const b = wallHit(tipXZ[0] + 2, tipXZ[1] + 10);
  const baseNormal = a.n.clone().add(b.n).normalize();

  const group = new THREE.Group();
  group.name = `spatula-${lobe.name}`;
  const steel = createSteelMaterial();
  const blade = new THREE.Mesh(bladeGeometry(), steel);
  blade.castShadow = true;
  blade.receiveShadow = true;
  blade.userData = { kind: 'instrument', id: `spatula-${lobe.name}`, label: 'Brain spatula' };
  group.add(blade);

  // Malleable arm: continues past the top of the blade, bends over the lip of the lobe and
  // leaves the field toward the surgeon and laterally (to the retractor bar on the head frame).
  // Built in blade-local space: +Y along the blade, +Z away from the cortex.
  const arm = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, L - 2, 0.5),
    new THREE.Vector3(0, L + 2, 1.2),
    new THREE.Vector3(0, L + 6, -4),
    new THREE.Vector3(0, L + 10, -14),
    new THREE.Vector3(0, L + 14, -40),
  ]);
  const armMesh = new THREE.Mesh(new THREE.TubeGeometry(arm, 80, 0.8, 16, false), steel);
  armMesh.castShadow = true;
  armMesh.userData = blade.userData;
  group.add(armMesh);
  group.visible = false;
  lobe.group.add(group);

  const u = lobe.material.userData.tissue;
  const slot = side > 0 ? 0 : 1;
  const [z0, z1] = FISSURE.flareZ;
  const axis = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const xAxis = new THREE.Vector3();
  const top = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const baseAxis = b.p.clone().sub(a.p).normalize();

  const spatula: Spatula = {
    lobe,
    group,
    blade,
    tip: a.p,
    top: b.p,
    normal: baseNormal,
    update(inserted, retraction, flare) {
      group.visible = inserted > 0.001;
      // The top of the blade follows the splayed lip and is levered a little further by retraction.
      const zTop = b.p.z + cfg.center[2];
      const h = THREE.MathUtils.smoothstep(zTop, z0, z1);
      top.copy(b.p);
      top.y += side * (flare * h + retraction * 1.6);
      axis.copy(top).sub(a.p).normalize();
      normal.copy(baseNormal).addScaledVector(axis, -baseNormal.dot(axis)).normalize();
      xAxis.crossVectors(axis, normal).normalize();
      m.makeBasis(xAxis, axis, normal);
      group.quaternion.setFromRotationMatrix(m);
      group.position
        .copy(a.p)
        .addScaledVector(normal, SPATULAS.thickness / 2 - SPATULAS.indent * 0.5 - retraction * 0.4)
        .addScaledVector(axis, -1.2 + (1 - inserted) * 28);
      // Press a dimple into the cortex under the blade (in the undeformed lobe space).
      const on = inserted > 0.95;
      u.uIndentA.value[slot].copy(a.p);
      u.uIndentB.value[slot].copy(a.p).addScaledVector(baseAxis, L);
      u.uIndentDir.value[slot].copy(baseNormal).negate();
      u.uIndentRadius.value[slot] = SPATULAS.width * 0.75;
      u.uIndentDepth.value[slot] = on ? SPATULAS.indent + 0.3 + retraction * 0.9 : 0;
    },
  };
  spatula.update(0, 0, 0);
  return spatula;
}
