import * as THREE from 'three';
import { createSteelMaterial } from '../anatomy/materials';

/**
 * Procedural instrument models used as 3D cursors. Convention: the working tip is at the
 * origin and the shaft runs along +Y toward the surgeon's hand. The jaw / blade plane is XY.
 * The tool manager aligns +Y with the direction the instrument enters the field and turns the
 * jaw plane toward the microscope.
 */
export interface InstrumentModel {
  root: THREE.Group;
  /** 0 = closed, 1 = fully open (scissors, bipolar). */
  setJaw(open: number): void;
  /** 0…1 — bipolar current / energy glow. */
  setGlow(v: number): void;
  /** Whether this model is a shafted instrument (aligned to the entry direction) or a surface marker. */
  shafted: boolean;
}

const steel = createSteelMaterial();
const darkSteel = createSteelMaterial({ color: 0x8d9298, roughness: 0.42 });
const insulation = new THREE.MeshPhysicalMaterial({ color: 0x1d2a44, roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.2 });
const holeMat = new THREE.MeshBasicMaterial({ color: 0x060303 });

function mark(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.userData = { kind: 'cursor' };
    }
  });
}

/** Tapered shaft from y0 (radius r0) to y1 (radius r1). */
function shaft(y0: number, y1: number, r0: number, r1: number, mat: THREE.Material = steel): THREE.Mesh {
  const g = new THREE.CylinderGeometry(r1, r0, y1 - y0, 20, 1);
  g.translate(0, (y0 + y1) / 2, 0);
  return new THREE.Mesh(g, mat);
}

function base(root: THREE.Group, shafted = true): InstrumentModel {
  mark(root);
  return { root, setJaw() {}, setGlow() {}, shafted };
}

/** Frazier-type suction: a thin angled tube; the dark lumen shows at the tip. */
export function suctionModel(): InstrumentModel {
  const root = new THREE.Group();
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 7, 0),
    new THREE.Vector3(0, 12, 1.2),
    new THREE.Vector3(0, 20, 3.4),
    new THREE.Vector3(0, 110, 14),
  ]);
  root.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 120, 0.8, 20, false), darkSteel));
  const lumen = new THREE.Mesh(new THREE.CircleGeometry(0.55, 24), holeMat);
  lumen.rotation.x = Math.PI / 2;
  lumen.position.y = -0.01;
  root.add(lumen);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.68, 0.12, 10, 28), steel);
  rim.rotation.x = Math.PI / 2;
  root.add(rim);
  return base(root);
}

/** Micro-scissors: two fine curved blades on a slim shaft. */
export function scissorsModel(): InstrumentModel {
  const root = new THREE.Group();
  root.add(shaft(4.2, 110, 0.5, 1.0));
  const pivot = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), steel);
  pivot.position.y = 4.2;
  root.add(pivot);
  const bladeShape = new THREE.Shape();
  bladeShape.moveTo(0, 0);
  bladeShape.quadraticCurveTo(0.45, 1.8, 0.35, 4.2);
  bladeShape.lineTo(-0.3, 4.2);
  bladeShape.quadraticCurveTo(-0.15, 1.6, 0, 0);
  const bladeGeom = new THREE.ExtrudeGeometry(bladeShape, { depth: 0.16, bevelEnabled: false });
  bladeGeom.translate(0, -4.2, -0.08);
  const blades: THREE.Group[] = [];
  for (const s of [1, -1]) {
    const hinge = new THREE.Group();
    hinge.position.y = 4.2;
    const blade = new THREE.Mesh(bladeGeom, steel);
    blade.scale.x = s;
    blade.position.z = s * 0.09;
    hinge.add(blade);
    root.add(hinge);
    blades.push(hinge);
  }
  const m = base(root);
  m.setJaw = (open) => {
    const a = THREE.MathUtils.degToRad(12) * open;
    blades[0].rotation.z = a;
    blades[1].rotation.z = -a;
  };
  m.setJaw(1);
  return m;
}

/** Bipolar forceps: two insulated tines with bare tips; a spark glow shows current. */
export function bipolarModel(): InstrumentModel {
  const root = new THREE.Group();
  const L = 90;
  const tines: THREE.Group[] = [];
  for (const s of [1, -1]) {
    const tine = new THREE.Group();
    // Tine pivots at its far (hand) end.
    tine.position.y = L;
    const tipG = new THREE.BoxGeometry(0.38, 3, 0.45);
    tipG.translate(0, -L + 1.5, 0);
    const bodyG = new THREE.BoxGeometry(0.55, L - 3, 0.7);
    bodyG.translate(0, -(L - 3) / 2, 0);
    tine.add(new THREE.Mesh(tipG, steel));
    tine.add(new THREE.Mesh(bodyG, insulation));
    tine.userData.side = s;
    root.add(tine);
    tines.push(tine);
  }
  const glowTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,220,170,0.7)');
    g.addColorStop(1, 'rgba(255,160,90,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffe0b0, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
  glow.scale.setScalar(2.4);
  glow.position.y = 0.3;
  root.add(glow);
  const m = base(root);
  m.setJaw = (open) => {
    // Tip separation 0.15 mm (closed) … 1.8 mm (open).
    const sep = 0.15 + 1.65 * open;
    const a = Math.atan2(sep / 2 + 0.2, L);
    for (const t of tines) t.rotation.z = -t.userData.side * a;
    for (const t of tines) t.position.x = t.userData.side * 0.2;
  };
  m.setGlow = (v) => {
    (glow.material as THREE.SpriteMaterial).opacity = v;
    glow.scale.setScalar(1.6 + v * 1.4 + Math.random() * 0.4 * v);
  };
  m.setJaw(1);
  return m;
}

/** Rhoton-style round dissector: slim shaft, gently angled tip ending in a small spoon. */
export function dissectorModel(): InstrumentModel {
  const root = new THREE.Group();
  const tipCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.2, 0),
    new THREE.Vector3(0.9, 1.6, 0),
    new THREE.Vector3(1.2, 3.5, 0),
    new THREE.Vector3(1.2, 6, 0),
  ]);
  root.add(new THREE.Mesh(new THREE.TubeGeometry(tipCurve, 30, 0.32, 12, false), steel));
  const spoon = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 14), steel);
  spoon.scale.set(1, 0.7, 0.45);
  root.add(spoon);
  const s = shaft(6, 110, 0.4, 1.0);
  s.position.x = 1.2;
  root.add(s);
  return base(root);
}

/** Spatula tool: a surface reticle (the spatulas themselves are part of the scene). */
export function reticleModel(color = 0x5ad1e6): InstrumentModel {
  const root = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.07, 8, 48), mat);
  root.add(ring);
  for (let i = 0; i < 4; i++) {
    const tick = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.7, 0.05), mat);
    const a = (i * Math.PI) / 2;
    tick.position.set(Math.cos(a) * 2, Math.sin(a) * 2, 0);
    tick.rotation.z = a + Math.PI / 2;
    root.add(tick);
  }
  root.renderOrder = 10;
  const m = base(root, false);
  m.setGlow = (v) => mat.color.setHex(v > 0.5 ? 0xf3b34c : color);
  return m;
}
