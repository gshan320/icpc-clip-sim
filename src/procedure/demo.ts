import gsap from 'gsap';
import * as THREE from 'three';
import type { Anatomy } from '../anatomy';
import type { CameraRig } from '../scene/cameraRig';
import { insideField } from '../scene/field';
import { events, toast } from '../state/events';
import { state, type ToolId } from '../state/store';
import type { ToolManager } from '../tools/manager';
import type { ProcedureManager } from './manager';

/**
 * Demo mode: plays the operation step by step with the same instruments and rules the learner
 * uses (a virtual hand drives the tool manager), with narration. Any click or key press hands
 * control back to the learner exactly where the demo is.
 */
class Aborted extends Error {}

export class DemoDirector {
  running = false;
  private aborted = false;
  private ndc = new THREE.Vector2(0, -0.2);
  private caption: HTMLElement;
  private captionText: HTMLElement;

  constructor(
    private anatomy: Anatomy,
    private tools: ToolManager,
    private rig: CameraRig,
    private proc: ProcedureManager,
    root: HTMLElement,
  ) {
    this.captionText = document.createElement('span');
    this.caption = document.createElement('div');
    this.caption.className = 'demo-caption';
    const k = document.createElement('span');
    k.className = 'kicker';
    k.textContent = 'DEMO';
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'Click anywhere or press any key to take over';
    this.caption.append(k, this.captionText, hint);
    root.append(this.caption);
    const takeOver = (e: Event) => {
      if (!this.running || !e.isTrusted) return;
      this.stop(true);
    };
    window.addEventListener('pointerdown', takeOver, true);
    window.addEventListener('keydown', takeOver, true);
  }

  private check() {
    if (this.aborted) throw new Aborted();
  }

  private say(text: string) {
    this.captionText.textContent = text;
    this.caption.classList.add('on');
  }

  private wait(ms: number) {
    return new Promise<void>((res, rej) => {
      const t0 = performance.now();
      const tick = () => {
        if (this.aborted) return rej(new Aborted());
        if (performance.now() - t0 >= ms) return res();
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  private project(p: THREE.Vector3): THREE.Vector2 {
    const v = p.clone().project(this.rig.camera);
    return new THREE.Vector2(v.x, v.y);
  }

  /** Glide the virtual pointer to a world point (re-projected every frame as the scope moves). */
  private move(target: THREE.Vector3 | (() => THREE.Vector3), ms = 650, dragging = false) {
    const from = this.ndc.clone();
    const get = typeof target === 'function' ? target : () => target;
    const o = { t: 0 };
    return new Promise<void>((res, rej) => {
      let lastPx = { ...this.tools.pointerPx };
      gsap.to(o, {
        t: 1,
        duration: ms / 1000,
        ease: 'power2.inOut',
        onUpdate: () => {
          if (this.aborted) return;
          this.ndc.lerpVectors(from, this.project(get()), o.t);
          this.tools.setVirtualPointer(this.ndc);
          if (dragging) {
            const px = this.tools.pointerPx;
            this.tools.virtualDrag(px.x - lastPx.x, px.y - lastPx.y);
            lastPx = { ...px };
          }
        },
        onComplete: () => (this.aborted ? rej(new Aborted()) : res()),
      });
    });
  }

  private async click(holdMs = 70) {
    this.check();
    this.tools.virtualPress(true);
    await this.wait(holdMs);
    this.tools.virtualPress(false);
  }

  private pick(id: ToolId | null) {
    this.check();
    this.tools.select(id);
  }

  private key(k: string, times = 1) {
    for (let i = 0; i < times; i++) this.tools.active?.onKey(k, this.tools.hover);
  }

  private async view(stage: number) {
    this.rig.goTo(this.proc.stages[stage].view);
    await this.wait(1500);
  }

  /** A visible point on a vessel / nerve inside the field, if any. */
  private visible(id: string, from = 0, to = 1): THREE.Vector3 | null {
    const v = this.anatomy.vessels.get(id) ?? this.anatomy.nerves.get(id);
    if (!v) return null;
    const mesh = v.mesh;
    const pts = 'samples' in v ? v.samples : Array.from({ length: 40 }, (_, i) => v.curve.getPointAt(i / 39));
    const solids = this.anatomy.solids.filter((m) => m.userData.kind !== 'instrument');
    const cam = this.rig.camera.position;
    const ray = new THREE.Raycaster();
    (ray as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
    const n = pts.length;
    const order = [...Array(n).keys()].filter((i) => i >= n * from && i <= n * to);
    // Prefer the middle of the requested span.
    order.sort((a, b) => Math.abs(a - n * (from + to) / 2) - Math.abs(b - n * (from + to) / 2));
    for (const i of order) {
      ray.set(cam, pts[i].clone().sub(cam).normalize());
      const hit = ray.intersectObjects(solids, false)[0];
      if (hit && hit.object === mesh && insideField(this.project(hit.point), this.rig.camera.aspect, 0.4)) return hit.point.clone();
    }
    return null;
  }

  private patch(id: string) {
    return this.anatomy.arachnoid.get(id)!.mesh.getWorldPosition(new THREE.Vector3());
  }

  private async cutGroup(group: string) {
    this.pick('scissors');
    for (const p of this.anatomy.arachnoid.values()) {
      if (p.config.group !== group || p.cut) continue;
      await this.move(this.patch(p.id), 520);
      await this.wait(120);
      await this.click();
      await this.wait(260);
    }
  }

  private async identify(id: string, from = 0, to = 1) {
    // Point with the Doppler probe (held, not pressed): identification follows the instrument tip.
    if (this.tools.active?.id !== 'doppler') this.pick('doppler');
    const p = this.visible(id, from, to);
    if (!p) return;
    await this.move(p, 700);
    await this.wait(1250);
  }

  /** Sweep the dissector along the base of the neck. */
  private async dissectNeck(passes: number) {
    const an = this.anatomy.aneurysm;
    const ring = (a: number) => new THREE.Vector3(Math.cos(a) * an.neckRadius, 1.1, Math.sin(a) * an.neckRadius).applyMatrix4(an.mesh.matrixWorld);
    const cam = this.rig.camera.position;
    // Front half of the ring (facing the microscope).
    let best = 0, bd = 1e9;
    for (let a = 0; a < Math.PI * 2; a += 0.2) {
      const d = ring(a).distanceTo(cam);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    await this.move(ring(best - 1.1), 600);
    this.tools.virtualPress(true);
    for (let k = 0; k < passes; k++) {
      await this.move(ring(best + (k % 2 ? -1.1 : 1.1)), 900, true);
    }
    this.tools.virtualPress(false);
  }

  private sacPointAt(h: number) {
    const an = this.anatomy.aneurysm;
    const cam = this.rig.camera.position;
    let best = new THREE.Vector3(), bd = 1e9;
    for (let a = 0; a < Math.PI * 2; a += 0.15) {
      const q = new THREE.Vector3(Math.cos(a) * an.radiusAt(h), h, Math.sin(a) * an.radiusAt(h)).applyMatrix4(an.mesh.matrixWorld);
      const d = q.distanceTo(cam);
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    return best;
  }

  private async doppler(id: string) {
    const p = this.visible(id, 0.15, 0.9);
    if (!p) return;
    await this.move(p, 700);
    this.tools.virtualPress(true);
    await this.wait(1700);
    this.tools.virtualPress(false);
    await this.wait(250);
  }

  /** One scripted routine per step (index = stage). */
  private readonly steps: (() => Promise<void>)[] = [
    async () => {
      await this.view(0);
      this.say('Step 1 — splitting the superficial sylvian arachnoid with micro-scissors, frontal side of the veins.');
      await this.cutGroup('sylvian-superficial');
      await this.wait(1600);
      this.say('A spatula rests gently on the frontal operculum — the CSF release does most of the work.');
      this.pick('spatula');
      await this.move(() => new THREE.Vector3(13, this.anatomy.gap / 2 + 2.5, 13), 700);
      await this.click();
      await this.wait(1400);
    },
    async () => {
      await this.view(1);
      this.say('Step 2 — opening the deep sylvian arachnoid around the middle cerebral branches.');
      await this.cutGroup('sylvian-deep');
      await this.wait(1200);
      this.pick(null);
      this.say('Following the M2 trunks back to M1, running medially toward the carotid.');
      await this.identify('m1', 0.2, 0.8);
      await this.wait(600);
    },
    async () => {
      await this.view(2);
      this.say('Step 3 — opening the carotid cistern; then the ICA and, medial to it, the optic nerve.');
      await this.cutGroup('carotid-cistern');
      await this.wait(1000);
      this.pick(null);
      await this.identify('ica', 0.3, 0.9);
      await this.identify('optic', 0.2, 0.8);
      await this.wait(600);
    },
    async () => {
      await this.view(3);
      this.say('Step 4 — through the opticocarotid window: the PCom, then the anterior choroidal just distal to it.');
      this.pick(null);
      await this.identify('pcom', 0.05, 0.7);
      await this.identify('acha', 0.05, 0.7);
      this.say('Freeing the neck with the dissector — sweeping along its base, never pressing on the dome.');
      this.pick('dissector');
      await this.dissectNeck(8);
      if (state.neckDissection < 0.8) {
        this.say('Tilting the scope to reach the far side of the neck.');
        void this.rig.controls.rotate(THREE.MathUtils.degToRad(-14), THREE.MathUtils.degToRad(6), true);
        await this.wait(1200);
        await this.dissectNeck(8);
      }
      await this.wait(1200);
    },
    async () => {
      await this.view(4);
      this.say('Step 5 — a straight clip at the base of the neck, blades aligned with the ICA.');
      this.pick('clip');
      await this.move(() => this.sacPointAt(0.5), 800);
      await this.wait(400);
      for (let i = 0; i < 12; i++) {
        this.key('q');
        await this.wait(60);
      }
      await this.wait(500);
      await this.click();
      await this.wait(1200);
      this.say('ICG videoangiography — the dome should stay dark while the branches fill.');
      this.pick('icg');
      await this.click();
      await this.wait(9500);
    },
    async () => {
      this.say('Step 6 — micro-Doppler on the PCom, the anterior choroidal and the ICA beside the clip.');
      this.pick('doppler');
      await this.doppler('acha');
      await this.doppler('ica');
      await this.doppler('pcom');
      if (state.checks.icgClipId !== state.clip.id) {
        this.pick('icg');
        await this.click();
        await this.wait(9500);
      }
      await this.wait(1200);
      this.say('Done — aneurysm excluded, PCom, anterior choroidal and ICA patent.');
      await this.wait(2500);
    },
  ];

  /** Called when the demo reaches the end of the procedure. */
  onFinish: (() => void) | null = null;

  async start() {
    if (this.running) return;
    this.running = true;
    this.aborted = false;
    state.demo = true;
    this.tools.setVirtualPointer(this.ndc);
    try {
      let retries = 0;
      while (state.stage < this.steps.length && !state.ended) {
        const stage = state.stage;
        await this.steps[stage]();
        // The stage manager flips the step shortly after its tasks are met.
        const t0 = performance.now();
        while (state.stage === stage && performance.now() - t0 < 2500) await this.wait(100);
        if (state.stage === stage && ++retries > 1) break;
        if (state.stage !== stage) retries = 0;
      }
      const finished = state.stage >= this.steps.length;
      this.stop(false);
      if (finished) this.onFinish?.();
    } catch (e) {
      if (!(e instanceof Aborted)) {
        console.error(e);
        this.stop(false);
      }
    }
  }

  stop(takeOver: boolean) {
    if (!this.running) return;
    this.aborted = true;
    this.running = false;
    state.demo = false;
    this.tools.setVirtualPointer(null);
    this.caption.classList.remove('on');
    if (takeOver) {
      toast('You have control — carry on from here', 'info');
      events.emit('toast', { text: 'Demo stopped', level: 'info', key: 'demo-stop' });
    }
  }
}
