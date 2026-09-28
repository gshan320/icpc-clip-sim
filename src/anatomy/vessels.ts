import * as THREE from 'three';
import { VESSELS, type VesselConfig, type VesselKind } from '../config/anatomy';
import { createTissueMaterial, type TissueMaterial } from './materials';
import type { TextureSet } from './textures';
import { buildTube, splineFrom } from './tube';

/**
 * Arteries built as tubes along splines. Each vessel keeps its centreline so later systems
 * (flow graph, Doppler, ICG, clip evaluation) can query "how close is this point to the ICA
 * lumen?" without touching the mesh.
 */
export interface Vessel {
  id: string;
  label: string;
  kind: VesselKind;
  config: VesselConfig;
  curve: THREE.CatmullRomCurve3;
  length: number;
  mesh: THREE.Mesh;
  material: TissueMaterial;
  radiusAt: (t: number) => number;
  /** Pre-sampled centreline points for fast proximity queries. */
  samples: THREE.Vector3[];
}

const COLORS: Record<VesselKind, { color: number; rim: number; rimAmount: number }> = {
  // Arteries: bright oxygenated red seen through a thin, slightly translucent wall.
  artery: { color: 0xc7392d, rim: 0xf4c3b4, rimAmount: 0.42 },
  // Veins: darker, bluish-purple deoxygenated blood behind a very thin wall.
  vein: { color: 0x5b2446, rim: 0x9c6f8f, rimAmount: 0.3 },
  perforator: { color: 0xba3a30, rim: 0xf0b8a8, rimAmount: 0.35 },
};

export function createVesselMaterial(kind: VesselKind, tex: TextureSet, length: number, pulse: number, flareSide?: 1 | -1): TissueMaterial {
  const c = COLORS[kind];
  const map = tex.map.clone();
  const normalMap = tex.normalMap.clone();
  // uv.x runs along the vessel; repeat the wall texture about every 9 mm.
  const rep = Math.max(1, Math.round(length / 9));
  map.repeat.set(rep, 1);
  normalMap.repeat.set(rep, 1);
  map.needsUpdate = normalMap.needsUpdate = true;
  return createTissueMaterial({
    color: c.color,
    map,
    normalMap,
    normalScale: new THREE.Vector2(0.35, 0.35),
    roughness: kind === 'vein' ? 0.3 : 0.36,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
    sheen: 0.4,
    sheenColor: new THREE.Color(0xff8a70),
    sheenRoughness: 0.5,
    rimColor: c.rim,
    rimAmount: c.rimAmount,
    rimPower: 2.4,
    pulseAmp: pulse,
    // Pulse wave travels down the vessel (visibly exaggerated for teaching).
    pulseDelay: length * 0.005,
    flareSide,
    // Arteries can be pinched by clips (two indentation slots, object space = world space).
    indentable: kind !== 'vein',
    envMapIntensity: 0.5,
  });
}

export function buildVessels(tex: TextureSet): { group: THREE.Group; vessels: Map<string, Vessel> } {
  const group = new THREE.Group();
  group.name = 'vessels';
  const vessels = new Map<string, Vessel>();

  // Vessels that branch at their distal end are left open there; the junction blob closes them.
  const splitsAtEnd = new Set(['ica', 'm1']);
  for (const cfg of VESSELS) {
    const curve = splineFrom(cfg.points);
    const length = curve.getLength();
    const [ra, rb] = cfg.radius;
    const radiusAt = (t: number) => ra + (rb - ra) * t;
    const geom = buildTube(curve, {
      tubular: cfg.tubular ?? 80,
      radial: cfg.radial ?? 20,
      radius: radiusAt,
      capStart: true,
      capEnd: !splitsAtEnd.has(cfg.id),
    });
    const material = createVesselMaterial(cfg.kind, tex, length, cfg.pulse);
    const mesh = new THREE.Mesh(geom, material);
    mesh.name = cfg.id;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = { kind: 'vessel', id: cfg.id, label: cfg.label };
    group.add(mesh);

    const samples: THREE.Vector3[] = [];
    const n = Math.max(24, Math.ceil(length * 2));
    for (let i = 0; i <= n; i++) samples.push(curve.getPointAt(i / n));

    vessels.set(cfg.id, { id: cfg.id, label: cfg.label, kind: cfg.kind, config: cfg, curve, length, mesh, material, radiusAt, samples });
  }

  // Smooth the carotid bifurcation (ICA → M1 + A1) and the M1 bifurcation (→ M2 trunks) with a
  // small "saddle" blob so three tubes don't meet with a hard seam.
  const addJunction = (fromId: string) => {
    const v = vessels.get(fromId)!;
    const end = v.curve.getPointAt(1);
    const radius = v.radiusAt(1) * 0.97;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 40, 28), v.material);
    mesh.position.copy(end);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData = { kind: 'vessel', id: fromId, label: v.label };
    group.add(mesh);
  };
  addJunction('ica');
  addJunction('m1');

  return { group, vessels };
}

/**
 * Closest point on a vessel centreline to `p`.
 * Returns distance from the centreline, parameter t, and the vessel radius there.
 */
export function closestOnVessel(v: Vessel, p: THREE.Vector3): { dist: number; t: number; radius: number } {
  let best = Infinity;
  let bi = 0;
  for (let i = 0; i < v.samples.length; i++) {
    const d = v.samples[i].distanceToSquared(p);
    if (d < best) {
      best = d;
      bi = i;
    }
  }
  const t = bi / (v.samples.length - 1);
  return { dist: Math.sqrt(best), t, radius: v.radiusAt(t) };
}
