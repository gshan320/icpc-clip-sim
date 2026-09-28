import { state } from '../state/store';

/**
 * Cardiac and respiratory clocks. Everything that pulses (arteries, the aneurysm dome, the
 * brain surface, and later the ECG trace and Doppler tone) reads its phase from here, so the
 * whole field beats in sync with the heart rate.
 */
export const cardiac = {
  /** Phase within the current heartbeat, 0 → 1 (0 = R wave). */
  phase: 0,
  /** Continuous beat counter (integer part = beats since start). */
  beats: 0,
  /** Respiratory displacement, -1 … 1 (sinusoid-like, ventilator driven). */
  resp: 0,
  respPhase: 0,
  /** Arterial pulse normalised 0…1 over the last beat (from the circulation engine). */
  pulse01: 0,
  /** Instantaneous arterial pressure (mmHg). */
  pressure: 80,

  /** Free-running fallback (used only before the circulation engine exists). */
  update(dt: number) {
    const beatsPerSec = state.heartRate / 60;
    this.beats += dt * beatsPerSec;
    this.phase = this.beats % 1;
    this.respPhase = (this.respPhase + (dt * state.respRate) / 60) % 1;
    // Ventilator: faster inspiration, slower expiration.
    const p = this.respPhase;
    this.resp = p < 0.4 ? Math.sin((p / 0.4) * Math.PI * 0.5) : Math.cos(((p - 0.4) / 0.6) * Math.PI * 0.5);
    this.resp = this.resp * 2 - 1;
  },
};

/**
 * Arterial pressure waveform shape (0 … ~1) for a phase in [0,1): fast systolic upstroke,
 * exponential run-off with a dicrotic notch (aortic valve closure). Mirrors the GLSL version
 * in anatomy/materials.ts.
 */
export function arterialWave(ph: number): number {
  const up = smoothstep(0.0, 0.1, ph);
  const decay = Math.exp(-Math.max(ph - 0.1, 0) * 3.2);
  const notch = 0.18 * Math.exp(-(((ph - 0.36) / 0.045) ** 2));
  return up * decay * 0.92 + notch;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}
