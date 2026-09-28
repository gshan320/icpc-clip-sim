import * as THREE from 'three';
import { tearPatch } from '../anatomy/arachnoid';
import { events, toast } from '../state/events';
import { addRuptureRisk, state } from '../state/store';
import { dissectorModel } from './models';
import { Tool, type Hover, type ToolContext, type ToolStatus } from './tool';

/** Number of sectors around the neck circumference that must be freed. */
const SECTORS = 12;
/** Height (mm, along the dome axis) below which a point counts as the neck. */
const NECK_HEIGHT = 2.4;

/**
 * Round dissector: blunt dissection. Its main job is freeing the aneurysm NECK from arachnoid
 * adhesions, the PCom and the anterior choroidal so a clip can pass cleanly. Sweep along the
 * neck; tilt the microscope to reach its far side. Pressing on the dome — especially the bleb —
 * raises the (hidden) rupture risk.
 */
export class DissectorTool extends Tool {
  readonly id = 'dissector' as const;
  readonly name = 'Dissector';
  readonly key = '4';
  override pressDepth = 0.45;
  /** Freedom of each neck sector, 0…1. */
  readonly sectors = new Float32Array(SECTORS);
  private tmp = new THREE.Vector3();

  constructor(ctx: ToolContext) {
    super(ctx);
    this.model = dissectorModel();
  }

  /** Where on the aneurysm is this point? */
  private zone(h: Hover | null): { zone: 'neck' | 'dome' | 'bleb' | null; angle: number } {
    if (!h) return { zone: null, angle: 0 };
    const an = this.ctx.anatomy.aneurysm;
    const onAneurysm = h.kind === 'aneurysm';
    const nearNeck = h.point.distanceTo(an.neckCenter) < an.neckRadius + 1.6;
    if (!onAneurysm && !(h.kind === 'vessel' && (h.id === 'ica' || h.id === 'pcom') && nearNeck)) return { zone: null, angle: 0 };
    const local = an.mesh.worldToLocal(this.tmp.copy(h.point));
    const angle = Math.atan2(local.z, local.x);
    if (!onAneurysm || local.y < NECK_HEIGHT) return { zone: 'neck', angle };
    if (h.point.distanceTo(an.bleb) < 1.8) return { zone: 'bleb', angle };
    return { zone: 'dome', angle };
  }

  get neckProgress(): number {
    let s = 0;
    for (const v of this.sectors) s += Math.min(1, v);
    return s / SECTORS;
  }

  status(h: Hover | null): ToolStatus {
    if (!h) return { text: 'Dissector', level: 'idle' };
    const z = this.zone(h);
    if (z.zone === 'neck') return { text: `Sweep along the neck · freed ${Math.round(this.neckProgress * 100)}%`, level: 'ok' };
    if (z.zone === 'bleb') return { text: 'Bleb — thinnest wall, do not touch', level: 'danger' };
    if (z.zone === 'dome') return { text: 'Dome — minimal pressure', level: 'warn' };
    switch (h.kind) {
      case 'arachnoid':
        return { text: 'Drag to separate bluntly', level: 'ok' };
      case 'nerve':
        return { text: 'Nerve — gentle', level: 'warn' };
      case 'vessel':
        return { text: 'Vessel — gentle', level: 'idle' };
      default:
        return { text: 'Dissector', level: 'idle' };
    }
  }

  override onHold(h: Hover | null, dt: number, tipSpeed: number) {
    if (!h) return;
    const moving = Math.min(1, tipSpeed / 6);
    const z = this.zone(h);

    if (z.zone === 'neck') {
      // Sweeping frees the adhesions at this spot and, as the tip passes under the neck, its
      // neighbours too.
      const before = this.neckProgress;
      for (let i = 0; i < SECTORS; i++) {
        const a = (i / SECTORS) * Math.PI * 2 - Math.PI;
        let d = Math.abs(a - z.angle);
        d = Math.min(d, Math.PI * 2 - d);
        const w = Math.exp(-((d / 1.25) ** 2));
        this.sectors[i] = Math.min(1, this.sectors[i] + dt * moving * 0.55 * w);
      }
      const after = this.neckProgress;
      state.neckDissection = after;
      if (Math.floor(after * 10) !== Math.floor(before * 10)) events.emit('neck:dissection', { progress: after });
      // Neck adhesions part as the dissection progresses.
      const nk = [...this.ctx.anatomy.arachnoid.values()].filter((p) => p.config.group === 'neck' && !p.cut);
      nk.forEach((p, i) => {
        if (after > 0.3 + i * 0.3) {
          const at = p.mesh.getWorldPosition(new THREE.Vector3());
          if (tearPatch(p, at, 1)) events.emit('arachnoid:cut', { id: p.id, group: p.config.group, method: 'blunt' });
        }
      });
      if (after >= 0.999 && before < 0.999) toast('Neck circumferentially freed', 'ok');
      return;
    }
    if (z.zone === 'dome' || z.zone === 'bleb') {
      const k = z.zone === 'bleb' ? 0.35 : 0.07;
      const amt = dt * k * (0.5 + moving);
      addRuptureRisk(amt);
      events.emit('risk:dome', { amount: amt, reason: `dissector on ${z.zone}` });
      toast(z.zone === 'bleb' ? 'Pressure on the bleb!' : 'Gentle — you are pressing on the dome', z.zone === 'bleb' ? 'danger' : 'warn', 'dome-press');
      return;
    }
    if (h.kind === 'arachnoid') {
      const p = this.ctx.anatomy.arachnoid.get(h.id);
      if (p && tearPatch(p, h.point, dt * moving * 0.9)) {
        events.emit('arachnoid:cut', { id: p.id, group: p.config.group, method: 'blunt' });
        // Blunt tearing pulls on small vessels more than a sharp cut.
        if (!state.demo && Math.random() < 0.3) {
          this.ctx.blood.addOoze({ object: this.ctx.anatomy.root, point: h.point, normal: h.normal, kind: 'ooze', rate: 0.04, label: 'Oozing after blunt dissection' });
        }
      }
    }
  }
}
