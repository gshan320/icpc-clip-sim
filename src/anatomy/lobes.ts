import * as THREE from 'three';
import { LOBES, SYLVIAN_VEINS, type LobeConfig } from '../config/anatomy';
import { PHYSIOLOGY } from '../config/sim';
import { createTissueMaterial, type TissueMaterial } from './materials';
import { fbm3, noise3 } from './noise';
import type { TextureSet } from './textures';
import { buildTube } from './tube';
import { createVesselMaterial } from './vessels';

/**
 * Frontal and temporal lobes.
 *
 * Each lobe starts as a superquadric — flat-ish cortical surface on top, rounded opercular lip
 * facing the fissure — and gyri and sulci are carved with domain-warped noise (a sulcus is where
 * the noise crosses zero → narrow grooves, broad rounded gyri between them).
 * The two lobes face each other across the sylvian fissure. Opening the fissure moves them
 * apart and splays their lips (a simplification of CSF release and gentle retraction).
 */
export interface Lobe {
  name: 'frontal' | 'temporal';
  config: LobeConfig;
  /** Group moved when the fissure opens. Veins and spatulas ride along as children. */
  group: THREE.Group;
  mesh: THREE.Mesh;
  material: TissueMaterial;
  /** +1 for frontal (moves up, +Y), -1 for temporal (moves down). */
  side: 1 | -1;
}

export function createCortexMaterial(tex: TextureSet, repeat: [number, number], flareSide?: 1 | -1): TissueMaterial {
  const map = tex.map.clone();
  const normalMap = tex.normalMap.clone();
  const roughnessMap = tex.roughnessMap!.clone();
  for (const t of [map, normalMap, roughnessMap]) {
    t.repeat.set(repeat[0], repeat[1]);
    t.needsUpdate = true;
  }
  return createTissueMaterial({
    color: 0xffffff,
    vertexColors: true,
    map,
    normalMap,
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughnessMap,
    roughness: 1,
    clearcoat: 1,
    clearcoatRoughness: 0.1,
    sheen: 0.6,
    sheenColor: new THREE.Color(0xff9b85),
    sheenRoughness: 0.45,
    rimColor: 0xffd6c8,
    rimAmount: 0.18,
    rimPower: 3,
    pulseAmp: PHYSIOLOGY.brainPulseAmp,
    respAmp: PHYSIOLOGY.brainRespAmp,
    indentable: true,
    flareSide,
    envMapIntensity: 0.35,
  });
}

/** Signed sulcal displacement at point p (mm) — negative inside sulci. Also returns a 0…1 sulcus mask. */
function makeGyralField(cfg: LobeConfig) {
  const n = noise3(cfg.seed);
  const warp = noise3(cfg.seed + 1);
  const bump = noise3(cfg.seed + 2);
  const f = cfg.gyrusFrequency;
  return (p: THREE.Vector3) => {
    // Domain warp gives gyri their meandering, worm-like shape.
    const wx = fbm3(warp, p.x * 0.03, p.y * 0.03, p.z * 0.03, 2) * 9;
    const wy = fbm3(warp, p.y * 0.03 + 5.2, p.z * 0.03, p.x * 0.03, 2) * 9;
    const wz = fbm3(warp, p.z * 0.03 + 9.1, p.x * 0.03, p.y * 0.03, 2) * 9;
    const v = n((p.x + wx) * f, (p.y + wy) * f, (p.z + wz) * f);
    // Narrow grooves where v ≈ 0.
    const sulcus = Math.exp(-(v * v) / 0.012);
    // Gyral crowns are gently rounded.
    const crown = 1 - Math.min(1, Math.abs(v) * 1.6);
    const fine = fbm3(bump, p.x * 0.35, p.y * 0.35, p.z * 0.35, 2) * 0.18;
    return { disp: -cfg.sulcusDepth * sulcus + crown * 0.35 + fine, sulcus };
  };
}

/** Portion of the lobe length (|x| / rx) with a constant cross-section before the ends round off. */
const STRAIGHT = 0.62;

/**
 * Map a unit-sphere direction onto the lobe surface. Across the fissure (y–z) the section is a
 * superellipse (flat cortex, rounded opercular lip); along the fissure (x) the section stays
 * constant through the field of view and rounds off at the far ends. A constant section keeps
 * the two lips parallel, so a closed fissure is closed everywhere.
 */
function lobeSurface(u: THREE.Vector3, r: [number, number, number], p: number, out: THREE.Vector3, nrm: THREE.Vector3) {
  const yz = Math.hypot(u.y, u.z) || 1e-6;
  const cy = u.y / yz, cz = u.z / yz;
  // Superellipse radius in this y–z direction.
  const r2d = (Math.abs(cy / r[1]) ** p + Math.abs(cz / r[2]) ** p) ** (-1 / p);
  const ax = Math.abs(u.x);
  const e = ax > STRAIGHT ? (ax - STRAIGHT) / (1 - STRAIGHT) : 0;
  const cap = Math.sqrt(Math.max(0, 1 - e * e));
  out.set(u.x * r[0], cy * r2d * cap, cz * r2d * cap);
  // Approximate normal: superellipse gradient in y–z, tilted toward ±x on the rounded ends.
  const py = cy * r2d, pz = cz * r2d;
  const gy = (p * Math.sign(py) * Math.abs(py / r[1]) ** (p - 1)) / r[1];
  const gz = (p * Math.sign(pz) * Math.abs(pz / r[2]) ** (p - 1)) / r[2];
  const gl = Math.hypot(gy, gz) || 1;
  nrm.set(Math.sign(u.x) * e * 1.5, (gy / gl) * cap, (gz / gl) * cap).normalize();
}

/**
 * Gentle meander of the fissure line (mm, along y) as a function of x. Applied to both lips so
 * they still meet when closed.
 */
function fissureMeander(x: number): number {
  return 0.9 * Math.sin(x * 0.12 + 0.4) + 0.45 * Math.sin(x * 0.29 + 1.7);
}

/**
 * How far (mm) the lobe surface recedes from its lip at height zWorld, for the undeformed shape.
 * Used to size the membranes that bridge the fissure. (Uses the same superellipse section.)
 */
export function lipRecession(cfg: LobeConfig, zWorld: number): number {
  const t = Math.min(0.999, Math.abs(zWorld - cfg.center[2]) / cfg.radii[2]);
  const p = cfg.exponent;
  return cfg.radii[1] * (1 - (1 - t ** p) ** (1 / p));
}

function buildLobeGeometry(cfg: LobeConfig): THREE.BufferGeometry {
  const [ws, hs] = cfg.segments;
  const g = new THREE.SphereGeometry(1, ws, hs);
  // Poles along X (medial ↔ lateral) so they sit far outside the field of view.
  g.rotateZ(-Math.PI / 2);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const field = makeGyralField(cfg);
  const r = cfg.radii;
  const pe = cfg.exponent;
  const unit = new THREE.Vector3();
  const p = new THREE.Vector3();
  const world = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const center = new THREE.Vector3(...cfg.center);
  const base = new THREE.Color(0xffffff);
  const sulcusTint = new THREE.Color(0x9a4a44);
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    unit.fromBufferAttribute(pos, i).normalize();
    lobeSurface(unit, r, pe, p, nrm);
    // Meander the lip region of both lobes together.
    const lipW = Math.exp(-Math.max(0, r[1] - Math.abs(p.y)) / 8) * (1 - Math.abs(unit.x) ** 4);
    p.y += fissureMeander(p.x + cfg.center[0]) * lipW;
    world.copy(p).add(center);
    const { disp, sulcus: rawSulcus } = field(world);
    // The lips of the fissure (surfaces facing each other, |n.y| → 1) are smooth, rounded
    // opercular gyri: soften the sulci there so the corridor edge isn't jagged.
    const lip = THREE.MathUtils.smoothstep(Math.abs(nrm.y), 0.55, 0.95);
    const k = 1 - 0.75 * lip;
    const sulcus = rawSulcus * k;
    p.addScaledVector(nrm, disp * k);
    pos.setXYZ(i, p.x, p.y, p.z);
    // Sulci look darker and redder: they are shadowed and full of pial vessels.
    c.copy(base).lerp(sulcusTint, Math.min(1, sulcus * 0.85));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export function buildLobes(cortex: TextureSet, vesselTex: TextureSet): { frontal: Lobe; temporal: Lobe } {
  const make = (name: 'frontal' | 'temporal', cfg: LobeConfig, side: 1 | -1): Lobe => {
    const group = new THREE.Group();
    group.name = `${name}-lobe`;
    group.position.set(...cfg.center);
    const geom = buildLobeGeometry(cfg);
    geom.computeBoundsTree();
    // ~40 mm per texture tile around and along the ellipsoid.
    const circ = Math.PI * (cfg.radii[1] + cfg.radii[2]);
    const len = Math.PI * cfg.radii[0];
    const material = createCortexMaterial(cortex, [Math.round(len / 38), Math.round(circ / 38)], side);
    const mesh = new THREE.Mesh(geom, material);
    mesh.name = `${name}-cortex`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = { kind: 'brain', id: name, label: name === 'frontal' ? 'Frontal lobe' : 'Temporal lobe' };
    group.add(mesh);
    return { name, config: cfg, group, mesh, material, side };
  };

  const frontal = make('frontal', LOBES.frontal, 1);
  const temporal = make('temporal', LOBES.temporal, -1);
  addSylvianVeins(temporal, vesselTex);
  return { frontal, temporal };
}

/**
 * Cast a ray in the lobe's local space onto its (displaced) cortex and return the hit.
 */
export function projectOntoLobe(lobe: Lobe, origin: THREE.Vector3, dir: THREE.Vector3): THREE.Intersection | null {
  const ray = new THREE.Raycaster(origin, dir.clone().normalize(), 0, 80);
  (ray as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
  lobe.mesh.updateMatrixWorld();
  // The lobe mesh has an identity transform inside its group, so we can raycast in group space
  // by temporarily ignoring the group transform.
  const saved = lobe.mesh.matrixWorld.clone();
  lobe.mesh.matrixWorld.identity();
  const hits = ray.intersectObject(lobe.mesh, false);
  lobe.mesh.matrixWorld.copy(saved);
  return hits[0] ?? null;
}

/**
 * Drop a point onto the temporal cortex from above (lobe-local), `lipDist` mm from the lip.
 * Returns the surface point lifted so the vein sits half-embedded in the pia.
 */
function onTemporalSurface(lobe: Lobe, xWorld: number, lipDist: number, radius: number): THREE.Vector3 | null {
  const cfg = lobe.config;
  const lipY = cfg.radii[1]; // temporal lip is at local +y
  const origin = new THREE.Vector3(xWorld - cfg.center[0], lipY - lipDist, 60);
  const hit = projectOntoLobe(lobe, origin, new THREE.Vector3(0, 0, -1));
  if (!hit) return null;
  const n = hit.face ? hit.face.normal.clone() : new THREE.Vector3(0, 0, 1);
  return hit.point.clone().addScaledVector(n, radius * 0.55);
}

/**
 * Superficial sylvian veins on the temporal lip of the fissure. Kept on the temporal side,
 * as the fissure is opened on the frontal side of them.
 */
function addSylvianVeins(temporal: Lobe, tex: TextureSet) {
  const V = SYLVIAN_VEINS;
  const addVein = (points: THREE.Vector3[], r0: number, r1: number) => {
    if (points.length < 3) return;
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    const len = curve.getLength();
    const geom = buildTube(curve, { tubular: Math.ceil(len * 3), radial: 20, radius: (t) => r0 + (r1 - r0) * t, capStart: true, capEnd: true });
    const mat = createVesselMaterial('vein', tex, len, 0.004, -1);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData = { kind: 'vein', id: 'sylvian-vein', label: 'Superficial sylvian vein' };
    temporal.group.add(mesh);
  };

  const main: THREE.Vector3[] = [];
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const x = V.xRange[0] + ((V.xRange[1] - V.xRange[0]) * i) / steps;
    const wobble = Math.sin(i * 1.3) * 0.9 + Math.sin(i * 0.47) * 0.7;
    const p = onTemporalSurface(temporal, x, Math.max(1.2, V.lipDistance + wobble), V.radius);
    if (p) main.push(p);
  }
  addVein(main, V.radius * 0.8, V.radius * 1.1);

  for (const [x0, x1, d0, d1, r] of V.tributaries) {
    const tp: THREE.Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const p = onTemporalSurface(temporal, x0 + (x1 - x0) * t, d0 + (d1 - d0) * t, r);
      if (p) tp.push(p);
    }
    addVein(tp, r * 0.6, r);
  }
}
