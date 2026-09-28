import * as THREE from 'three';
import type { Anatomy } from '../anatomy';
import { audio } from '../audio/engine';
import { events, toast } from '../state/events';
import { state } from '../state/store';
import type { BloodSystem } from './blood';

/**
 * Intraoperative rupture.
 *
 * Rough handling of the dome raises a hidden rupture risk (0…1). Above a threshold, rupture
 * becomes possible and increasingly likely each second — more so with high systolic pressure —
 * and certain at 1. Cutting the dome ruptures it immediately. A rupture usually opens at the
 * bleb, the thinnest part of the wall.
 *
 * A ruptured IC-PC aneurysm bleeds torrentially at arterial pressure. The standard response:
 * keep the field visible with suction, get proximal control with a temporary clip on the ICA,
 * then clip the neck definitively.
 */
/** Torrential: an IC-PC rupture at arterial pressure fills the field in seconds (≈300 mL/min). */
export const RUPTURE_BASE_RATE = 5; // mL/s at normal flow and pressure

export class RuptureModel {
  private rand = Math.random;

  constructor(private anatomy: Anatomy, private blood: BloodSystem) {
    events.on('aneurysm:breach', ({ point, reason }) => {
      this.rupture(point ? new THREE.Vector3(point.x, point.y, point.z) : null, reason);
    });
  }

  get ruptured() {
    return state.ruptureAt !== null;
  }

  update(dt: number) {
    if (this.ruptured) {
      // An uncontrolled tear extends: bleeding grows ~12 %/min until the neck is clipped.
      const o = this.blood.oozes.find((x) => x.label === 'Aneurysm rupture' && x.active);
      if (o && !state.clip.applied) o.baseRate = Math.min(RUPTURE_BASE_RATE * 2, o.baseRate + dt * RUPTURE_BASE_RATE * 0.002);
      return;
    }
    if (!state.started || state.demo) return;
    const r = state.ruptureRisk;
    if (r >= 1) return this.rupture(null, 'excessive manipulation of the dome');
    if (r > 0.3) {
      const pressure = (state.vitals.sbp / 115) ** 2;
      const pPerSec = 0.45 * ((r - 0.3) / 0.7) ** 1.5 * pressure;
      if (this.rand() < pPerSec * dt) this.rupture(null, 'manipulation of the dome');
    }
  }

  rupture(at: THREE.Vector3 | null, reason: string) {
    if (this.ruptured) return;
    const an = this.anatomy.aneurysm;
    const point = at ?? an.bleb.clone();
    const normal = point.clone().sub(an.domeCenter).normalize();
    state.ruptureAt = state.elapsed;
    state.ruptureReason = reason;
    state.ruptureRisk = 1;
    this.blood.addOoze({
      object: an.mesh,
      point,
      normal,
      kind: 'arterial',
      rate: RUPTURE_BASE_RATE,
      label: 'Aneurysm rupture',
      selfLimiting: false,
      vesselId: 'aneurysm',
      coagulable: false,
    });
    audio.caution();
    toast('INTRAOPERATIVE RUPTURE — suction, temporary clip on the ICA, then clip the neck', 'danger');
    events.emit('aneurysm:ruptured', { time: state.elapsed, reason });
  }
}
