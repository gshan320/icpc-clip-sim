import { FISSURE } from '../config/anatomy';
import { PHYSIOLOGY } from '../config/sim';
import type { ClipEval, ClipPose } from '../procedure/clipEval';

export type ToolId =
  | 'suction'
  | 'scissors'
  | 'bipolar'
  | 'dissector'
  | 'spatula'
  | 'clip'
  | 'icg'
  | 'doppler'
  | 'endoscope'
  | 'tempclip';

export interface SpatulaState {
  /** Insertion animation, 0 (out) … 1 (resting on the cortex). */
  inserted: number;
  placed: boolean;
  /** How hard the blade holds the lobe back, 0 … 1. */
  retraction: number;
}

/**
 * Single in-memory simulation state. Nothing is persisted; reloading the page resets everything.
 */
export interface SimState {
  started: boolean;
  quality: 'high' | 'low';
  activeTool: ToolId | null;
  /** Sylvian fissure opening, 0 (closed) … 1 (fully open). */
  fissureOpen: number;
  spatulas: { frontal: SpatulaState; temporal: SpatulaState };
  /** Estimated brain retraction pressure (mmHg). >20–25 mmHg sustained risks retraction injury. */
  retractionPressure: number;
  /** Seconds spent above the safe retraction pressure. */
  retractionOverTime: number;
  /** Fraction of the aneurysm neck circumference freed from adhesions, 0 … 1. */
  neckDissection: number;
  /** Hidden intraoperative rupture risk, 0 … 1 (rough handling of the dome raises it). */
  ruptureRisk: number;
  /** Estimated blood loss (mL) and current bleeding rate (mL/s). */
  ebl: number;
  bleedingRate: number;
  /** Blood currently pooled in the field (mL). */
  fieldBlood: number;
  /** Structures the learner has identified (pointed at and held). */
  identified: Record<string, boolean>;
  /** Index of the current procedure stage (0-based); equals stage count when all are done. */
  stage: number;
  /** Operation time (s) at which each stage was completed. */
  stageTimes: number[];
  heartRate: number;
  respRate: number;
  /** Seconds since the operation started. */
  elapsed: number;
  vitals: Vitals;
  tempClip: TempClipState;
  /** Intraoperative rupture happened (time in s, or null). */
  ruptureAt: number | null;
  clip: ClipState;
  /** What the surgeon has verified with flow studies (keyed to the clip application id). */
  checks: {
    icgClipId: number;
    /** ICG runs done (total). */
    icgRuns: number;
    doppler: Record<string, { clipId: number; flow: number }>;
  };
  /** Whole-patient condition (from the circulation engine). */
  patient: PatientState;
  /** Set when the case is over (all steps done, the surgeon ended it, or the patient died). */
  ended: null | { reason: 'complete' | 'ended' | 'death'; at: number };
  /** Running demo (automatic playback) — random complications are suppressed. */
  demo: boolean;
  /** Why the aneurysm ruptured (for the debrief). */
  ruptureReason: string;
  /** Key events with operation time, for the debrief timeline. */
  timeline: { t: number; kind: string; label: string }[];
  /** Per-second vitals history for the debrief. */
  history: { t: number; map: number; hr: number; mep: number; ebl: number }[];
  /** Clip applications / removals (for the debrief). */
  clipHistory: { id: number; pose: ClipPose; eval: ClipEval; at: number; removedAt?: number }[];
}

export interface PatientState {
  rhythm: 'sinus' | 'pea' | 'asystole';
  arrest: boolean;
  arrestAt: number | null;
  roscCount: number;
  dead: boolean;
  deathCause: string;
  /** Cerebral anoxic dose (s of equivalent no-flow). */
  anoxia: number;
  /** Brain swelling 0…1 (after ischaemic / anoxic injury). */
  swelling: number;
  fluids: number;
  mtp: boolean;
  volumeDeficit: number;
}

export interface ClipState {
  applied: boolean;
  /** Increments with every application — checks must refer to the current one. */
  id: number;
  pose: ClipPose | null;
  eval: ClipEval | null;
}

export interface Vitals {
  hr: number;
  sbp: number;
  dbp: number;
  map: number;
  spo2: number;
  etco2: number;
  /** Respiratory rate (ventilator), perfusion index, cardiac output (L/min), pulse-pressure variation (%). */
  rr: number;
  pi: number;
  co: number;
  ppv: number;
  /** Motor evoked potential amplitude, % of baseline. */
  mep: number;
  /** Lowest MEP seen (for the debrief). */
  mepMin: number;
}

export interface TempClipState {
  on: boolean;
  /** Operation time when the current occlusion started. */
  since: number;
  /** Total occlusion time (s), all episodes. */
  total: number;
  /** Longest single occlusion (s). */
  longest: number;
  episodes: number;
}

const spatula = (): SpatulaState => ({ inserted: 0, placed: false, retraction: 0 });

export const state: SimState = {
  started: false,
  quality: 'high',
  activeTool: null,
  fissureOpen: FISSURE.initialOpen,
  spatulas: { frontal: spatula(), temporal: spatula() },
  retractionPressure: 0,
  retractionOverTime: 0,
  neckDissection: 0,
  ruptureRisk: 0,
  ebl: 0,
  bleedingRate: 0,
  fieldBlood: 0,
  identified: {},
  stage: 0,
  stageTimes: [],
  heartRate: PHYSIOLOGY.heartRate,
  respRate: PHYSIOLOGY.respRate,
  elapsed: 0,
  vitals: { hr: PHYSIOLOGY.heartRate, sbp: 112, dbp: 64, map: 80, spo2: 99, etco2: 34, rr: 12, pi: 3.2, co: 4.8, ppv: 4, mep: 100, mepMin: 100 },
  tempClip: { on: false, since: 0, total: 0, longest: 0, episodes: 0 },
  ruptureAt: null,
  clip: { applied: false, id: 0, pose: null, eval: null },
  checks: { icgClipId: -1, icgRuns: 0, doppler: {} },
  clipHistory: [],
  patient: { rhythm: 'sinus', arrest: false, arrestAt: null, roscCount: 0, dead: false, deathCause: '', anoxia: 0, swelling: 0, fluids: 0, mtp: false, volumeDeficit: 0 },
  ended: null,
  demo: false,
  ruptureReason: '',
  timeline: [],
  history: [],
};

/** Seconds of the current temporary occlusion (0 if none). */
export function occlusionSeconds(): number {
  return state.tempClip.on ? state.elapsed - state.tempClip.since : 0;
}

/** Raise the hidden rupture risk (0 … 1). Returns the new value. */
export function addRuptureRisk(amount: number): number {
  state.ruptureRisk = Math.min(1, state.ruptureRisk + amount);
  return state.ruptureRisk;
}
