import type { Anatomy } from '../anatomy';
import type { ClipEval } from '../procedure/clipEval';
import { state } from '../state/store';

/**
 * Relative blood flow in each vessel (1 = normal). A deliberately simple teaching model of the
 * local circulation:
 *
 *  - Everything distal to a temporary clip on the proximal ICA drops to the flow that collaterals
 *    can supply (anterior communicating artery from the other side, PCom back-flow from the
 *    posterior circulation) — about 15–25%.
 *  - The aneurysm fills from the ICA at its neck, so its inflow (and any rupture bleeding) follows
 *    distal ICA flow. The definitive clip (M5) will take the aneurysm out of the circulation.
 *  - The PCom is fed from both ends, so it keeps some flow even with the ICA clipped.
 *
 * Flow drives pulsation amplitude now, and Doppler, ICG and MEP in later milestones.
 */
export interface FlowState {
  /** ICA distal to the temporary clip site (and everything it feeds). */
  icaDistal: number;
  pcom: number;
  acha: number;
  mca: number;
  aca: number;
  /** Flow into the aneurysm sac. */
  aneurysm: number;
}

const COLLATERAL = 0.18;

export class FlowModel {
  readonly flow: FlowState = { icaDistal: 1, pcom: 1, acha: 1, mca: 1, aca: 1, aneurysm: 1 };
  /** Per-vessel factors set by the definitive clip: 0 = occluded. */
  readonly clipFactor: Partial<Record<keyof FlowState, number>> = {};
  /** ICA narrowing caused by the clip (0…1). */
  stenosis = 0;
  /** Residual flow after clip reconstruction of a lacerated vessel (per vessel id). */
  readonly repair: Record<string, number> = {};
  /** Did the clip leave a neck remnant that still fills? */
  remnant = false;

  /** Apply the outcome of a clip (or null when it is removed). */
  setClip(e: ClipEval | null) {
    const c = this.clipFactor;
    if (!e) {
      delete c.aneurysm;
      delete c.pcom;
      delete c.acha;
      this.stenosis = 0;
      this.remnant = false;
      return;
    }
    // Fundus inflow through whatever part of the neck the blades don't span.
    c.aneurysm = Math.max(0, 1 - e.closure) ** 0.7;
    // An occluded PCom still gets a little retrograde flow from the posterior circulation.
    c.pcom = e.pcom < 0.2 ? 0.12 : e.pcom;
    c.acha = e.acha;
    this.stenosis = e.stenosis;
    this.remnant = e.residualMm > 0.5;
  }
  private basePulse = new Map<string, number>();

  constructor(private anatomy: Anatomy) {
    for (const v of anatomy.vessels.values()) this.basePulse.set(v.id, v.material.userData.tissue.uPulseAmp.value);
    this.basePulse.set('aneurysm', anatomy.aneurysm.material.userData.tissue.uPulseAmp.value);
  }

  /** Relative flow for a vessel id (used to scale bleeding from an injured vessel). */
  forVessel(id: string): number {
    const f = this.flow;
    switch (id) {
      case 'ica':
        return f.icaDistal * (this.repair.ica ?? 1); // most of the visible ICA is distal to the clip site
      case 'm2s':
      case 'm2i':
        return f.mca * (this.repair[id] ?? 1);
      case 'pcom':
        return f.pcom;
      case 'acha':
        return f.acha;
      case 'a1':
        return f.aca;
      case 'aneurysm':
        return f.aneurysm;
      default:
        return f.mca; // M1, M2s, perforators
    }
  }

  update(dt: number) {
    const target = state.tempClip.on ? COLLATERAL : 1;
    const k = 1 - Math.exp(-dt * 3);
    const f = this.flow;
    f.icaDistal += (target - f.icaDistal) * k;
    const c = this.clipFactor;
    // A clip that kinks the ICA reduces flow to everything beyond it (flow ∝ area, roughly).
    const rp = this.repair;
    const sten = (1 - this.stenosis ** 1.6) * (rp.ica ?? 1);
    f.mca = f.icaDistal * sten * (c.mca ?? 1) * (rp.m1 ?? 1);
    f.aca = Math.min(1, f.icaDistal * sten + 0.25) * (c.aca ?? 1) * (rp.a1 ?? 1); // cross-flow via ACom
    f.acha = f.icaDistal * sten * (c.acha ?? 1) * (rp.acha ?? 1);
    f.pcom = Math.min(1, 0.45 + f.icaDistal * 0.55) * (c.pcom ?? 1);
    f.aneurysm = f.icaDistal * (c.aneurysm ?? 1);

    // Pulsation follows flow (a clipped or occluded vessel stops pulsing).
    for (const v of this.anatomy.vessels.values()) {
      const base = this.basePulse.get(v.id) ?? 0;
      v.material.userData.tissue.uPulseAmp.value = base * (0.2 + 0.8 * this.forVessel(v.id));
    }
    this.anatomy.aneurysm.material.userData.tissue.uPulseAmp.value = (this.basePulse.get('aneurysm') ?? 0) * (0.1 + 0.9 * f.aneurysm);
  }
}
