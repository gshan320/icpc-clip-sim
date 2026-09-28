import * as THREE from 'three';
import { NERVES } from '../config/anatomy';
import { createTissueMaterial, type TissueMaterial } from './materials';
import type { TextureSet } from './textures';
import { buildTube, splineFrom } from './tube';

/**
 * Cranial nerves in the field: the optic nerve (CN II) medial to the ICA and the oculomotor
 * nerve (CN III) in the depth, right under the dome of a posterolaterally pointing IC-PC aneurysm.
 * Nerves are white-ivory with longitudinal fascicles and do not pulse.
 */
export interface Nerve {
  id: 'optic' | 'oculomotor';
  label: string;
  curve: THREE.CatmullRomCurve3;
  mesh: THREE.Mesh;
  material: TissueMaterial;
}

function nerveMaterial(tex: TextureSet, length: number): TissueMaterial {
  const map = tex.map.clone();
  const normalMap = tex.normalMap.clone();
  const rep = Math.max(1, Math.round(length / 12));
  map.repeat.set(rep, 1);
  normalMap.repeat.set(rep, 1);
  map.needsUpdate = normalMap.needsUpdate = true;
  return createTissueMaterial({
    color: 0xeadbc6,
    map,
    normalMap,
    normalScale: new THREE.Vector2(0.3, 0.3),
    roughness: 0.42,
    clearcoat: 0.9,
    clearcoatRoughness: 0.12,
    sheen: 0.5,
    sheenColor: new THREE.Color(0xfff0dc),
    rimColor: 0xffffff,
    rimAmount: 0.15,
    envMapIntensity: 0.4,
    // Nerves sit on pulsating arteries and move a tiny bit with them.
    pulseAmp: 0.01,
  });
}

export function buildNerves(tex: TextureSet): { group: THREE.Group; nerves: Map<string, Nerve> } {
  const group = new THREE.Group();
  group.name = 'nerves';
  const nerves = new Map<string, Nerve>();

  // Optic nerve: flattened, broad face toward the microscope.
  {
    const cfg = NERVES.optic;
    const curve = splineFrom(cfg.points);
    const len = curve.getLength();
    const geom = buildTube(curve, {
      tubular: 120,
      radial: 36,
      radius: (t) => 1 - 0.06 * t,
      ellipse: [cfg.halfThickness, cfg.halfWidth],
      up: new THREE.Vector3(0, 0, 1),
      capStart: true,
      capEnd: true,
    });
    const material = nerveMaterial(tex, len);
    const mesh = new THREE.Mesh(geom, material);
    mesh.name = 'optic-nerve';
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData = { kind: 'nerve', id: 'optic', label: cfg.label };
    group.add(mesh);
    nerves.set('optic', { id: 'optic', label: cfg.label, curve, mesh, material });
  }

  // Oculomotor nerve: round, ~2.4 mm.
  {
    const cfg = NERVES.oculomotor;
    const curve = splineFrom(cfg.points);
    const len = curve.getLength();
    const geom = buildTube(curve, { tubular: 100, radial: 24, radius: () => cfg.radius, capStart: true, capEnd: true });
    const material = nerveMaterial(tex, len);
    const mesh = new THREE.Mesh(geom, material);
    mesh.name = 'oculomotor-nerve';
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData = { kind: 'nerve', id: 'oculomotor', label: cfg.label };
    group.add(mesh);
    nerves.set('oculomotor', { id: 'oculomotor', label: cfg.label, curve, mesh, material });
  }

  return { group, nerves };
}
