import type * as THREE from 'three';
import type { Anatomy } from '../anatomy';
import { tissueGlobals, type TissueMaterial } from '../anatomy/materials';
import { xrayMaterial } from '../tools/clipModels';
import { audio } from '../audio/engine';
import type { MicroscopeLights } from '../scene/lights';
import type { PostFX } from '../scene/postfx';
import { events } from '../state/events';
import { state } from '../state/store';
import type { FlowModel } from './flow';

/**
 * ICG videoangiography (indocyanine green, 0.2–0.5 mg/kg IV, NIR ~800 nm).
 *
 * After injection the dye reaches the ICA and fills the arteries in order of their distance and
 * flow (arterial phase), then blushes the cortex (capillary phase) and finally lights up the
 * veins (venous phase) before washing out. The microscope switches to its near-infrared camera:
 * the image turns monochrome and only fluorescing blood is bright.
 *
 * Everything shown is computed from the flow model: a vessel with less flow fills later and
 * dimmer, an occluded one stays dark, and an aneurysm that still fills past the clip glows —
 * which is exactly how the surgeon judges the clip.
 */
const DURATION = 20;
/** Seconds from injection to arrival in the ICA (compressed from the real ~10–15 s). */
const ARRIVAL = 1.2;

interface Params {
  arrive: number;
  peak: number;
  transit: number;
  cutV?: number;
  above?: number;
}

export class IcgAngiography {
  running = false;
  t = 0;
  private mix = 0;

  constructor(
    private anatomy: Anatomy,
    private flow: FlowModel,
    private lights: MicroscopeLights,
    private fx: () => PostFX,
    private scene: { environmentIntensity: number },
  ) {}

  get progress() {
    return this.running ? this.t / DURATION : 0;
  }

  get time() {
    return this.t;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.t = 0;
    this.configure();
    state.checks.icgRuns++;
    state.checks.icgClipId = state.clip.applied ? state.clip.id : -1;
    audio.tick(1200, 0.05);
    events.emit('icg:started', { time: state.elapsed });
  }

  private set(m: TissueMaterial, p: Params) {
    const u = m.userData.tissue;
    u.uIcgArrive.value = p.arrive;
    u.uIcgPeak.value = p.peak;
    u.uIcgTransit.value = p.transit;
    u.uIcgCutV.value = p.cutV ?? 2;
    u.uIcgAbove.value = p.above ?? 1;
  }

  /** Arrival and brightness for each tissue from the current flows (captured at injection). */
  private configure() {
    const fl = this.flow;
    const late = (base: number, flow: number) => base + Math.min(6, 0.8 * (1 / Math.max(0.05, flow) - 1));
    const bright = (flow: number) => Math.min(1, Math.sqrt(Math.max(0, flow)));
    const BASE: Record<string, number> = { ica: 0, m1: 0.35, m2s: 0.65, m2i: 0.7, a1: 0.45, pcom: 0.4, acha: 0.45, lsa1: 0.5, lsa2: 0.55 };
    for (const v of this.anatomy.vessels.values()) {
      const f = fl.forVessel(v.id);
      let p: Params = { arrive: late(BASE[v.id] ?? 0.5, f), peak: bright(f), transit: v.length / 60 };
      if (v.id === 'pcom' && (fl.clipFactor.pcom ?? 1) < 0.2) {
        // Occluded at its origin: it fills late and faintly, backwards from the posterior circulation.
        p = { arrive: 3.4, peak: 0.3, transit: -v.length / 40 };
      }
      if (v.id === 'ica') p.transit = v.length / 90;
      this.set(v.material, p);
    }
    // Aneurysm: the part below the clip (neck remnant) fills from the ICA; the fundus only through
    // whatever the blades leave open. Unclipped, the sac fills slowly through its neck.
    const an = this.anatomy.aneurysm;
    const pose = state.clip.applied ? state.clip.pose : null;
    const neckFlow = fl.flow.icaDistal;
    this.set(an.material, {
      arrive: late(0.45, neckFlow) + 0.25,
      peak: bright(neckFlow) * 0.95,
      transit: 0.9,
      cutV: pose ? an.vAtHeight(pose.h) : 2,
      above: pose ? (fl.clipFactor.aneurysm ?? 1) : 1,
    });
    // Capillary blush of the cortex, then the veins.
    const mcaF = fl.flow.mca;
    for (const lobe of [this.anatomy.frontal, this.anatomy.temporal]) {
      this.set(lobe.material, { arrive: late(2.6, mcaF), peak: 0.13 * bright(mcaF), transit: 0 });
      lobe.group.traverse((o) => {
        const m = (o as THREE.Mesh).material as TissueMaterial | undefined;
        if (o.userData.kind === 'vein' && m?.userData?.tissue) this.set(m, { arrive: late(6.2, mcaF), peak: 0.85 * bright(mcaF), transit: 1.2 });
      });
    }
    this.anatomy.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as TissueMaterial | undefined;
      if (!m?.userData?.tissue) return;
      if (o.userData.id === 'insula') this.set(m, { arrive: late(2.5, mcaF), peak: 0.12, transit: 0 });
    });
  }

  update(dt: number) {
    if (this.running) {
      this.t += dt;
      if (this.t >= DURATION) {
        this.running = false;
        events.emit('icg:finished', { time: state.elapsed });
      }
    }
    const target = this.running && this.t < DURATION - 1.2 ? 1 : 0;
    this.mix += (target - this.mix) * (1 - Math.exp(-dt * 5));
    if (this.mix < 0.001) this.mix = 0;
    tissueGlobals.uIcgMix.value = this.mix;
    tissueGlobals.uIcgTime.value = this.t - ARRIVAL;
    // The NIR filter blocks the white light: only fluorescence remains.
    this.lights.setIntensity(1 - 0.94 * this.mix);
    this.scene.environmentIntensity = 0.5 * (1 - 0.95 * this.mix);
    this.fx().microscope.icg = this.mix;
    // Metal is dark in near-infrared: fade the clip's X-ray silhouette during the run.
    xrayMaterial.opacity = 0.28 * (1 - this.mix);
  }
}

