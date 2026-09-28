import type { Anatomy } from '../anatomy';
import type { BloodSystem } from '../physics/blood';
import { SAFE_RETRACTION_MMHG, type FissureModel } from '../physics/fissure';
import { state } from '../state/store';

/**
 * The six steps of the operation, as taught. Each stage has calm, short mentor guidance,
 * sub-tasks that are checked automatically from what the learner actually does, and live
 * guidelines (things to keep doing right, shown but not required).
 */
export interface StageContext {
  anatomy: Anatomy;
  fissure: FissureModel;
  blood: BloodSystem;
}

export interface SubTask {
  id: string;
  label: (c: StageContext) => string;
  /** 0…1. A task is done at 1. */
  progress: (c: StageContext) => number;
  /** Once done, stays done (e.g. an identified structure stays identified). */
  sticky?: boolean;
  /** Milestone in which the capability arrives, if not yet available. */
  pending?: string;
}

export interface Guideline {
  label: (c: StageContext) => string;
  ok: (c: StageContext) => boolean;
}

export interface GuideView {
  target: [number, number, number];
  azimuthDeg: number;
  polarDeg: number;
  zoom: number;
}

export interface StageDef {
  id: string;
  title: string;
  /** One-line summary for the checklist. */
  short: string;
  /** Mentor guidance: two or three calm sentences. */
  guidance: string;
  tasks: SubTask[];
  guidelines?: Guideline[];
  view: GuideView;
  /** Suggested instrument key(s). */
  tools: string;
}

const cutFraction = (c: StageContext, group: string) => c.fissure.cutFraction(group);
const cutCount = (c: StageContext, group: string) => {
  let n = 0, t = 0;
  for (const p of c.anatomy.arachnoid.values()) {
    if (p.config.group !== group) continue;
    t++;
    if (p.cut) n++;
  }
  return `${n}/${t}`;
};
const identified = (id: string) => () => (state.identified[id] ? 1 : 0);
/** Heard flow in this vessel with the current clip in place? */
const dopplerOk = (id: string, min: number) => {
  const d = state.checks.doppler[id];
  return state.clip.applied && d && d.clipId === state.clip.id && d.flow >= min ? 1 : 0;
};

const noActiveBleeding: Guideline = {
  label: () => (state.bleedingRate > 0.005 ? 'Control active bleeding' : state.fieldBlood >= 1.5 ? 'Blood in the field — suction' : 'Field dry'),
  ok: () => state.bleedingRate <= 0.005 && state.fieldBlood < 1.5,
};
const shortOcclusion: Guideline = {
  label: () => (state.tempClip.on ? `Temporary occlusion ${Math.floor((state.elapsed - state.tempClip.since) / 60)}:${String(Math.floor((state.elapsed - state.tempClip.since) % 60)).padStart(2, '0')} (keep < 5:00)` : 'No temporary occlusion running'),
  ok: () => !state.tempClip.on || state.elapsed - state.tempClip.since < 300,
};
const gentleRetraction: Guideline = {
  label: () => `Retraction ${state.retractionPressure.toFixed(0)} mmHg (keep < ${SAFE_RETRACTION_MMHG})`,
  ok: () => state.retractionPressure <= SAFE_RETRACTION_MMHG,
};

export const STAGES: StageDef[] = [
  {
    id: 'fissure',
    title: 'Open the sylvian fissure',
    short: 'Split the arachnoid, place a spatula',
    guidance:
      'Split the superficial arachnoid along the fissure with the micro-scissors, staying on the frontal side of the sylvian veins. ' +
      'Each cut lets CSF out and the lobes fall apart. Once there is room, rest a spatula gently on the frontal lobe.',
    tools: '2 · 5',
    tasks: [
      {
        id: 'ss',
        label: (c) => `Cut the superficial sylvian arachnoid (${cutCount(c, 'sylvian-superficial')})`,
        progress: (c) => cutFraction(c, 'sylvian-superficial'),
        sticky: true,
      },
      {
        id: 'spatula',
        label: () => 'Place a spatula on the frontal lobe',
        progress: () => (state.spatulas.frontal.placed ? 1 : 0),
      },
    ],
    guidelines: [gentleRetraction, noActiveBleeding],
    view: { target: [0.6, -0.5, 8], azimuthDeg: 10, polarDeg: 90, zoom: 1 },
  },
  {
    id: 'm1',
    title: 'Identify M1',
    short: 'Deep sylvian dissection',
    guidance:
      'Work deeper along the fissure. Open the arachnoid around the middle cerebral branches, then follow the M2 trunks back to where they join — ' +
      'that is M1, running medially toward the carotid. Hold the cursor on it to identify it.',
    tools: '2 · 1',
    tasks: [
      {
        id: 'sd',
        label: (c) => `Open the deep sylvian arachnoid (${cutCount(c, 'sylvian-deep')})`,
        progress: (c) => cutFraction(c, 'sylvian-deep'),
        sticky: true,
      },
      { id: 'id-m1', label: () => 'Identify M1', progress: identified('m1'), sticky: true },
    ],
    guidelines: [gentleRetraction, noActiveBleeding],
    view: { target: [10, 5, 1], azimuthDeg: 18, polarDeg: 92, zoom: 1.35 },
  },
  {
    id: 'ica',
    title: 'Identify the ICA and optic nerve',
    short: 'Open the carotid cistern',
    guidance:
      'Follow M1 medially to the carotid bifurcation. Open the carotid cistern membrane, then identify the internal carotid artery and, ' +
      'medial to it, the flat white optic nerve. The gap between them is the opticocarotid window.',
    tools: '2',
    tasks: [
      {
        id: 'cc',
        label: (c) => `Open the carotid cistern (${cutCount(c, 'carotid-cistern')})`,
        progress: (c) => cutFraction(c, 'carotid-cistern'),
        sticky: true,
      },
      { id: 'id-ica', label: () => 'Identify the internal carotid artery', progress: identified('ica'), sticky: true },
      { id: 'id-optic', label: () => 'Identify the optic nerve', progress: identified('optic'), sticky: true },
    ],
    guidelines: [noActiveBleeding],
    view: { target: [-3.5, -1, -1], azimuthDeg: 4, polarDeg: 90, zoom: 1.35 },
  },
  {
    id: 'neck',
    title: 'Confirm the PCom and dissect the neck',
    short: 'PCom, AChA, free the neck',
    guidance:
      'The aneurysm arises where the PCom leaves the back wall of the ICA. Tilt the scope to look through the opticocarotid window and identify the PCom, ' +
      'then the anterior choroidal just distal to it. Free the neck with the dissector, sweeping along its base — never press on the dome.',
    tools: '4',
    tasks: [
      { id: 'id-pcom', label: () => 'Identify the PCom', progress: identified('pcom'), sticky: true },
      { id: 'id-acha', label: () => 'Identify the anterior choroidal artery', progress: identified('acha'), sticky: true },
      {
        id: 'neck',
        label: () => `Free the aneurysm neck (${Math.round(state.neckDissection * 100)}%)`,
        progress: () => Math.min(1, state.neckDissection / 0.8),
        sticky: true,
      },
    ],
    guidelines: [
      { label: () => 'Minimal pressure on the dome', ok: () => state.ruptureRisk < 0.3 },
      shortOcclusion,
      noActiveBleeding,
    ],
    view: { target: [-2, -2.2, -1.5], azimuthDeg: 22, polarDeg: 74, zoom: 1.8 },
  },
  {
    id: 'clip',
    title: 'Clip the aneurysm',
    short: 'Close the neck, spare the branches',
    guidance:
      'Choose a clip that matches the neck and bring its blades in parallel to the ICA, across the neck, below the PCom and AChA origins. ' +
      'Set the blade depth to cover the whole neck, then close it slowly.',
    tools: '6',
    tasks: [
      {
        id: 'clip-applied',
        label: () => 'Apply a clip across the neck',
        progress: () => (state.clip.applied && state.clip.eval?.onNeck ? 1 : 0),
      },
      {
        id: 'clip-icg',
        label: () => 'ICG: the dome no longer fills (7)',
        progress: () => {
          const c = state.clip;
          const e = c.eval;
          return c.applied && e && state.checks.icgClipId === c.id && e.closure >= 0.97 && e.residualMm <= 0.6 ? 1 : 0;
        },
      },
    ],
    guidelines: [shortOcclusion, noActiveBleeding],
    view: { target: [0.6, -0.8, -0.8], azimuthDeg: 14, polarDeg: 88, zoom: 2.2 },
  },
  {
    id: 'patency',
    title: 'Confirm PCom patency',
    short: 'Doppler and ICG',
    guidance:
      'Confirm the result with flow, not just by eye. Hold the micro-Doppler on the PCom, the anterior choroidal and the ICA beside the clip: ' +
      'each should give a clean pulsatile signal. Then run ICG: both branches should fill while the dome stays dark.',
    tools: '8 · 7',
    tasks: [
      { id: 'dop-pcom', label: () => 'Doppler: flow in the PCom (8)', progress: () => dopplerOk('pcom', 0.3) },
      { id: 'dop-acha', label: () => 'Doppler: flow in the AChA', progress: () => dopplerOk('acha', 0.3) },
      { id: 'dop-ica', label: () => 'Doppler: normal ICA signal beside the clip', progress: () => (dopplerOk('ica', 0.3) && (state.clip.eval?.stenosis ?? 1) < 0.35 ? 1 : 0) },
      {
        id: 'icg',
        label: () => 'ICG: PCom and AChA fill, dome stays dark',
        progress: () => {
          const c = state.clip;
          const e = c.eval;
          return c.applied && e && state.checks.icgClipId === c.id && e.pcom > 0.6 && e.acha > 0.6 && e.closure >= 0.97 ? 1 : 0;
        },
      },
    ],
    guidelines: [noActiveBleeding],
    view: { target: [-1, -1.5, -1], azimuthDeg: 8, polarDeg: 82, zoom: 1.8 },
  },
];
