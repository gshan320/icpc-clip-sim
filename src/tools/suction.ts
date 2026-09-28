import * as THREE from 'three';
import { audio } from '../audio/engine';
import { toast, events } from '../state/events';
import { addRuptureRisk } from '../state/store';
import { suctionModel, type InstrumentModel } from './models';
import { MAJOR_VESSELS, Tool, type Hover, type ToolContext, type ToolStatus } from './tool';

/**
 * Suction (left hand). Keeps the field dry: aspirates droplets, stains and pooled blood near
 * the tip. Never apply suction directly to the aneurysm dome.
 */
export class SuctionTool extends Tool {
  readonly id = 'suction' as const;
  readonly name = 'Suction';
  readonly key = '1';
  override readonly hand = 'left' as const;
  override readonly ignoreKinds = new Set(['arachnoid']);
  override pressDepth = 0.25;

  private parkedModel: InstrumentModel | null = null;

  constructor(ctx: ToolContext) {
    super(ctx);
    this.model = suctionModel();
  }

  /**
   * S: park the suction here (the left hand keeps it in place and aspirating while the right
   * hand works with another instrument). S again takes it back.
   */
  override onKey(key: string, h: Hover | null): boolean {
    if (key !== 's') return false;
    const blood = this.ctx.blood;
    if (blood.parked) {
      blood.parked = null;
      this.parkedModel?.root.removeFromParent();
      this.parkedModel = null;
      audio.suction(false);
      toast('Suction back in hand', 'info');
      return true;
    }
    if (!h || !this.model) return false;
    blood.parked = h.point.clone();
    const pm = suctionModel();
    pm.root.position.copy(this.model.root.position);
    pm.root.quaternion.copy(this.model.root.quaternion);
    this.model.root.parent?.add(pm.root);
    this.parkedModel = pm;
    toast('Suction parked — it keeps aspirating while you use another instrument (S to take it back)', 'info');
    return true;
  }



  status(h: Hover | null): ToolStatus {
    if (!h) return { text: 'Suction', level: 'idle' };
    if (h.kind === 'blood') return { text: 'Hold to aspirate · S parks it here', level: 'ok' };
    if (h.kind === 'bleeding') return { text: 'Aspirate to find the bleeding point', level: 'ok' };
    if (h.kind === 'aneurysm') return { text: 'Never suction on the dome', level: 'danger' };
    if (h.kind === 'vessel' && MAJOR_VESSELS.has(h.id)) return { text: 'Keep suction off the artery wall', level: 'warn' };
    if (this.ctx.blood.submerged(h.point, 1)) return { text: 'Hold to aspirate', level: 'ok' };
    return { text: 'Suction', level: 'idle' };
  }

  private lastTip = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private hasLast = false;

  /** Smoothed tip velocity (mm/s) for smearing stains along the stroke. */
  private tipVelocity(p: THREE.Vector3, dt: number): THREE.Vector3 {
    if (this.hasLast) this.vel.lerp(p.clone().sub(this.lastTip).multiplyScalar(1 / Math.max(dt, 1e-3)), 0.3);
    this.lastTip.copy(p);
    this.hasLast = true;
    return this.vel;
  }

  override onDown() {
    this.hasLast = false;
    audio.suction(true, 0);
  }

  override onUp() {
    if (!this.ctx.blood.parked) audio.suction(false);
  }

  override deactivate() {
    if (!this.ctx.blood.parked) audio.suction(false);
  }

  override onHold(h: Hover | null, dt: number) {
    if (!h) {
      audio.suction(true, 0);
      return;
    }
    const drawn = this.ctx.blood.suction(h.point, dt, 1, this.tipVelocity(h.point, dt));
    audio.suction(true, drawn);
    if (h.kind === 'aneurysm') {
      addRuptureRisk(dt * 0.25);
      events.emit('risk:dome', { amount: dt * 0.25, reason: 'suction on dome' });
      toast('Suction on the aneurysm dome — move away', 'danger', 'suction-dome');
    }
  }
}
