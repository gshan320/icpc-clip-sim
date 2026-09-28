import * as THREE from 'three';
import type { Anatomy } from '../anatomy';
import { closestOnVessel } from '../anatomy/vessels';

/**
 * Clip geometry and outcome, computed from the actual 3D anatomy.
 *
 * Frame (aneurysm-local, +Y = dome axis, origin = neck centre on the ICA wall):
 *   a = dome axis, b = blade direction in the neck plane, c = closing direction (a × b).
 * A clip at height h closes the sac by flattening its cross-section at that height into a line
 * along b, about π·r(h) wide. For complete closure the blades must span that whole width.
 *
 * Outcome, the way a surgeon judges it (shown to the learner only through ICG / Doppler):
 *  - closure: fraction of the flattened neck width spanned by the blades,
 *  - residual neck (mm): sac left below the blades (clip placed too high on the dome, a curved
 *    tip riding up, or blades too short — a "dog ear"),
 *  - ICA stenosis: blades too low (on the parent wall) or not parallel to the ICA, so the part
 *    of the blades beyond the neck kinks the carotid,
 *  - PCom / AChA patency: whether their first millimetres lie within the jaws.
 */
export type ClipType = 'straight' | 'curved';

export const CLIP_SPECS: Record<ClipType, { length: number; lift: number; label: string }> = {
  straight: { length: 9, lift: 0, label: 'straight 9 mm' },
  // A curved clip's tips ride up away from the parent vessel — kinder to branches near the tip,
  // at the price of a small residual at the tip side if placed low on a broad neck.
  curved: { length: 8.5, lift: 1.3, label: 'curved 8.5 mm' },
};

export interface ClipPose {
  type: ClipType;
  /** Height of the blades above the ICA wall (mm). */
  h: number;
  /** Blade angle to the ICA-parallel direction (rad). */
  theta: number;
  /** Position of the blade tips along b from the neck centre (mm). */
  depth: number;
}

export interface ClipFrame {
  origin: THREE.Vector3;
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  /** Blade span along b: [hinge end, tip]. */
  s0: number;
  s1: number;
  /** Sac radius and flattened neck width at the clip height. */
  r: number;
  width: number;
}

export interface ClipEval {
  closure: number;
  residualMm: number;
  stenosis: number;
  pcom: number;
  acha: number;
  onNeck: boolean;
}

/** ICA direction at the neck, expressed in the aneurysm-local frame and projected onto the neck plane. */
export function icaParallel(anatomy: Anatomy): THREE.Vector3 {
  const ica = anatomy.vessels.get('ica')!;
  const T = ica.curve.getTangentAt(anatomy.aneurysm.icaT);
  const inv = anatomy.aneurysm.mesh.quaternion.clone().invert();
  const l = T.applyQuaternion(inv);
  l.y = 0;
  return l.normalize();
}

/** Upward rise (mm) of the blade at coordinate s along b. */
export function bladeLift(pose: ClipPose, s: number): number {
  const spec = CLIP_SPECS[pose.type];
  if (!spec.lift) return 0;
  const start = pose.depth - 2.2;
  const u = Math.max(0, (s - start) / 2.2);
  return spec.lift * u * u;
}

export function clipFrame(anatomy: Anatomy, pose: ClipPose): ClipFrame {
  const an = anatomy.aneurysm;
  const a = new THREE.Vector3(0, 1, 0);
  const b = icaParallel(anatomy).applyAxisAngle(a, pose.theta).normalize();
  const c = new THREE.Vector3().crossVectors(a, b).normalize();
  const r = an.radiusAt(Math.max(0.2, pose.h));
  const L = CLIP_SPECS[pose.type].length;
  return { origin: new THREE.Vector3(0, pose.h, 0), a, b, c, s0: pose.depth - L, s1: pose.depth, r, width: Math.PI * r };
}

/** Ideal-ish depth for a pose: tips 0.8 mm beyond the far side of the flattened neck. */
export function suggestedDepth(anatomy: Anatomy, pose: ClipPose): number {
  const r = anatomy.aneurysm.radiusAt(Math.max(0.2, pose.h));
  return (Math.PI * r) / 2 + 0.8;
}

export function evaluateClip(anatomy: Anatomy, pose: ClipPose): ClipEval {
  const an = anatomy.aneurysm;
  const f = clipFrame(anatomy, pose);
  const W = f.width;
  const lo = Math.max(f.s0, -W / 2);
  const hi = Math.min(f.s1, W / 2);
  const coverage = Math.max(0, hi - lo) / W;
  const onNeck = pose.h > -1.2 && pose.h < an.height * 0.85 && coverage > 0.25;

  // Residual neck: sac left below the blades.
  const hIdeal = 0.45;
  let residual = Math.max(0, pose.h - hIdeal);
  // A curved tip riding up over the far edge of the neck leaves a small dog-ear.
  if (pose.type === 'curved') residual += Math.max(0, bladeLift(pose, W / 2) - 0.35);
  if (coverage < 1) residual += (1 - coverage) * W * 0.45;

  // ICA stenosis.
  const ica = anatomy.vessels.get('ica')!;
  const rIca = ica.radiusAt(an.icaT);
  const low = pose.h < 0.15 ? Math.min(1, (0.15 - pose.h) / 1.0) * 0.7 : 0;
  const beyond = Math.max(0, f.s1 - W / 2) + Math.max(0, -W / 2 - f.s0);
  const ang = Math.abs(Math.sin(pose.theta)) * (beyond / (2 * rIca)) * (pose.h < 1.2 ? 1.2 : 0.5);
  const stenosis = Math.min(0.95, low + Math.min(0.8, ang));

  // Branch patency: are the first millimetres of the PCom / AChA inside the jaws?
  const branch = (id: string) => {
    const v = anatomy.vessels.get(id)!;
    let patency = 1;
    let arc = 0;
    const tmp = new THREE.Vector3();
    for (let i = 0; i < v.samples.length; i++) {
      if (i > 0) arc += v.samples[i].distanceTo(v.samples[i - 1]);
      if (arc > 4.5) break;
      const pw = v.samples[i];
      // Ignore the part still inside the ICA lumen.
      const onIca = closestOnVessel(ica, pw);
      if (onIca.dist < onIca.radius * 0.95) continue;
      const pl = an.mesh.worldToLocal(tmp.copy(pw));
      pl.sub(f.origin);
      const s = pl.dot(f.b);
      const q = pl.dot(f.c);
      const z = pl.dot(f.a) - bladeLift(pose, s);
      const caught = s > f.s0 - 0.3 && s < f.s1 + 0.3 && Math.abs(z) < 0.6 + v.radiusAt(i / (v.samples.length - 1)) && Math.abs(q) < f.r + 1.3;
      if (caught) patency = Math.min(patency, arc < 1.8 ? 0.04 : 0.35);
    }
    return patency;
  };

  return {
    closure: coverage,
    residualMm: residual,
    stenosis,
    pcom: branch('pcom'),
    acha: branch('acha'),
    onNeck,
  };
}
