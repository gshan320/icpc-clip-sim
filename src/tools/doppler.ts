import * as THREE from 'three';
import { createSteelMaterial } from '../anatomy/materials';
import { audio } from '../audio/engine';
import type { FlowModel } from '../physics/flow';
import type { Hemodynamics } from '../physics/hemodynamics';
import { events } from '../state/events';
import { state } from '../state/store';
import type { InstrumentModel } from './models';
import { Tool, type Hover, type ToolContext, type ToolStatus } from './tool';

/** Holding the probe this long on one vessel counts as having checked it. */
const CHECK_TIME = 1.2;

function probeModel(): InstrumentModel {
  const root = new THREE.Group();
  const steel = createSteelMaterial({ color: 0xd0d4d8 });
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), new THREE.MeshPhysicalMaterial({ color: 0x2b3b4a, roughness: 0.3, clearcoat: 1 }));
  root.add(tip);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 30, 16), steel);
  shaft.position.y = 15;
  root.add(shaft);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.1, 60, 20), new THREE.MeshPhysicalMaterial({ color: 0x3a4652, roughness: 0.4 }));
  body.position.y = 60;
  root.add(body);
  root.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).castShadow = true, (o.userData = { kind: 'cursor' })) : null));
  return { root, setJaw: () => {}, setGlow: () => {}, shafted: true };
}

/**
 * Micro-Doppler (16–20 MHz) probe. Hold it on a vessel: a pulsatile "whoosh" means flow, silence
 * means none. After clipping, the PCom and the anterior choroidal must still sound, and the dome
 * should be silent. A high-pitched, harsh signal over the ICA beside the clip means it is narrowed.
 */
export class DopplerTool extends Tool {
  readonly id = 'doppler' as const;
  readonly name = 'Micro Doppler';
  readonly key = '8';
  override pressDepth = 0.12;
  private target: string | null = null;
  private held = 0;
  private reported = false;
  private level = 0;

  constructor(ctx: ToolContext, private flow: FlowModel, private engine: Hemodynamics) {
    super(ctx);
    this.model = probeModel();
  }

  /** Velocity factor under the probe for a hovered structure, or null for no vessel. */
  private source(h: Hover | null): { id: string; kind: 'artery' | 'vein' | 'sac' } | null {
    if (!h) return null;
    if (h.kind === 'vessel') return { id: h.id, kind: 'artery' };
    if (h.kind === 'vein') return { id: 'vein', kind: 'vein' };
    if (h.kind === 'aneurysm') return { id: 'aneurysm', kind: 'sac' };
    return null;
  }

  private velocityFn(src: { id: string; kind: string } | null): ((p: number, resp: number) => number) | null {
    if (!src) return null;
    const fl = this.flow;
    if (src.kind === 'vein') return (_p, resp) => 0.2 + 0.05 * resp;
    if (src.kind === 'sac') {
      // Swirling flow in a sac that still fills; silence once it is excluded.
      return (p) => {
        const inflow = fl.flow.aneurysm;
        return inflow * (0.22 + 0.5 * p) * (0.85 + Math.random() * 0.3);
      };
    }
    return (p) => {
      let f = fl.forVessel(src.id);
      // Narrowed ICA under a clip: faster jet through the narrowing.
      if (src.id === 'ica' && fl.stenosis > 0.15) f = Math.min(1.8, f / (1 - fl.stenosis * 0.8));
      // Brain arteries are low-resistance: forward flow continues through diastole.
      return f * (0.32 + 0.68 * p);
    };
  }

  status(h: Hover | null): ToolStatus {
    const src = this.source(h);
    if (!src) return { text: 'Micro Doppler — hold on a vessel to listen', level: 'idle' };
    if (!this.pressed) return { text: 'Hold to insonate', level: 'ok' };
    return { text: this.level > 0.08 ? 'Flow signal' : 'No flow signal', level: this.level > 0.08 ? 'ok' : 'warn' };
  }

  override deactivate() {
    this.engine.dopplerProbe = null;
    audio.doppler(0);
  }

  override onUp() {
    this.engine.dopplerProbe = null;
    this.target = null;
    this.held = 0;
    this.reported = false;
    audio.doppler(0);
  }

  override onHold(h: Hover | null, dt: number) {
    const src = this.source(h);
    const id = src?.id ?? null;
    if (id !== this.target) {
      this.target = id;
      this.held = 0;
      this.reported = false;
      this.engine.dopplerProbe = this.velocityFn(src);
    }
    if (!src) return;
    this.held += dt;
    if (this.held > CHECK_TIME && !this.reported) {
      this.reported = true;
      const flow = src.kind === 'sac' ? this.flow.flow.aneurysm : src.kind === 'vein' ? 0.2 : this.flow.forVessel(src.id);
      state.checks.doppler[src.id] = { clipId: state.clip.applied ? state.clip.id : -1, flow };
      events.emit('doppler:heard', { vessel: src.id, flow });
    }
  }

  override update(dt: number) {
    const buf = this.engine.doppler;
    const v = this.pressed && this.engine.dopplerProbe ? buf.at(buf.count - 1) : 0;
    this.level += (v - this.level) * (1 - Math.exp(-dt * 20));
    audio.doppler(v);
  }
}
