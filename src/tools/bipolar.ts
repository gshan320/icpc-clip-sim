import { audio } from '../audio/engine';
import { events, toast } from '../state/events';
import { addRuptureRisk } from '../state/store';
import type { Ooze } from '../physics/blood';
import { bipolarModel } from './models';
import { MAJOR_VESSELS, Tool, type Hover, type ToolContext, type ToolStatus } from './tool';

/** Seconds of continuous coagulation needed to seal a bleeding point. */
const COAG_TIME = { ooze: 0.8, arterial: 1.4 };

/**
 * Bipolar forceps: coagulates small bleeding points between its tips. Not for the dome, the
 * parent arteries or perforators — and you have to see the bleeder, so suction first.
 */
export class BipolarTool extends Tool {
  readonly id = 'bipolar' as const;
  readonly name = 'Bipolar forceps';
  readonly key = '3';
  override readonly ignoreKinds = new Set(['arachnoid']);
  override pressDepth = 0.3;
  private jaw = 1;
  private glow = 0;
  private puffAcc = 0;
  private target: Ooze | null = null;

  constructor(ctx: ToolContext) {
    super(ctx);
    this.model = bipolarModel();
  }

  private nearBleeder(h: Hover | null): Ooze | null {
    if (!h) return null;
    return this.ctx.blood.nearestActiveOoze(h.point, 2.2, true);
  }

  status(h: Hover | null): ToolStatus {
    if (!h) return { text: 'Bipolar', level: 'idle' };
    const o = this.nearBleeder(h);
    if (o) {
      if (this.ctx.blood.submerged(h.point, 0.3)) return { text: 'Suction first — you must see the bleeder', level: 'warn' };
      return { text: this.pressed ? `Coagulating ${Math.round(o.coag * 100)}%` : 'Hold to coagulate', level: 'ok' };
    }
    if (h.kind === 'bleeding' || ((h.kind === 'aneurysm' || h.kind === 'vessel') && this.ctx.blood.nearestActiveOoze(h.point, 3))) {
      if (h.kind === 'aneurysm' || (h.kind === 'bleeding' && h.label.includes('rupture'))) return { text: 'A rupture cannot be coagulated — temporary clip, then clip the neck', level: 'danger' };
      return { text: 'Too large to coagulate — proximal control, then clip the tear (6)', level: 'danger' };
    }
    switch (h.kind) {
      case 'aneurysm':
        return { text: 'Do not coagulate the dome', level: 'danger' };
      case 'vessel':
        return MAJOR_VESSELS.has(h.id) ? { text: 'Do not coagulate a parent artery', level: 'danger' } : { text: 'Preserve perforators', level: 'danger' };
      case 'nerve':
        return { text: 'Keep heat away from the nerve', level: 'danger' };
      case 'blood':
        return { text: 'Suction first', level: 'warn' };
      default:
        return { text: 'Bipolar', level: 'idle' };
    }
  }

  override onDown(h: Hover | null) {
    audio.bipolar(true);
    this.target = this.nearBleeder(h);
  }

  override onUp() {
    audio.bipolar(false);
    this.target = null;
  }

  override deactivate() {
    audio.bipolar(false);
  }

  override onHold(h: Hover | null, dt: number) {
    this.puffAcc += dt;
    if (h && this.puffAcc > 0.1 && h.kind !== 'blood') {
      this.puffAcc = 0;
      this.ctx.blood.puff(h.point, 2);
    }
    if (!h) return;
    const o = this.target && this.target.active ? this.target : this.nearBleeder(h);
    if (o && !this.ctx.blood.submerged(h.point, 0.3)) {
      this.target = o;
      o.coag += dt / COAG_TIME[o.kind];
      if (o.coag >= 1) {
        this.ctx.blood.coagulate(o);
        toast('Bleeding point coagulated', 'ok');
        this.target = null;
      }
      return;
    }
    if (h.kind === 'aneurysm') {
      addRuptureRisk(dt * 0.3);
      events.emit('risk:dome', { amount: dt * 0.3, reason: 'bipolar on dome' });
      toast('Bipolar on the dome — stop', 'danger', 'bip-dome');
    } else if (h.kind === 'vessel') {
      toast(`Coagulating the ${h.label} risks occluding it`, 'danger', 'bip-vessel');
    } else if (h.kind === 'nerve') {
      toast(`Thermal injury to the ${h.label}`, 'danger', 'bip-nerve');
    }
  }

  override update(dt: number) {
    const wantJaw = this.pressed ? 0.05 : 1;
    this.jaw += (wantJaw - this.jaw) * (1 - Math.exp(-dt * 18));
    this.model!.setJaw(this.jaw);
    const wantGlow = this.pressed ? 0.85 : 0;
    this.glow += (wantGlow - this.glow) * (1 - Math.exp(-dt * 20));
    this.model!.setGlow(this.glow);
  }
}
