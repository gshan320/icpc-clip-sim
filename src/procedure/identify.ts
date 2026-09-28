import type * as THREE from 'three';
import { audio } from '../audio/engine';
import { events } from '../state/events';
import { state } from '../state/store';

/**
 * Structure identification: hold the cursor (or an instrument tip) on a structure for a moment
 * and it counts as identified. Only unobstructed structures can be pointed at, so you have to
 * expose them first — as in surgery, you name what you can actually see.
 */
export const IDENTIFIABLE: Record<string, string> = {
  m1: 'M1 — middle cerebral artery',
  m2s: 'M2 superior trunk',
  m2i: 'M2 inferior trunk',
  a1: 'A1 — anterior cerebral artery',
  ica: 'Internal carotid artery',
  pcom: 'Posterior communicating artery',
  acha: 'Anterior choroidal artery',
  optic: 'Optic nerve (CN II)',
  oculomotor: 'Oculomotor nerve (CN III)',
  aneurysm: 'IC-PC aneurysm',
};

const DWELL = 0.9;

export interface PointedAt {
  id: string;
  point: THREE.Vector3;
}

export class IdentificationTracker {
  private current: string | null = null;
  private dwell = 0;

  /** Call every frame with what is under the cursor (or null). */
  update(dt: number, at: PointedAt | null) {
    const id = at && IDENTIFIABLE[at.id] ? at.id : null;
    if (id !== this.current) {
      this.current = id;
      this.dwell = 0;
    }
    if (!id || !at || state.identified[id]) return;
    this.dwell += dt;
    if (this.dwell >= DWELL) {
      state.identified[id] = true;
      audio.tick(1320, 0.05);
      setTimeout(() => audio.tick(1760, 0.05), 90);
      events.emit('structure:identified', { id, label: IDENTIFIABLE[id], point: { x: at.point.x, y: at.point.y, z: at.point.z } });
    }
  }

  /** Dwell progress 0…1 on a not-yet-identified structure, or null. */
  get progress(): number | null {
    if (!this.current || state.identified[this.current]) return null;
    return this.dwell > 0.12 ? Math.min(1, this.dwell / DWELL) : null;
  }
}
