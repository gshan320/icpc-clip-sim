import { createNoise2D } from 'simplex-noise';
import { mulberry32 } from '../anatomy/noise';
import { events } from '../state/events';
import { occlusionSeconds, state } from '../state/store';
import { cardiac } from './cardiac';
import type { FlowModel } from './flow';
import { Hemodynamics } from './hemodynamics';

/**
 * Vital signs, measured from the circulation engine (see Hemodynamics) exactly as a monitor
 * would, plus motor evoked potentials:
 *
 *  - MEP (motor evoked potentials) tolerate a few minutes of reduced flow in the MCA / anterior
 *    choroidal territories, then fall; they also fall with sustained hypotension, and recover
 *    after reperfusion if the ischaemia was short. Occluding the anterior choroidal with a clip
 *    is the classic cause of an MEP drop during IC-PC clipping.
 */
export class VitalsModel {
  readonly engine: Hemodynamics;
  private n = createNoise2D(mulberry32(515));
  private t = 0;
  /** Accumulated "ischaemic dose" beyond tolerance. */
  private ischaemia = 0;

  constructor(private flow: FlowModel) {
    this.engine = new Hemodynamics(() => ({ ebl: state.ebl, bleedingRate: state.bleedingRate, tempOcclusion: state.tempClip.on }));
    this.engine.onEvent = (text, level) => events.emit('anaesthesia', { text, level });
  }

  private histAcc = 0;

  update(dt: number) {
    this.t += dt;
    const e = this.engine;
    e.advance(dt);
    const m = e.measured;
    const v = state.vitals;
    v.hr = m.hr;
    v.sbp = m.sbp;
    v.dbp = m.dbp;
    v.map = m.map;
    v.spo2 = m.spo2;
    v.etco2 = m.etco2;
    v.rr = m.rr;
    v.pi = m.pi;
    v.co = m.co;
    v.ppv = m.ppv;
    state.heartRate = Math.max(30, m.hr);
    // Whole-patient condition.
    const p = state.patient;
    const wasDead = p.dead;
    p.rhythm = e.rhythm;
    p.arrest = e.arrest;
    p.arrestAt = e.arrest ? e.arrestAt : null;
    p.roscCount = e.roscCount;
    p.dead = e.dead;
    p.deathCause = e.deathCause;
    p.anoxia = e.anoxia;
    p.fluids = e.fluids;
    p.mtp = e.mtp;
    p.volumeDeficit = e.volumeDeficit;
    // Brain swelling after significant anoxic/ischaemic injury (cannot be reversed in the OR).
    const swellT = Math.min(1, Math.max(0, (e.anoxia - 90) / 240) + Math.max(0, (100 - v.mep - 70) / 60) * (this.ischaemia > 900 ? 1 : 0));
    if (swellT > p.swelling) {
      if (p.swelling < 0.05 && swellT >= 0.05) events.emit('anaesthesia', { text: 'Brain swelling — the cortex is bulging into the field', level: 'danger' });
      p.swelling += (swellT - p.swelling) * (1 - Math.exp(-dt / 20));
    }
    if (p.dead && !wasDead) events.emit('patient:died', { cause: p.deathCause, time: state.elapsed });
    // Per-second history for the debrief.
    this.histAcc += dt;
    if (state.started && this.histAcc >= 1) {
      this.histAcc = 0;
      state.history.push({ t: state.elapsed, map: v.map, hr: v.hr, mep: v.mep, ebl: state.ebl });
    }

    // Everything that pulses follows the engine's beats.
    cardiac.phase = e.phase;
    cardiac.beats = e.beats + e.phase;
    cardiac.resp = e.resp;
    cardiac.respPhase = e.respPhase;
    cardiac.pulse01 = e.pulse01;
    cardiac.pressure = e.pressure;

    // --- MEP ---
    const f = this.flow.flow;
    const perfusion = Math.min(f.mca, f.acha) * Math.min(1.2, v.map / 80);
    const deficitFlow = Math.max(0, 1 - perfusion);
    // ~3 minutes of full occlusion are tolerated before potentials start to fade.
    if (deficitFlow > 0.3) this.ischaemia += dt * deficitFlow;
    else this.ischaemia = Math.max(0, this.ischaemia - dt * 0.5);
    const tolerance = 180;
    let mepT = 100;
    if (this.ischaemia > tolerance) mepT = 100 - Math.min(95, (this.ischaemia - tolerance) * 0.22);
    if (v.map < 55) mepT -= (55 - v.map) * 1.5;
    if (e.arrest) mepT = 0;
    // Irreversible after long ischaemia: recovery is only partial.
    const recoveryCap = 100 - Math.max(0, state.tempClip.longest - 600) * 0.08;
    mepT = Math.min(mepT, recoveryCap) + this.n(this.t * 0.02, 6) * 2;
    const kMep = mepT < v.mep ? 1 - Math.exp(-dt / 6) : 1 - Math.exp(-dt / 25);
    v.mep += (Math.max(0, mepT) - v.mep) * kMep;
    v.mepMin = Math.min(v.mepMin, v.mep);

    // --- Temporary occlusion bookkeeping ---
    if (state.tempClip.on) state.tempClip.longest = Math.max(state.tempClip.longest, occlusionSeconds());
  }
}

/**
 * Monitor alarms (IEC 60601-1-8 style priorities). Returns the active alarm messages; emits when
 * the set changes.
 */
export class AlarmMonitor {
  active: { id: string; text: string; priority: 'high' | 'medium' }[] = [];
  private key = '';

  update() {
    const v = state.vitals;
    const a: AlarmMonitor['active'] = [];
    const p = state.patient;
    if (p.dead) a.push({ id: 'hr', text: 'ASYSTOLE', priority: 'high' });
    else if (p.rhythm === 'asystole') a.push({ id: 'hr', text: 'ASYSTOLE', priority: 'high' });
    else if (p.rhythm === 'pea') a.push({ id: 'map', text: 'NO PULSE — PEA', priority: 'high' });
    if (v.map < 55) a.push({ id: 'map', text: `MAP LOW ${v.map.toFixed(0)}`, priority: 'high' });
    else if (v.map < 65) a.push({ id: 'map', text: `MAP LOW ${v.map.toFixed(0)}`, priority: 'medium' });
    if (!p.arrest && v.hr > 120) a.push({ id: 'hr', text: `HR HIGH ${v.hr.toFixed(0)}`, priority: 'medium' });
    if (!p.arrest && v.hr < 45) a.push({ id: 'hr', text: `HR LOW ${v.hr.toFixed(0)}`, priority: 'high' });
    if (Number.isNaN(v.spo2)) a.push({ id: 'spo2', text: 'SpO₂ NO SIGNAL', priority: 'medium' });
    else if (v.spo2 < 92) a.push({ id: 'spo2', text: `SpO₂ LOW ${v.spo2.toFixed(0)}`, priority: 'high' });
    if (v.mep < 50) a.push({ id: 'mep', text: `MEP ↓ ${v.mep.toFixed(0)}%`, priority: 'high' });
    const occ = occlusionSeconds();
    if (occ > 300) a.push({ id: 'occ', text: 'T-OCC > 5 min', priority: 'medium' });
    if (state.bleedingRate > 1.5) a.push({ id: 'bleed', text: 'MASSIVE BLEEDING', priority: 'high' });
    this.active = a;
    const key = a.map((x) => `${x.id}:${x.priority}`).join('|');
    if (key !== this.key) {
      this.key = key;
      events.emit('alarm:changed', { active: a.map((x) => x.text) });
    }
    return a;
  }
}
