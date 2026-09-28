import type { Anatomy } from '../anatomy';
import { FISSURE } from '../config/anatomy';
import { events, toast } from '../state/events';
import { state } from '../state/store';

/**
 * How far the sylvian fissure is open, and what it costs.
 *
 * Teaching model: splitting the arachnoid releases CSF and un-tethers the opercula, so the lobes
 * fall apart on their own ("the fissure opens itself"). Spatulas can add a little more room, but
 * retracting against intact arachnoid bands mostly raises brain retraction pressure instead of
 * opening the corridor. Sustained pressure above ~20 mmHg risks retraction injury.
 */
export const SAFE_RETRACTION_MMHG = 20;

export class FissureModel {
  /** Debug override (0…1) — bypasses the model when set. */
  override: number | null = null;
  private current: number;
  private lastEmitted: number;

  constructor(private anatomy: Anatomy) {
    this.current = anatomy.open;
    this.lastEmitted = this.current;
  }

  /** Fraction of each arachnoid group that has been opened. */
  cutFraction(group: string): number {
    let n = 0;
    let c = 0;
    for (const p of this.anatomy.arachnoid.values()) {
      if (p.config.group !== group) continue;
      n++;
      if (p.cut) c++;
    }
    return n ? c / n : 0;
  }

  /** Minimum opening (0…1) before a spatula can be slid into the fissure. */
  static readonly SPATULA_MIN_OPEN = 0.18;

  target(): number {
    const ss = this.cutFraction('sylvian-superficial');
    const sd = this.cutFraction('sylvian-deep');
    const { frontal, temporal } = state.spatulas;
    const retraction = ((frontal.placed ? frontal.retraction : 0) + (temporal.placed ? temporal.retraction : 0)) / 2;
    const fromCuts = FISSURE.openingFromCuts['sylvian-superficial'] * ss + FISSURE.openingFromCuts['sylvian-deep'] * sd;
    // Retraction only buys room once the arachnoid tethers are released.
    const fromRetraction = FISSURE.openingFromRetraction * retraction * (0.25 + 0.75 * ss);
    return Math.min(1, fromCuts + fromRetraction);
  }

  update(dt: number) {
    // A swollen brain (after anoxic / ischaemic injury) pushes the lobes back into the corridor.
    const target = Math.max(0, (this.override ?? this.target()) - state.patient.swelling * 0.75);
    const k = 1 - Math.exp(-dt / (FISSURE.relaxTime / 3));
    this.current += (target - this.current) * k;
    this.anatomy.setFissureOpen(this.current);
    state.fissureOpen = this.current;
    if (Math.abs(this.current - this.lastEmitted) > 0.01) {
      this.lastEmitted = this.current;
      events.emit('fissure:changed', { open: this.current });
    }

    // Retraction pressure: grows with how hard each blade pulls, much faster against tethered lobes.
    const tether = 1 - this.cutFraction('sylvian-superficial') * 0.8 - this.cutFraction('sylvian-deep') * 0.2;
    let pressure = 0;
    for (const lobe of ['frontal', 'temporal'] as const) {
      const s = state.spatulas[lobe];
      const sp = this.anatomy.spatulas[lobe === 'frontal' ? 0 : 1];
      sp.update(s.inserted, s.placed ? s.retraction : 0, this.anatomy.flare);
      if (!s.placed) continue;
      pressure = Math.max(pressure, 3 + s.retraction * (12 + 30 * tether));
    }
    state.retractionPressure = pressure;
    if (pressure > SAFE_RETRACTION_MMHG) {
      state.retractionOverTime += dt;
      toast(`Retraction pressure ${pressure.toFixed(0)} mmHg — ease the spatula or open more arachnoid`, 'warn', 'retraction');
    }
  }

  /** Can a spatula be placed now? */
  canPlaceSpatula(): boolean {
    return this.current >= FissureModel.SPATULA_MIN_OPEN;
  }
}
