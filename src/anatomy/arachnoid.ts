import gsap from 'gsap';
import * as THREE from 'three';
import { ARACHNOID, FISSURE, LOBES, type ArachnoidPatchConfig } from '../config/anatomy';
import { lipRecession } from './lobes';
import { createTissueMaterial, type TissueMaterial } from './materials';
import { mulberry32, noise3 } from './noise';
import type { TextureSet } from './textures';

/**
 * Arachnoid membranes: the thin, translucent, web-like layer that bridges the sylvian fissure
 * and wraps the basal cisterns (carotid, chiasmatic, crural). The surgeon splits it sharply with
 * micro-scissors to let CSF out and open the working corridors — the brain then relaxes and
 * separates with minimal retraction.
 *
 * Each patch is an independent, cuttable segment.
 */
export interface ArachnoidPatch {
  id: string;
  config: ArachnoidPatchConfig;
  mesh: THREE.Mesh;
  material: TissueMaterial;
  cut: boolean;
  /** Blunt-dissection progress (dissector), 0…1 — reaching 1 parts the membrane. */
  tear: number;
}

function patchGeometry(cfg: ArachnoidPatchConfig, seed: number): THREE.BufferGeometry {
  const [w, h] = cfg.size;
  // Spanning patches are unit-height and scaled with the fissure gap.
  const g = new THREE.PlaneGeometry(w, cfg.spansFissure ? 1 : h, 28, 28);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 4);
  const n = noise3(seed);
  const hh = cfg.spansFissure ? 1 : h;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const u = x / w + 0.5, v = y / hh + 0.5;
    // Membrane sags a little into the depth and has a gentle ripple.
    const sag = -Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * (cfg.spansFissure ? 1.1 : 0.6);
    // Spanning patches are unit-height and later stretched ~10×: sample the ripple at the
    // stretched scale so it stays isotropic (otherwise it turns into vertical streaks).
    const ys = cfg.spansFissure ? y * 10 : y;
    const ripple = n(x * 0.35, ys * 0.35, seed) * (cfg.spansFissure ? 0.12 : 0.35);
    pos.setZ(i, sag + ripple);
    // Irregular, feathered outline instead of a hard rectangle (vertex alpha).
    const edge = Math.min(u, 1 - u, v, 1 - v) * 2; // 0 at edge, 1 at centre
    const wob = n(x * 0.5 + 10, y * 0.5, seed + 3) * 0.18;
    const a = THREE.MathUtils.smoothstep(edge + wob, 0.05, cfg.spansFissure ? 0.35 : 0.55);
    colors.set([1, 1, 1, a], i * 4);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  g.computeVertexNormals();
  return g;
}

export function buildArachnoid(tex: TextureSet): { group: THREE.Group; patches: Map<string, ArachnoidPatch> } {
  const group = new THREE.Group();
  group.name = 'arachnoid';
  const patches = new Map<string, ArachnoidPatch>();
  const rand = mulberry32(99);

  ARACHNOID.forEach((cfg, i) => {
    const alphaMap = tex.alphaMap!.clone();
    const normalMap = tex.normalMap.clone();
    const rep = new THREE.Vector2(cfg.size[0] / 10, cfg.size[1] / 10);
    alphaMap.repeat.copy(rep);
    normalMap.repeat.copy(rep);
    alphaMap.offset.set(rand(), rand());
    normalMap.offset.copy(alphaMap.offset);
    alphaMap.needsUpdate = normalMap.needsUpdate = true;
    const material = createTissueMaterial({
      color: 0xf3ece8,
      vertexColors: true,
      alphaMap,
      normalMap,
      normalScale: new THREE.Vector2(0.4, 0.4),
      transparent: true,
      opacity: 0.68,
      depthWrite: false,
      side: THREE.DoubleSide,
      roughness: 0.18,
      clearcoat: 1,
      clearcoatRoughness: 0.04,
      rimColor: 0xffffff,
      rimAmount: 0.35,
      rimPower: 2,
      pulseAmp: 0.02,
      respAmp: 0.03,
      envMapIntensity: 0.5,
      cuttable: true,
      toolDeform: false,
    });
    const tu = material.userData.tissue;
    if (cfg.spansFissure) {
      tu.uCutRetract.value = 0.5;
      tu.uCutGap.value = 0.06;
      tu.uCutSoft.value = 0.05;
    } else {
      tu.uCutRetract.value = cfg.size[1] * 0.5;
      tu.uCutGap.value = 0.7;
      tu.uCutSoft.value = 0.6;
    }
    const mesh = new THREE.Mesh(patchGeometry(cfg, 200 + i), material);
    mesh.name = `arachnoid-${cfg.id}`;
    mesh.position.set(...cfg.center);
    const [tx, ty] = cfg.tilt ?? [0, 0];
    mesh.rotation.set(THREE.MathUtils.degToRad(tx), THREE.MathUtils.degToRad(ty), 0);
    mesh.renderOrder = 2;
    mesh.userData = { kind: 'arachnoid', id: cfg.id, label: 'Arachnoid membrane', group: cfg.group };
    group.add(mesh);
    patches.set(cfg.id, { id: cfg.id, config: cfg, mesh, material, cut: false, tear: 0 });
  });

  return { group, patches };
}

/** Stretch the fissure-spanning patches to the current width of the fissure at their depth. */
export function updateArachnoidGap(patches: Map<string, ArachnoidPatch>, gap: number, flare: number) {
  const [z0, z1] = FISSURE.flareZ;
  for (const p of patches.values()) {
    if (!p.config.spansFissure) continue;
    const z = p.config.center[2];
    const h = THREE.MathUtils.smoothstep(z, z0, z1);
    const width = gap + lipRecession(LOBES.frontal, z) + lipRecession(LOBES.temporal, z) + 2 * flare * h;
    // Tuck 2 mm into each lip so the membrane always meets the cortex.
    const height = Math.max(3, width + 4);
    p.mesh.scale.set(1, height, 1);
    // Keep the fibre texture at its natural scale instead of stretching it with the mesh.
    const m = p.material;
    m.alphaMap!.repeat.y = height / 10;
    m.normalMap!.repeat.y = height / 10;
    if (!p.cut) {
      // Stretched arachnoid thins out and becomes more transparent.
      p.material.opacity = THREE.MathUtils.clamp(0.95 - gap * 0.035, 0.45, 0.85);
    }
  }
}

/**
 * Sharp cut with micro-scissors at a world-space point: the membrane parts along a line through
 * the point and its two halves spring back toward their attachments.
 */
export function cutPatch(p: ArachnoidPatch, worldPoint: THREE.Vector3, duration = 0.9) {
  if (p.cut) return;
  p.cut = true;
  const local = p.mesh.worldToLocal(worldPoint.clone());
  const u = p.material.userData.tissue;
  u.uCutY.value = THREE.MathUtils.clamp(local.y, p.config.spansFissure ? -0.3 : -p.config.size[1] * 0.3, p.config.spansFissure ? 0.3 : p.config.size[1] * 0.3);
  gsap.to(u.uCut, {
    value: 1,
    duration,
    ease: 'power2.out',
    onComplete: () => {
      p.mesh.visible = false;
    },
  });
  p.mesh.userData.kind = 'arachnoid-cut';
}

/** Blunt dissection: the membrane stretches and frays before it parts. */
export function tearPatch(p: ArachnoidPatch, worldPoint: THREE.Vector3, amount: number): boolean {
  if (p.cut) return false;
  p.tear = Math.min(1, p.tear + amount);
  const u = p.material.userData.tissue;
  if (p.tear < 1) {
    const local = p.mesh.worldToLocal(worldPoint.clone());
    u.uCutY.value = local.y;
    u.uCut.value = p.tear * 0.25;
    return false;
  }
  u.uCut.value = 0.25;
  cutPatch(p, worldPoint, 0.7);
  return true;
}
