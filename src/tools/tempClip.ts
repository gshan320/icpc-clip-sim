import gsap from 'gsap';
import * as THREE from 'three';
import { closestOnVessel } from '../anatomy/vessels';
import { audio } from '../audio/engine';
import { events, toast } from '../state/events';
import { occlusionSeconds, state } from '../state/store';
import { fmtTime } from '../ui/checklist';
import { temporaryClipModel, type ClipModel } from './clipModels';
import type { InstrumentModel } from './models';
import { Tool, type Hover, type ToolContext, type ToolStatus } from './tool';

/** Proximal ICA segment where a temporary clip gives proximal control (between the dural ring and the PCom). */
const ZONE: [number, number] = [0.08, 0.43];

/**
 * Temporary clip on the proximal ICA: proximal control. It stops most inflow to the aneurysm
 * (collaterals still supply ~15–20%), so a rupture slows to a manageable ooze and the dome
 * softens for dissection and clipping. Every minute counts: ischaemia tolerance is limited
 * (MEP start to fall after a few minutes), so keep occlusion short and note the time.
 */
export class TempClipTool extends Tool {
  readonly id = 'tempclip' as const;
  readonly name = 'Temporary clip';
  readonly key = '0';
  override readonly pickInstruments = true;
  override hoverLift = 0;
  private cursor: ClipModel;
  private placed: ClipModel | null = null;
  private placedT = 0;
  private frame = new THREE.Matrix4();

  constructor(ctx: ToolContext) {
    super(ctx);
    const ica = ctx.anatomy.vessels.get('ica')!;
    this.cursor = temporaryClipModel(ica.radiusAt(0.25));
    this.cursor.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.userData = { kind: 'cursor' };
    });
    const model: InstrumentModel = { root: this.cursor.root, setJaw: () => {}, setGlow: () => {}, shafted: false };
    this.model = model;
  }

  private icaT(h: Hover | null): number | null {
    if (!h || h.kind !== 'vessel' || h.id !== 'ica') return null;
    return closestOnVessel(this.ctx.anatomy.vessels.get('ica')!, h.point).t;
  }

  override extraPickables(): THREE.Object3D[] {
    if (!this.placed) return [];
    const list: THREE.Object3D[] = [];
    this.placed.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) list.push(o);
    });
    return list;
  }

  private onPlacedClip(h: Hover | null) {
    return !!h && h.kind === 'instrument' && h.id === 'tempclip';
  }

  status(h: Hover | null): ToolStatus {
    const occ = fmtTime(occlusionSeconds());
    if (this.placed) {
      if (this.onPlacedClip(h)) return { text: `Click to remove · occlusion ${occ}`, level: occlusionSeconds() > 300 ? 'danger' : 'ok' };
      return { text: `Temporary clip on · ${occ}`, level: occlusionSeconds() > 180 ? 'warn' : 'idle' };
    }
    const t = this.icaT(h);
    if (t !== null) {
      if (t < ZONE[0]) return { text: 'Too proximal — under the clinoid', level: 'warn' };
      if (t > ZONE[1]) return { text: 'Too distal — stay proximal to the PCom origin', level: 'warn' };
      return { text: 'Click to apply — proximal ICA', level: 'ok' };
    }
    if (h?.kind === 'aneurysm') return { text: 'Never on the dome', level: 'danger' };
    if (h?.kind === 'vessel') return { text: 'Proximal control goes on the ICA', level: 'warn' };
    return { text: 'Temporary clip — apply to the proximal ICA', level: 'idle' };
  }

  override deforms() {
    return false;
  }

  /** Clip frame on the ICA at parameter t: X = closure axis, Y = toward the microscope, Z = along the vessel. */
  private frameAt(t: number): THREE.Matrix4 {
    const ica = this.ctx.anatomy.vessels.get('ica')!;
    const c = ica.curve.getPointAt(t);
    const T = ica.curve.getTangentAt(t);
    const toCam = this.ctx.camera.position.clone().sub(c).normalize();
    const up = toCam.addScaledVector(T, -toCam.dot(T)).normalize();
    // Tilt the clip ~50° off the optical axis so its blades are seen wrapping the vessel.
    const side = new THREE.Vector3().crossVectors(T, up).normalize();
    const Y = up.multiplyScalar(Math.cos(0.87)).addScaledVector(side, Math.sin(0.87)).normalize();
    const X = new THREE.Vector3().crossVectors(Y, T).normalize();
    const Z = new THREE.Vector3().crossVectors(X, Y).normalize();
    return this.frame.makeBasis(X, Y, Z).setPosition(c);
  }

  override orientModel(root: THREE.Object3D, h: Hover | null): boolean {
    const t = this.icaT(h);
    this.cursor.root.visible = !this.placed;
    if (t !== null) {
      const m = this.frameAt(THREE.MathUtils.clamp(t, ZONE[0], ZONE[1]));
      root.position.setFromMatrixPosition(m);
      root.quaternion.setFromRotationMatrix(m);
      root.position.addScaledVector(new THREE.Vector3().setFromMatrixColumn(m, 1), 3);
      return true;
    }
    // Hovering elsewhere: float the open clip upright above the point.
    const cam = this.ctx.camera;
    root.quaternion.copy(cam.quaternion);
    if (h) root.position.copy(h.point).addScaledVector(h.normal, 3);
    return true;
  }

  override onDown(h: Hover | null) {
    if (this.placed) {
      if (this.onPlacedClip(h)) this.remove();
      return;
    }
    const t = this.icaT(h);
    if (t === null || t < ZONE[0] || t > ZONE[1]) {
      if (t !== null) toast('Place the temporary clip on the proximal ICA, below the PCom', 'warn', 'tc-zone');
      return;
    }
    this.apply(t);
  }

  private pinch(depth: number) {
    const ica = this.ctx.anatomy.vessels.get('ica')!;
    const u = ica.material.userData.tissue;
    const m = this.frameAt(this.placedT);
    const X = new THREE.Vector3().setFromMatrixColumn(m, 0);
    const Y = new THREE.Vector3().setFromMatrixColumn(m, 1);
    const c = new THREE.Vector3().setFromMatrixPosition(m);
    const r = ica.radiusAt(this.placedT);
    // Two capsules along the blades, one each side, squeezing toward the centre line.
    for (const [slot, side] of [[0, 1], [1, -1]] as const) {
      const off = X.clone().multiplyScalar(side * r);
      u.uIndentA.value[slot].copy(c).add(off).addScaledVector(Y, r + 1);
      u.uIndentB.value[slot].copy(c).add(off).addScaledVector(Y, -r - 1);
      u.uIndentDir.value[slot].copy(X).multiplyScalar(-side);
      u.uIndentRadius.value[slot] = r * 1.05;
      u.uIndentDepth.value[slot] = depth * (r - 0.35);
    }
  }

  private apply(t: number) {
    const ica = this.ctx.anatomy.vessels.get('ica')!;
    const clip = temporaryClipModel(ica.radiusAt(t));
    this.placed = clip;
    this.placedT = t;
    const m = this.frameAt(t);
    clip.root.position.setFromMatrixPosition(m);
    clip.root.quaternion.setFromRotationMatrix(m);
    const Y = new THREE.Vector3().setFromMatrixColumn(m, 1);
    const finalPos = clip.root.position.clone();
    clip.root.position.addScaledVector(Y, 6);
    this.ctx.anatomy.root.add(clip.root);
    const anim = { open: 1, lift: 6, pinch: 0 };
    gsap
      .timeline()
      .to(anim, { lift: 0, duration: 0.45, ease: 'power2.out', onUpdate: () => clip.root.position.copy(finalPos).addScaledVector(Y, anim.lift) })
      .to(anim, {
        open: 0,
        pinch: 1,
        duration: 0.35,
        ease: 'power3.in',
        onUpdate: () => {
          clip.setOpen(anim.open);
          this.pinch(anim.pinch);
        },
        onComplete: () => {
          audio.tick(2600, 0.07);
          audio.tick(420, 0.08);
          state.tempClip.on = true;
          state.tempClip.since = state.elapsed;
          state.tempClip.episodes++;
          events.emit('tempclip:applied', { time: state.elapsed });
          toast('Temporary clip on — occlusion timer running', 'info');
        },
      });
  }

  private remove() {
    const clip = this.placed!;
    const duration = occlusionSeconds();
    state.tempClip.on = false;
    state.tempClip.total += duration;
    state.tempClip.longest = Math.max(state.tempClip.longest, duration);
    events.emit('tempclip:removed', { time: state.elapsed, duration });
    toast(`Temporary clip off after ${fmtTime(duration)}`, duration > 300 ? 'warn' : 'ok');
    audio.tick(1800, 0.06);
    const anim = { open: 0, pinch: 1, lift: 0 };
    const m = this.frameAt(this.placedT);
    const Y = new THREE.Vector3().setFromMatrixColumn(m, 1);
    const p0 = clip.root.position.clone();
    gsap
      .timeline()
      .to(anim, { open: 1, pinch: 0, duration: 0.3, ease: 'power2.out', onUpdate: () => { clip.setOpen(anim.open); this.pinch(anim.pinch); } })
      .to(anim, { lift: 8, duration: 0.4, ease: 'power2.in', onUpdate: () => clip.root.position.copy(p0).addScaledVector(Y, anim.lift), onComplete: () => clip.root.removeFromParent() });
    this.placed = null;
  }
}
