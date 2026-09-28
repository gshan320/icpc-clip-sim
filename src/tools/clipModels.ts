import * as THREE from 'three';

/**
 * Aneurysm clip models. Local frame: the vessel / neck runs along ±Z, the clip closes along X,
 * the blades point down −Y (into the field, away from the microscope) and the spring head is
 * at +Y. `setOpen(0…1)` spreads the blades apart.
 */
export interface ClipModel {
  root: THREE.Group;
  setOpen(open: number): void;
  /** Half-gap between the blades when closed (mm). */
  closedHalfGap: number;
  bladeLength: number;
}

/** Temporary clips are gold-anodised so they're never confused with permanent ones. */
export const goldMaterial = new THREE.MeshPhysicalMaterial({
  color: 0xe8c36a,
  metalness: 0.55,
  roughness: 0.3,
  clearcoat: 0.6,
  clearcoatRoughness: 0.15,
  envMapIntensity: 3,
  emissive: 0x2a1c05,
});

/**
 * Yasargil-type temporary clip sized for a vessel of radius r: two flat blades, limbs crossing
 * to a coil spring.
 */
export function temporaryClipModel(r: number): ClipModel {
  const root = new THREE.Group();
  const L = 2 * r + 2.6;
  const top = r + 0.9;
  const bladeGeom = new THREE.BoxGeometry(0.42, L, 1.35);
  bladeGeom.translate(0, top - L / 2, 0);
  // Round the blade tips a little.
  const tipGeom = new THREE.CylinderGeometry(0.21, 0.21, 1.35, 12);
  tipGeom.rotateX(Math.PI / 2);
  tipGeom.translate(0, top - L, 0);
  const blades: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(bladeGeom, goldMaterial), new THREE.Mesh(tipGeom, goldMaterial));
    // Limb from the blade top to the spring.
    const limb = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 2.2, 10), goldMaterial);
    limb.position.set(-side * 0.35, top + 1.0, 0);
    limb.rotation.z = side * 0.35;
    g.add(limb);
    g.userData.side = side;
    root.add(g);
    blades.push(g);
  }
  const coil = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.3, 12, 32), goldMaterial);
  coil.position.y = top + 2.6;
  root.add(coil);
  const closedHalfGap = 0.36;
  const model: ClipModel = {
    root,
    closedHalfGap,
    bladeLength: L,
    setOpen(open) {
      const half = closedHalfGap + open * (r + 0.9);
      for (const b of blades) b.position.x = b.userData.side * (half + 0.21);
    },
  };
  model.setOpen(1);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.userData = { kind: 'instrument', id: 'tempclip', label: 'Temporary clip' };
    }
  });
  return model;
}

/** Permanent clips: titanium alloy, silver-grey. */
export const titaniumMaterial = new THREE.MeshPhysicalMaterial({
  color: 0xb4bcc4,
  metalness: 0.6,
  roughness: 0.28,
  clearcoat: 0.5,
  clearcoatRoughness: 0.15,
  envMapIntensity: 2.8,
  emissive: 0x101418,
});

export const ghostMaterial = new THREE.MeshPhysicalMaterial({
  color: 0xcfe9f0,
  metalness: 0.3,
  roughness: 0.35,
  transparent: true,
  opacity: 0.42,
  depthWrite: false,
  depthTest: false,
  emissive: 0x2a6a78,
  emissiveIntensity: 0.7,
});

/** Parts of a placed clip hidden behind tissue are shown as a faint silhouette. */
export const xrayMaterial = new THREE.MeshBasicMaterial({
  color: 0x9fdcea,
  transparent: true,
  opacity: 0.28,
  depthWrite: false,
  depthFunc: THREE.GreaterDepth,
});

export interface PermanentClip {
  root: THREE.Group;
  setOpen(open: number): void;
  setGhost(ghost: boolean): void;
  /** Direction (clip-local) in which the spring head sits behind the hinge — toward the surgeon. */
  setHeadDir(dir: THREE.Vector3): void;
  length: number;
}

/**
 * Yasargil-type permanent aneurysm clip in its own frame: blades from the hinge (x = 0) to the
 * tips (x = L) along +X, blade faces closing along ±Z, +Y = dome axis. Curved clips rise toward
 * the tips (same law as clipEval.bladeLift). The limbs cross from the blade roots to a coil
 * spring that sits up toward the microscope, as the clip is seen in its applier.
 */
export function permanentClipModel(length: number, lift: number, openHalf: number): PermanentClip {
  const root = new THREE.Group();
  const closedHalf = 0.24;
  const liftAt = (x: number) => {
    const u = Math.max(0, (x - (length - 2.2)) / 2.2);
    return lift * u * u;
  };
  const blades: THREE.Mesh[] = [];
  const limbs: THREE.Mesh[] = [];
  const meshes: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 20; i++) {
      const x = (length * i) / 20;
      pts.push(new THREE.Vector3(x, liftAt(x), 0));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    // Flat blade: 1.2 mm tall (dome axis) × 0.4 mm thick.
    const geom = new THREE.TubeGeometry(curve, 40, 1, 10, false);
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y0 = liftAt(x);
      pos.setY(i, y0 + (pos.getY(i) - y0) * 0.6);
      pos.setZ(i, pos.getZ(i) * 0.2);
    }
    geom.computeVertexNormals();
    const blade = new THREE.Mesh(geom, titaniumMaterial);
    blade.userData.side = side;
    root.add(blade);
    blades.push(blade);
    meshes.push(blade);
    const limbGeom = new THREE.CylinderGeometry(0.3, 0.3, 1, 10);
    limbGeom.translate(0, 0.5, 0);
    const limb = new THREE.Mesh(limbGeom, titaniumMaterial);
    limb.userData.side = side;
    root.add(limb);
    limbs.push(limb);
    meshes.push(limb);
  }
  const coil = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.34, 12, 32), titaniumMaterial);
  root.add(coil);
  meshes.push(coil);
  for (const m of meshes) {
    m.castShadow = true;
    m.renderOrder = 6;
    m.userData = { ...m.userData, kind: 'instrument', id: 'aneurysm-clip', label: 'Aneurysm clip' };
    // X-ray twin (drawn only where the clip is behind something).
    const x = new THREE.Mesh(m.geometry, xrayMaterial);
    x.userData = { kind: 'cursor' };
    x.renderOrder = 7;
    x.raycast = () => {};
    m.add(x);
  }
  const headDir = new THREE.Vector3(-1, 0, 0);
  let half = closedHalf + openHalf;
  const Y = new THREE.Vector3(0, 1, 0);
  const layout = () => {
    for (const b of blades) b.position.z = (b.userData.side as number) * half;
    const coilPos = headDir.clone().multiplyScalar(4.2);
    coil.position.copy(coilPos);
    coil.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1));
    coil.lookAt(coilPos.clone().add(new THREE.Vector3(0, 0, 1)));
    for (const l of limbs) {
      const side = l.userData.side as number;
      const start = new THREE.Vector3(0, 0, side * half);
      // Limbs cross over to the opposite side of the spring (that is what makes the clip close).
      const end = coilPos.clone().add(new THREE.Vector3(0, 0, -side * 0.9));
      const d = end.clone().sub(start);
      l.position.copy(start);
      l.scale.set(1, d.length(), 1);
      l.quaternion.setFromUnitVectors(Y, d.normalize());
    }
  };
  const clip: PermanentClip = {
    root,
    length,
    setOpen(open) {
      half = closedHalf + open * openHalf;
      layout();
    },
    setGhost(ghost) {
      for (const m of meshes) {
        m.material = ghost ? ghostMaterial : titaniumMaterial;
        for (const c of m.children) c.visible = !ghost;
      }
    },
    setHeadDir(dir) {
      headDir.copy(dir).normalize();
      layout();
    },
  };
  clip.setOpen(1);
  return clip;
}
