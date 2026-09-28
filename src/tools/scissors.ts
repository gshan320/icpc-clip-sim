import * as THREE from 'three';
import { cutPatch } from '../anatomy/arachnoid';
import { closestOnVessel } from '../anatomy/vessels';
import { audio } from '../audio/engine';
import { events, toast } from '../state/events';
import { scissorsModel } from './models';
import { state } from '../state/store';
import { MAJOR_VESSELS, Tool, type Hover, type ToolContext, type ToolStatus } from './tool';

/** Chance that sharply opening each membrane group nicks a tiny vessel running in it. */
const OOZE_CHANCE: Record<string, number> = {
  'sylvian-superficial': 0.22,
  'sylvian-deep': 0.3,
  'carotid-cistern': 0.18,
  neck: 0.12,
};

/**
 * Micro-scissors: sharp dissection of the arachnoid. Cutting releases CSF and lets the fissure
 * open. Anything that isn't arachnoid should not be cut.
 */
export class ScissorsTool extends Tool {
  readonly id = 'scissors' as const;
  readonly name = 'Micro scissors';
  readonly key = '2';
  override pressDepth = 0.15;
  private snip = 0;
  private rand = Math.random;
  private ray = new THREE.Raycaster();

  constructor(ctx: ToolContext) {
    super(ctx);
    this.model = scissorsModel();
  }

  status(h: Hover | null): ToolStatus {
    if (!h) return { text: 'Micro scissors', level: 'idle' };
    switch (h.kind) {
      case 'arachnoid':
        return { text: 'Click to cut', level: 'ok' };
      case 'aneurysm':
        return { text: 'Do not cut — aneurysm wall', level: 'danger' };
      case 'vessel':
        return { text: 'Do not cut — artery', level: 'danger' };
      case 'vein':
        return { text: 'Do not cut — vein', level: 'danger' };
      case 'nerve':
        return { text: 'Do not cut — nerve', level: 'danger' };
      case 'brain':
        return { text: 'Cut only arachnoid', level: 'warn' };
      default:
        return { text: 'Micro scissors', level: 'idle' };
    }
  }

  override onDown(h: Hover | null) {
    this.snip = 1;
    audio.snip();
    if (!h) return;
    const { anatomy, blood } = this.ctx;

    if (h.kind === 'arachnoid') {
      const patch = anatomy.arachnoid.get(h.id);
      if (!patch || patch.cut) return;
      cutPatch(patch, h.point);
      events.emit('arachnoid:cut', { id: patch.id, group: patch.config.group, method: 'sharp' });
      // Tissue behind the membrane at this point (where a nicked vessel would bleed).
      this.ray.set(h.point, this.ctx.camera.getWorldDirection(new THREE.Vector3()));
      this.ray.far = 14;
      const behind = this.ray.intersectObjects(anatomy.solids, false).find((x) => x.object.userData.kind !== 'instrument');
      // Cutting right over an artery is how small branches get injured.
      let nearArtery = false;
      for (const v of anatomy.vessels.values()) {
        const c = closestOnVessel(v, h.point);
        if (c.dist - c.radius < 0.5) nearArtery = true;
      }
      if (behind && behind.face && !state.demo) {
        const n = behind.face.normal.clone().transformDirection(behind.object.matrixWorld);
        if (nearArtery && this.rand() < 0.5) {
          blood.addOoze({ object: behind.object, point: behind.point, normal: n, kind: 'arterial', rate: 0.1, label: 'Small arterial branch bleeding', vesselId: 'm1' });
          toast('A small arterial branch was nicked — control it with bipolar', 'warn');
        } else if (this.rand() < (OOZE_CHANCE[patch.config.group] ?? 0.2)) {
          blood.addOoze({ object: behind.object, point: behind.point, normal: n, kind: 'ooze', rate: 0.03 + this.rand() * 0.03, label: 'Oozing arachnoid vessel' });
          toast('Minor oozing from an arachnoid vessel', 'info', 'ooze');
        }
      }
      return;
    }

    if (h.kind === 'aneurysm') {
      events.emit('aneurysm:breach', { point: { x: h.point.x, y: h.point.y, z: h.point.z }, reason: 'the dome was cut' });
      return;
    }
    if (h.kind === 'vessel') {
      // Laceration of a parent artery bleeds at arterial pressure in proportion to its size; it
      // cannot be coagulated — it needs proximal control and clip reconstruction.
      const RATE: Record<string, number> = { ica: 3.2, m1: 1.6, a1: 1.1, m2s: 0.9, m2i: 0.9, pcom: 0.5, acha: 0.35 };
      const major = MAJOR_VESSELS.has(h.id);
      blood.addOoze({ object: h.object, point: h.point, normal: h.normal, kind: 'arterial', rate: RATE[h.id] ?? 0.12, label: `${h.label} laceration`, vesselId: h.id, coagulable: !major });
      toast(major ? `${h.label} lacerated — proximal control, then clip the tear (6)` : `${h.label} injured — coagulate`, 'danger');
      return;
    }
    if (h.kind === 'vein') {
      blood.addOoze({ object: h.object, point: h.point, normal: h.normal, kind: 'ooze', rate: 0.12, label: 'Sylvian vein injury', selfLimiting: false });
      toast('Sylvian vein torn — venous bleeding', 'danger');
      return;
    }
    if (h.kind === 'nerve') {
      toast(`${h.label} cut — this would cause a permanent deficit`, 'danger');
      return;
    }
    if (h.kind === 'brain') {
      blood.addOoze({ object: h.object, point: h.point, normal: h.normal, kind: 'ooze', rate: 0.02, label: 'Pial bleeding' });
      toast('Pial injury — cut only the arachnoid', 'warn', 'pia');
    }
  }

  override update(dt: number) {
    // Quick close-and-open of the blades.
    this.snip = Math.max(0, this.snip - dt * 6);
    const closed = this.snip > 0.5 ? (1 - this.snip) * 2 : this.snip * 2;
    this.model!.setJaw(this.pressed ? 0.15 : 1 - closed * 0.95);
  }
}
