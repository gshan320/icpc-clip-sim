import gsap from 'gsap';
import * as THREE from 'three';
import { audio } from '../audio/engine';
import { CLIP_SPECS, clipFrame, evaluateClip, suggestedDepth, type ClipPose, type ClipType } from '../procedure/clipEval';
import type { FlowModel } from '../physics/flow';
import { events, toast } from '../state/events';
import { state } from '../state/store';
import { permanentClipModel, type PermanentClip } from './clipModels';
import type { InstrumentModel } from './models';
import { Tool, type Hover, type ToolContext, type ToolStatus } from './tool';

/**
 * Definitive aneurysm clip.
 *
 *  - Point at the neck: the clip preview sits at that height on the sac.
 *  - Q / E rotate the blades (aim: parallel to the ICA), wheel or W / S set blade depth (how far
 *    the tips reach across the neck), Tab switches straight / curved.
 *  - Click to apply: the blades close and flatten the neck. Click the clip again to open and
 *    remove it — surgeons reposition clips all the time.
 *
 * The result is computed from the geometry (clipEval) but the learner is not told it: it has to
 * be read from ICG (does the dome still fill? do the branches?) and the Doppler.
 */
export class AneurysmClipTool extends Tool {
  readonly id = 'clip' as const;
  readonly name = 'Aneurysm clip';
  readonly key = '6';
  override readonly pickInstruments = true;
  override hoverLift = 0;
  pose: ClipPose = { type: 'straight', h: 0.45, theta: THREE.MathUtils.degToRad(35), depth: 4 };
  private preview: PermanentClip;
  private placed: { clip: PermanentClip; pose: ClipPose } | null = null;
  private depthTouched = false;

  constructor(ctx: ToolContext, private flow: FlowModel) {
    super(ctx);
    this.preview = this.build(this.pose.type, true);
    const model: InstrumentModel = { root: this.preview.root, setJaw: () => {}, setGlow: () => {}, shafted: false };
    this.model = model;
  }

  private build(type: ClipType, ghost: boolean): PermanentClip {
    const spec = CLIP_SPECS[type];
    const r = this.ctx.anatomy.aneurysm.radiusAt(0.45);
    const clip = permanentClipModel(spec.length, spec.lift, r + 1.1);
    clip.setGhost(ghost);
    if (ghost) clip.root.traverse((o) => ((o as THREE.Mesh).isMesh ? (o.userData = { kind: 'cursor' }) : null));
    return clip;
  }

  override activate() {
    this.ctx.setWheelZoom(false);
  }

  override deactivate() {
    this.ctx.setWheelZoom(true);
  }

  override extraPickables(): THREE.Object3D[] {
    const list: THREE.Object3D[] = [];
    this.placed?.clip.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) list.push(o);
    });
    return list;
  }

  /** Height on the sac pointed at, or null if not on the neck region. */
  private heightAt(h: Hover | null): number | null {
    if (!h) return null;
    const an = this.ctx.anatomy.aneurysm;
    if (h.kind !== 'aneurysm' && !(h.kind === 'vessel' && h.id === 'ica' && h.point.distanceTo(an.neckCenter) < an.neckRadius + 3)) return null;
    const local = an.mesh.worldToLocal(h.point.clone());
    return THREE.MathUtils.clamp(local.y, -1.2, an.height * 0.8);
  }

  /** A lacerated parent artery under the cursor that needs clip reconstruction. */
  private tearAt(h: Hover | null) {
    if (!h || (h.kind !== 'vessel' && h.kind !== 'bleeding')) return null;
    const o = this.ctx.blood.nearestActiveOoze(h.point, 3);
    return o && !o.coagulable && o.vesselId && o.vesselId !== 'aneurysm' ? o : null;
  }

  /**
   * Clip reconstruction: a clip laid along the vessel over the tear closes it, at the price of
   * narrowing the vessel (flow reduced).
   */
  private repairTear(o: NonNullable<ReturnType<AneurysmClipTool['tearAt']>>) {
    const v = this.ctx.anatomy.vessels.get(o.vesselId!);
    const at = o.blob.getWorldPosition(new THREE.Vector3());
    const clip = permanentClipModel(5, 0, 1.2);
    clip.setGhost(false);
    const T = v ? v.curve.getTangentAt(Math.min(1, Math.max(0, (v.samples.findIndex((p) => p.distanceTo(at) < 2.5) + 0.5) / v.samples.length))) : new THREE.Vector3(1, 0, 0);
    const n = at.clone().sub(this.ctx.camera.position).normalize().negate();
    const c = new THREE.Vector3().crossVectors(T, n).normalize();
    const a = new THREE.Vector3().crossVectors(c, T).normalize();
    const m = new THREE.Matrix4().makeBasis(T, a, c).setPosition(at.clone().addScaledVector(T, -2.5));
    m.decompose(clip.root.position, clip.root.quaternion, clip.root.scale);
    clip.setHeadDir(new THREE.Vector3(-0.5, 0.9, 0).normalize());
    this.ctx.anatomy.root.add(clip.root);
    const anim = { open: 1 };
    gsap.to(anim, { open: 0, duration: 0.35, ease: 'power3.in', onUpdate: () => clip.setOpen(anim.open), onComplete: () => audio.tick(2900, 0.07) });
    this.ctx.blood.sealByClip(o);
    this.flow.repair[o.vesselId!] = 0.6;
    toast(`${v?.label ?? 'Vessel'} tear closed by clip reconstruction (flow reduced)`, 'ok');
  }

  private onPlaced(h: Hover | null) {
    return !!h && h.kind === 'instrument' && h.id === 'aneurysm-clip';
  }

  status(h: Hover | null): ToolStatus {
    if (this.tearAt(h)) return { text: 'Click to clip the tear (clip reconstruction)', level: 'ok' };
    if (this.placed) {
      if (this.onPlaced(h)) return { text: 'Click to open and remove the clip', level: 'ok' };
      return { text: 'Clip applied — check it with ICG (7) and Doppler (8)', level: 'idle' };
    }
    const hh = this.heightAt(h);
    if (hh === null) return { text: `Aneurysm clip (${CLIP_SPECS[this.pose.type].label}) — point at the neck`, level: 'idle' };
    const ang = Math.round(Math.abs(THREE.MathUtils.radToDeg(this.pose.theta)) % 180);
    const angle = Math.min(ang, 180 - ang);
    const text = `${CLIP_SPECS[this.pose.type].label} · ${angle}° to ICA · depth ${this.pose.depth.toFixed(1)} mm · Q/E rotate · wheel depth · Tab type · click to apply`;
    return { text, level: angle < 12 ? 'ok' : 'warn' };
  }

  override deforms() {
    return false;
  }

  override onWheel(deltaY: number): boolean {
    this.pose.depth = THREE.MathUtils.clamp(this.pose.depth - deltaY * 0.004, 0.5, 9);
    this.depthTouched = true;
    return true;
  }

  override onKey(key: string): boolean {
    const step = THREE.MathUtils.degToRad(3);
    switch (key) {
      case 'q':
        this.pose.theta -= step;
        return true;
      case 'e':
        this.pose.theta += step;
        return true;
      case 'w':
        this.pose.depth = Math.min(9, this.pose.depth + 0.25);
        this.depthTouched = true;
        return true;
      case 's':
        this.pose.depth = Math.max(0.5, this.pose.depth - 0.25);
        this.depthTouched = true;
        return true;
      case 'tab': {
        this.pose.type = this.pose.type === 'straight' ? 'curved' : 'straight';
        const old = this.preview.root;
        this.preview = this.build(this.pose.type, true);
        old.parent?.add(this.preview.root);
        old.removeFromParent();
        this.model!.root = this.preview.root;
        audio.tick(1400, 0.04);
        return true;
      }
    }
    return false;
  }

  /** Clip world transform for a pose (hinge at s0 along b, blades along +X). */
  private place(root: THREE.Object3D, pose: ClipPose) {
    const an = this.ctx.anatomy.aneurysm;
    const f = clipFrame(this.ctx.anatomy, pose);
    const local = new THREE.Matrix4().makeBasis(f.b, f.a, f.c);
    local.setPosition(f.origin.clone().addScaledVector(f.b, f.s0));
    an.mesh.updateMatrixWorld();
    const world = an.mesh.matrixWorld.clone().multiply(local);
    world.decompose(root.position, root.quaternion, root.scale);
    // Spring head up and back toward the microscope.
    const camLocal = this.ctx.camera.position.clone().applyMatrix4(world.clone().invert()).normalize();
    const dir = camLocal.multiplyScalar(0.9).add(new THREE.Vector3(-0.55, 0, 0)).normalize();
    const clip = root === this.preview.root ? this.preview : this.placed && root === this.placed.clip.root ? this.placed.clip : this.pending;
    clip?.setHeadDir(dir);
  }

  private pending: PermanentClip | null = null;

  override orientModel(root: THREE.Object3D, h: Hover | null): boolean {
    const hh = this.heightAt(h);
    root.visible = !this.placed && hh !== null;
    if (hh !== null) {
      this.pose.h = hh;
      if (!this.depthTouched) this.pose.depth = suggestedDepth(this.ctx.anatomy, this.pose) - 0.6;
      this.place(root, this.pose);
    }
    return true;
  }

  override onDown(h: Hover | null) {
    const tear = this.tearAt(h);
    if (tear) {
      this.repairTear(tear);
      return;
    }
    if (this.placed) {
      if (this.onPlaced(h)) this.remove();
      return;
    }
    const hh = this.heightAt(h);
    if (hh === null) return;
    this.pose.h = hh;
    this.apply({ ...this.pose });
  }

  /** Squeeze the neck under the blades (aneurysm-local indentation slots). */
  private pinch(pose: ClipPose, amount: number) {
    const an = this.ctx.anatomy.aneurysm;
    const u = an.material.userData.tissue;
    const f = clipFrame(this.ctx.anatomy, pose);
    const half = f.width / 2;
    for (const [slot, side] of [[0, 1], [1, -1]] as const) {
      const off = f.c.clone().multiplyScalar(side * f.r);
      u.uIndentA.value[slot].copy(f.origin).addScaledVector(f.b, Math.max(f.s0, -half)).add(off);
      u.uIndentB.value[slot].copy(f.origin).addScaledVector(f.b, Math.min(f.s1, half)).add(off);
      u.uIndentDir.value[slot].copy(f.c).multiplyScalar(-side);
      u.uIndentRadius.value[slot] = f.r * 0.95;
      u.uIndentDepth.value[slot] = amount * Math.max(0, f.r - 0.3);
    }
  }

  private apply(pose: ClipPose) {
    const clip = this.build(pose.type, false);
    this.ctx.anatomy.root.add(clip.root);
    this.pending = clip;
    this.place(clip.root, pose);
    this.pending = null;
    this.placed = { clip, pose };
    const e = evaluateClip(this.ctx.anatomy, pose);
    const anim = { open: 1, pinch: 0 };
    gsap.to(anim, {
      open: 0,
      pinch: 1,
      duration: 0.5,
      ease: 'power3.in',
      onUpdate: () => {
        clip.setOpen(anim.open);
        this.pinch(pose, anim.pinch);
      },
      onComplete: () => {
        audio.tick(2900, 0.07);
        audio.tick(600, 0.08);
        state.clip.applied = true;
        state.clip.id++;
        state.clip.pose = { ...pose };
        state.clip.eval = e;
        state.clipHistory.push({ id: state.clip.id, pose: { ...pose }, eval: e, at: state.elapsed });
        this.flow.setClip(e);
        events.emit('clip:applied', { type: pose.type, id: state.clip.id });
        toast('Clip applied — verify with ICG (7) and Doppler (8)', 'info');
      },
    });
  }

  private remove() {
    const p = this.placed!;
    this.placed = null;
    const id = state.clip.id;
    const h = state.clipHistory.find((x) => x.id === id);
    if (h) h.removedAt = state.elapsed;
    state.clip.applied = false;
    state.clip.pose = null;
    state.clip.eval = null;
    this.flow.setClip(null);
    events.emit('clip:removed', { id });
    audio.tick(1700, 0.05);
    const anim = { open: 0, pinch: 1, lift: 0 };
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(p.clip.root.quaternion);
    const p0 = p.clip.root.position.clone();
    gsap
      .timeline()
      .to(anim, { open: 1, pinch: 0, duration: 0.3, ease: 'power2.out', onUpdate: () => { p.clip.setOpen(anim.open); this.pinch(p.pose, anim.pinch); } })
      .to(anim, { lift: 10, duration: 0.4, ease: 'power2.in', onUpdate: () => p.clip.root.position.copy(p0).addScaledVector(up, anim.lift), onComplete: () => p.clip.root.removeFromParent() });
    toast('Clip removed', 'info');
  }
}
