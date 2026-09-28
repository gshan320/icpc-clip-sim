import { createNoise2D } from 'simplex-noise';
import { mulberry32 } from '../anatomy/noise';

/**
 * Circulation engine — the single source of truth for every vital sign.
 *
 * Integrated at a fixed 2 ms step (500 Hz, the sampling rate of a good OR monitor), independent
 * of the display frame rate.
 *
 * Model (teaching-grade, physiologically structured):
 *  - Heart: beats at an R–R interval set by the heart-rate command (respiratory sinus arrhythmia,
 *    beat-to-beat noise). Each beat ejects a stroke volume as a half-sine over a systolic time that
 *    shortens with heart rate. Stroke volume = baseline × preload (Frank–Starling) × contractility.
 *  - Arteries: Windkessel, C·dP/dt = Q − (P − Pmcf)/R. MAP emerges as CO × R.
 *  - Volume: 5000 mL − blood loss + fluids/blood given. Losses follow the ATLS classes: little
 *    change below 15 %, narrowing pulse pressure and tachycardia to 30 %, falling pressure at
 *    30–40 %, and collapse beyond (tachycardia blunted by anaesthesia).
 *  - Shock spiral: sustained MAP < 50 starves the myocardium (coronary perfusion), contractility
 *    falls, pressure falls further; pre-terminal bradycardia, then cardiac arrest — usually PEA
 *    (organised ECG, no pulse) in haemorrhage, deteriorating to asystole.
 *  - Anaesthesia team: fluids, then a massive-transfusion protocol, vasopressors for hypotension,
 *    induced hypertension during temporary occlusion; in arrest CPR (≈110/min), epinephrine every
 *    3–4 min and rapid infusion. Return of spontaneous circulation (ROSC) is only possible once
 *    the bleeding is controlled and volume restored.
 *  - Brain: cerebral perfusion fails below the autoregulation limit (MAP ≈ 50); the anoxic dose
 *    accumulates (≈ 4–6 min of no flow is irreversible). Death is declared after 10 minutes of
 *    unsuccessful resuscitation or when anoxic injury is unsurvivable.
 *
 * Signals are written to 500 Hz ring buffers (ECG, arterial pressure, plethysmogram, CO₂, Doppler)
 * that the monitor draws sample-by-sample; numbers are measured from those signals.
 */

export const FS = 500; // Hz
export const DT = 1 / FS;
const BUF = 8192;

export interface HemoInputs {
  /** Cumulative blood loss (mL). */
  ebl: number;
  /** Current bleeding rate (mL/s). */
  bleedingRate: number;
  /** Temporary occlusion running (triggers the anaesthetist's vasopressor). */
  tempOcclusion: boolean;
}

export type Rhythm = 'sinus' | 'pea' | 'asystole';
export type HemoEventLevel = 'info' | 'warn' | 'danger' | 'ok';

export class RingBuffer {
  readonly data = new Float32Array(BUF);
  /** Total samples ever written (monotonic); index = count % BUF. */
  count = 0;
  push(v: number) {
    this.data[this.count % BUF] = v;
    this.count++;
  }
  at(i: number) {
    return this.data[((i % BUF) + BUF) % BUF];
  }
}

const PMCF = 7; // mean circulatory filling pressure (mmHg)

export class Hemodynamics {
  /** Simulation time (s). */
  t = 0;
  private acc = 0;
  private noise = createNoise2D(mulberry32(616));
  private rand = mulberry32(617);

  // --- Heart ---
  private beatStart = 0;
  private rr = 60 / 68;
  private hrCmd = 68;
  private readonly hr0 = 68;
  private ts = 0.3;
  private sv = 70;
  private svBeat = 70;
  /** Mechanical beats (pulses). */
  beats = 0;
  /** Increments whenever the monitor should refresh its numbers (each beat, or every 2 s in arrest). */
  measureTick = 0;
  /** Myocardial contractility, 1 = normal. */
  contractility = 1;
  rhythm: Rhythm = 'sinus';

  // --- Arteries ---
  P = 78;
  private R = 0.92;
  private readonly R0 = 0.92;
  private readonly C = 0.95;
  private readonly sv0 = 70;
  private readonly mapSet = 80;
  private mapFilt = 80;
  private occPressor = 0;
  private shockPressor = 0;
  private lowMapSince: number | null = null;
  private epi = 0;

  // --- Volume & oxygen carrying ---
  private readonly V0 = 5000;
  /** Fluids / blood given by the anaesthetist (mL, total infused). */
  fluids = 0;
  /** Part of the infused volume that stays intravascular (crystalloid leaks; blood stays). */
  private effFluids = 0;
  /** Haemoglobin (g/dL) and its intravascular mass (g/dL × mL). */
  hb = 13.5;
  private hbMass = 13.5 * 5000;
  /** Lactate (mmol/L): rises when oxygen delivery is inadequate. */
  lactate = 1.0;
  /** Oxygen delivery relative to normal (cardiac output × Hb). */
  do2 = 1;
  private lastGas = 0;
  private bleedNoticedAt: number | null = null;
  mtp = false;
  private mtpAt: number | null = null;

  // --- Arrest & resuscitation ---
  arrest = false;
  arrestAt = 0;
  cpr = false;
  private cprStart = 0;
  private lastEpi = -1e9;
  private lastRoscCheck = 0;
  private veryLowSince: number | null = null;
  roscCount = 0;
  dead = false;
  deathCause = '';
  /** Accumulated cerebral anoxic dose (s of equivalent zero flow). */
  anoxia = 0;
  /** Deficit fraction (0…1) of circulating volume. */
  volumeDeficit = 0;
  onEvent: ((text: string, level: HemoEventLevel) => void) | null = null;
  private said = new Set<string>();

  // --- Lungs ---
  private readonly respRate = 12;
  respPhase = 0;
  private co2 = 0;
  private etco2Peak = 0;

  // --- Measurement ---
  private bMax = -1e9;
  private bMin = 1e9;
  private bSum = 0;
  private bN = 0;
  private windowStart = 0;
  private rrHistory: number[] = [];
  private spo2History: number[] = [];
  /** Last measured values. SpO₂ is NaN when the pleth signal is lost. */
  readonly measured = { hr: 68, sbp: 112, dbp: 64, map: 80, spo2: 99, etco2: 34, rr: 12, pi: 3.2, co: 4.8, ppv: 4 };
  private ppHistory: number[] = [];

  // --- Signals ---
  readonly ecg = new RingBuffer();
  readonly abp = new RingBuffer();
  readonly pleth = new RingBuffer();
  readonly capno = new RingBuffer();
  readonly doppler = new RingBuffer();
  dopplerProbe: ((pulse01: number, resp: number) => number) | null = null;
  pressure = 78;
  pulse01 = 0;
  phase = 0;
  resp = 0;

  constructor(private inputs: () => HemoInputs) {}

  private say(key: string, text: string, level: HemoEventLevel = 'info') {
    if (this.said.has(key)) return;
    this.said.add(key);
    this.onEvent?.(text, level);
  }

  advance(frameDt: number) {
    this.acc += Math.min(frameDt, 0.25);
    while (this.acc >= DT) {
      this.acc -= DT;
      this.step();
    }
  }

  /** Frank–Starling: stroke volume fraction for a volume deficit fraction. */
  private starling(vf: number) {
    return Math.max(0.05, 1 - 1.4 * vf - 3.0 * Math.max(0, vf - 0.2));
  }

  private step() {
    const inp = this.inputs();
    const t = (this.t += DT);
    const m = this.measured;

    // ---------------- Ventilator ----------------
    this.respPhase = (this.respPhase + (DT * this.respRate) / 60) % 1;
    const insp = this.respPhase < 1 / 3; // I:E 1:2
    const itp = insp ? Math.sin((this.respPhase * 3 * Math.PI) / 2) : Math.cos(((this.respPhase - 1 / 3) * 1.5 * Math.PI) / 2);
    this.resp = itp * 2 - 1;

    // ---------------- Volume, oxygen carrying, anaesthesia team ----------------
    const vcirc = Math.max(500, this.V0 - inp.ebl + this.effFluids);
    const deficit = Math.max(0, this.V0 - vcirc);
    const vf = Math.min(0.9, deficit / this.V0);
    this.volumeDeficit = vf;
    // Blood is lost at the current Hb concentration.
    this.hbMass = Math.max(0, this.hbMass - this.hb * inp.bleedingRate * DT);
    if (inp.bleedingRate > 0.02 && this.bleedNoticedAt === null) this.bleedNoticedAt = t;
    if (deficit < 1 && inp.bleedingRate < 0.01) this.bleedNoticedAt = null;
    if (!this.mtp && (inp.ebl > 750 || deficit > 400)) {
      if (this.mtpAt === null) this.mtpAt = t;
      if (t - this.mtpAt > 30) {
        this.mtp = true;
        this.say('mtp', 'Anaesthesia: massive transfusion protocol activated', 'warn');
      }
    }
    // Infusion: crystalloid first (half leaks out, no Hb); blood products once the MTP runs.
    let infuse = 0;
    if (this.arrest) infuse = 4;
    else if (this.mtp) infuse = 2.5;
    else if (this.bleedNoticedAt !== null && t - this.bleedNoticedAt > 8) {
      infuse = deficit > 150 ? 1.5 : 0.6;
      if (deficit > 60) this.say('fluids', 'Anaesthesia: fluids running', 'info');
    } else if (deficit > 0) infuse = 0.05;
    if (!this.dead && deficit > 0) {
      const dv = Math.min(deficit * 1.6, infuse * DT);
      this.fluids += dv;
      const blood = this.mtp || this.arrest;
      this.effFluids += dv * (blood ? 0.95 : 0.5);
      if (blood) this.hbMass += dv * 0.95 * 11;
    }
    this.hb = this.hbMass / vcirc;
    // Oxygen delivery and lactate.
    this.do2 = (this.measured.co / 4.76) * (this.hb / 13.5);
    if (this.do2 < 0.6) this.lactate += DT * (0.6 - this.do2) * 0.06;
    else this.lactate = Math.max(1, this.lactate - DT * 0.004);
    if (this.bleedNoticedAt !== null && inp.ebl > 500 && t - this.lastGas > 300) {
      this.lastGas = t;
      this.onEvent?.(`Blood gas: Hb ${this.hb.toFixed(1)} g/dL, lactate ${this.lactate.toFixed(1)} mmol/L`, this.hb < 7 || this.lactate > 4 ? 'danger' : 'warn');
    }

    // Stroke volume: preload × contractility, with ventilator-induced variation growing with hypovolaemia.
    const ppvGain = 0.03 + 0.9 * vf;
    const svTarget = this.sv0 * this.starling(vf) * this.contractility * (1 - ppvGain * (itp - 0.5));

    // ---------------- Reflexes & drugs ----------------
    this.mapFilt += (this.P - this.mapFilt) * (DT / 2);
    const err = this.mapSet - this.mapFilt;
    let hrWant = this.hr0 + 0.45 * err + 1.1 * Math.max(0, err - 12) + this.noise(t * 0.02, 3) * 2;
    // Failing myocardium: pre-terminal bradycardia.
    if (this.contractility < 0.35) hrWant *= Math.max(0.35, this.contractility / 0.35);
    hrWant = Math.min(150, Math.max(35, hrWant));
    this.hrCmd += (hrWant - this.hrCmd) * (DT / 4);

    this.occPressor += ((inp.tempOcclusion ? 1 : 0) - this.occPressor) * (DT / 25);
    if (inp.tempOcclusion) this.say(`occ-${Math.floor(t / 600)}`, 'Anaesthesia: raising MAP for temporary occlusion', 'info');
    // Vasopressor infusion for sustained hypotension.
    if (this.mapFilt < 60 && !this.arrest) {
      if (this.lowMapSince === null) this.lowMapSince = t;
      if (t - this.lowMapSince > 20) {
        this.shockPressor = Math.min(1, this.shockPressor + DT / 30);
        this.say('pressor', 'Anaesthesia: vasopressor infusion started', 'warn');
      }
    } else if (this.mapFilt > 70) {
      this.lowMapSince = null;
      this.shockPressor = Math.max(0, this.shockPressor - DT / 120);
    }
    this.epi *= Math.exp(-DT / 90);
    const rWant =
      this.R0 * Math.min(2.4, Math.max(0.6, 1 + 0.006 * err + 0.015 * Math.max(0, err - 12))) * (1 + 0.35 * this.occPressor) * (1 + 0.5 * this.shockPressor) * (1 + this.epi) * (1 + this.noise(t * 0.01, 7) * 0.04);
    // Arrest: vasoplegia — resistance collapses despite epinephrine.
    this.R += (rWant * (this.arrest ? 0.55 : 1) - this.R) * (DT / 8);

    // ---------------- Myocardium & brain ----------------
    if (!this.arrest) {
      // Myocardial ischaemia: low coronary perfusion pressure and/or low oxygen delivery (anaemia,
      // low output, acidosis) depress contractility — the spiral of haemorrhagic shock.
      const coronary = this.mapFilt < 50 ? ((50 - this.mapFilt) / 50) * 0.012 * (1 + 2 * vf) : 0;
      const hypoxic = this.do2 < 0.4 ? (0.4 - this.do2) * 0.02 : 0;
      const acid = this.lactate > 8 ? (this.lactate - 8) * 0.0004 : 0;
      if (coronary + hypoxic + acid > 0) this.contractility -= DT * (coronary + hypoxic + acid);
      else if (this.mapFilt > 65 && this.do2 > 0.6) this.contractility += DT * 0.003;
      this.contractility = Math.min(1, Math.max(0, this.contractility + this.shockPressor * DT * 0.0006));
    }
    // Cerebral oxygen delivery: flow fails below the autoregulation limit (~50 mmHg), and each
    // unit of flow carries less oxygen as Hb falls.
    const cbf = Math.min(1, Math.max(0, (this.mapFilt - 20) / 30));
    const cdo2 = cbf * Math.min(1, this.hb / 9);
    if (cdo2 < 0.8 && !this.dead) this.anoxia += DT * Math.min(1, (0.8 - cdo2) / 0.8) ** 1.5;
    else this.anoxia = Math.max(0, this.anoxia - DT * 0.02);

    // ---------------- Arrest ----------------
    if (!this.arrest && !this.dead) {
      if (this.mapFilt < 24) {
        if (this.veryLowSince === null) this.veryLowSince = t;
      } else this.veryLowSince = null;
      if ((this.veryLowSince !== null && t - this.veryLowSince > 6) || this.contractility < 0.12 || vf > 0.55) this.enterArrest(t);
    }
    if (this.arrest && !this.dead) this.resuscitate(t, inp, vf);

    // ---------------- Cardiac cycle ----------------
    let tb = t - this.beatStart;
    let q = 0;
    if (this.rhythm !== 'asystole' && tb >= this.rr) {
      this.endBeat();
      this.beatStart = t;
      tb = 0;
      const rsa = 0.015 * Math.sin(this.respPhase * Math.PI * 2);
      this.rr = this.rhythm === 'pea' ? 60 / (34 + this.rand() * 8) : (60 / this.hrCmd) * (1 + rsa + (this.rand() - 0.5) * 0.01);
      this.ts = 0.16 + 0.17 * Math.min(this.rr, 1.2);
      this.sv += (svTarget - this.sv) * 0.6;
      this.svBeat = this.rhythm === 'sinus' ? this.sv : 0; // PEA: electrical activity without output
      if (this.rhythm === 'sinus') {
        this.beats++;
        this.measureTick++;
      }
    }
    this.phase = this.rhythm === 'sinus' ? Math.min(1, tb / this.rr) : 0;
    if (this.rhythm === 'sinus' && tb < this.ts) q = ((this.svBeat * Math.PI) / (2 * this.ts)) * Math.sin((Math.PI * tb) / this.ts);
    // Chest compressions.
    let comp = 0;
    if (this.cpr) {
      const period = 60 / 110;
      const tc = (t - this.cprStart) % period;
      const svc = 15 * Math.max(0.25, this.starling(vf));
      if (tc < 0.26) q += ((svc * Math.PI) / (2 * 0.26)) * Math.sin((Math.PI * tc) / 0.26);
      comp = Math.sin((tc / period) * Math.PI * 2);
    }
    this.P += ((q - (this.P - PMCF) / this.R) / this.C) * DT;
    this.P = Math.max(0, this.P);
    const g = (x: number, s: number) => Math.exp(-((x / s) ** 2));
    const notch = this.rhythm === 'sinus' ? -2.6 * g(tb - this.ts - 0.005, 0.012) + 2.0 * g(tb - this.ts - 0.035, 0.02) : 0;
    const pDisp = this.P + notch;
    this.pressure = pDisp;
    this.bMax = Math.max(this.bMax, pDisp);
    this.bMin = Math.min(this.bMin, pDisp);
    this.bSum += pDisp;
    this.bN++;
    // In arrest the monitor measures over 2 s windows (there are no pulses to trigger on).
    if (this.rhythm !== 'sinus' && t - this.windowStart > 2) this.endWindow(t);
    this.pulse01 = Math.min(1.2, Math.max(0, (pDisp - m.dbp) / Math.max(5, m.sbp - m.dbp))) * (this.rhythm === 'sinus' ? 1 : 0.3);

    // ---------------- Signals (500 Hz) ----------------
    this.ecg.push(this.ecgAt(tb, this.rr, m.map) + (this.cpr ? 0.55 * comp : 0));
    this.abp.push(pDisp);
    const pd = this.abp.at(this.abp.count - 1 - Math.round(0.2 * FS));
    const pi = this.rhythm === 'sinus' ? (3.2 * (this.svBeat / this.sv0)) / (this.R / this.R0) ** 1.5 : this.cpr ? 0.15 : 0.02;
    m.pi = pi;
    this.pleth.push(this.rhythm === 'sinus' ? ((pd - m.dbp) / Math.max(5, m.sbp - m.dbp)) * Math.min(1, pi / 3.2) : this.cpr ? 0.08 * comp + 0.1 : (this.rand() - 0.5) * 0.02);
    // Capnogram: CO₂ delivery to the lungs follows cardiac output (CPR gives ~25 % of normal).
    const co = this.rhythm === 'sinus' ? (this.svBeat * this.hrCmd) / 1000 : this.cpr ? 15 * 110 * Math.max(0.25, this.starling(vf)) / 1000 : 0;
    m.co = co;
    const etTarget = 34 * Math.sqrt(Math.max(0.01, co / 4.76));
    if (insp) this.co2 += (0 - this.co2) * Math.min(1, DT * 25);
    else {
      const e = (this.respPhase - 1 / 3) / (2 / 3);
      this.co2 += (etTarget * (0.9 + 0.1 * e) - this.co2) * Math.min(1, DT * (e < 0.15 ? 30 : 6));
    }
    this.etco2Peak = Math.max(this.etco2Peak, this.co2);
    this.capno.push(this.co2);
    this.doppler.push(this.dopplerProbe ? this.dopplerProbe(this.pulse01, this.resp) : 0);
    if (!insp && this.respPhase > 0.995) {
      m.etco2 = this.etco2Peak;
      this.etco2Peak = 0;
    }
  }

  private enterArrest(t: number) {
    this.arrest = true;
    this.arrestAt = t;
    this.rhythm = 'pea';
    this.contractility = Math.min(this.contractility, 0.1);
    this.windowStart = t;
    this.say(`arrest-${this.roscCount}`, 'CARDIAC ARREST — pulseless electrical activity (PEA)', 'danger');
  }

  private resuscitate(t: number, inp: HemoInputs, vf: number) {
    const since = t - this.arrestAt;
    if (!this.cpr && since > 8) {
      this.cpr = true;
      this.cprStart = t;
      this.say(`cpr-${this.roscCount}`, 'Code team: chest compressions started', 'danger');
    }
    if (this.rhythm === 'pea' && since > 180) {
      this.rhythm = 'asystole';
      this.say(`asys-${this.roscCount}`, 'Rhythm deteriorated to asystole', 'danger');
    }
    if (this.cpr && t - this.lastEpi > 200) {
      this.lastEpi = t;
      this.epi = 0.7;
      this.onEvent?.('Code team: epinephrine 1 mg IV', 'warn');
    }
    // ROSC only if the haemorrhage is controlled and enough volume is back.
    if (this.cpr && t - this.lastRoscCheck > 10) {
      this.lastRoscCheck = t;
      const controlled = inp.bleedingRate < 0.5 && vf < 0.3 && this.hb > 6.5;
      const chance = controlled ? (this.rhythm === 'pea' ? 0.35 : 0.12) + this.epi * 0.2 : 0;
      if (this.rand() < chance) {
        this.arrest = false;
        this.cpr = false;
        this.rhythm = 'sinus';
        this.contractility = 0.72;
        this.hrCmd = 118;
        this.shockPressor = 1;
        this.veryLowSince = null;
        this.roscCount++;
        this.onEvent?.('Return of spontaneous circulation (ROSC)', 'ok');
        return;
      }
    }
    if (since > 600 || this.anoxia > 600 || (this.roscCount >= 4 && this.lactate > 18)) {
      this.dead = true;
      this.cpr = false;
      this.rhythm = 'asystole';
      this.deathCause = inp.bleedingRate > 0.5 ? 'exsanguinating haemorrhage' : 'irreversible hypoxic–ischaemic injury after haemorrhagic arrest';
      this.onEvent?.('Resuscitation stopped — patient death declared', 'danger');
    }
  }

  /** Close a sinus beat: measure SBP/DBP/MAP from the recorded pressure, HR from R–R, SpO₂. */
  private endBeat() {
    const m = this.measured;
    if (this.rhythm !== 'sinus') {
      // PEA: complexes counted by the ECG only.
      this.rrHistory.push(this.rr);
      if (this.rrHistory.length > 4) this.rrHistory.shift();
      return;
    }
    if (this.bN > 10) {
      m.sbp = this.bMax;
      m.dbp = this.bMin;
      m.map = this.bSum / this.bN;
      this.ppHistory.push(this.bMax - this.bMin);
      if (this.ppHistory.length > 8) this.ppHistory.shift();
      const ppMax = Math.max(...this.ppHistory), ppMin = Math.min(...this.ppHistory);
      m.ppv = (100 * (ppMax - ppMin)) / Math.max(1, (ppMax + ppMin) / 2);
    }
    this.rrHistory.push(this.rr);
    if (this.rrHistory.length > 4) this.rrHistory.shift();
    m.hr = 60 / (this.rrHistory.reduce((a, b) => a + b, 0) / this.rrHistory.length);
    // SpO₂: high on FiO₂ 0.5; falls with shock-level output; lost when the pleth is too weak.
    const sat = 99.2 - Math.max(0, 2.2 - m.co) * 6 - Math.max(0, 45 - m.map) * 0.4 + (this.rand() - 0.5) * 0.6;
    this.spo2History.push(Math.min(100, sat));
    if (this.spo2History.length > 8) this.spo2History.shift();
    m.spo2 = m.pi < 0.25 ? NaN : this.spo2History.reduce((a, b) => a + b, 0) / this.spo2History.length;
    m.rr = this.respRate;
    this.resetWindow();
  }

  /** Arrest: measure pressure over a 2 s window; HR from ECG complexes (0 in asystole). */
  private endWindow(t: number) {
    const m = this.measured;
    if (this.bN > 10) {
      m.sbp = this.bMax;
      m.dbp = this.bMin;
      m.map = this.bSum / this.bN;
    }
    m.hr = this.rhythm === 'asystole' ? 0 : 60 / (this.rrHistory.reduce((a, b) => a + b, 0) / Math.max(1, this.rrHistory.length));
    m.spo2 = NaN;
    m.ppv = 0;
    this.windowStart = t;
    this.measureTick++;
    this.resetWindow();
  }

  private resetWindow() {
    this.bMax = -1e9;
    this.bMin = 1e9;
    this.bSum = 0;
    this.bN = 0;
  }

  /** Lead II ECG (mV) at `tb` s after the R wave: sinus (ST depression with ischaemia), PEA, asystole. */
  private ecgAt(tb: number, rr: number, map: number): number {
    const g = (mu: number, sd: number, a: number) => a * Math.exp(-(((tb - mu) / sd) ** 2));
    const noise = (this.rand() - 0.5) * 0.012 + 0.02 * this.resp;
    if (this.rhythm === 'asystole') return noise + 0.015 * Math.sin(this.t * 1.7);
    if (this.rhythm === 'pea') {
      // Slow, wide, low-voltage complexes without P waves.
      return g(0, 0.04, 0.5) + g(0.06, 0.035, -0.18) + g(0.42, 0.09, 0.14) + noise;
    }
    const qt = 0.36 * Math.sqrt(rr);
    const st = map < 55 ? -0.12 * Math.min(1, (55 - map) / 20) : 0;
    const stSeg = st * (tb > 0.05 && tb < qt * 0.75 ? 1 : 0) * Math.min(1, (tb - 0.05) / 0.03);
    return g(-0.16, 0.022, 0.12) + g(-0.028, 0.009, -0.12) + g(0, 0.011, 1.05) + g(0.028, 0.011, -0.28) + g(qt * 0.72, 0.045, 0.28) + stSeg + g(rr - 0.16, 0.022, 0.12) + noise;
  }
}
