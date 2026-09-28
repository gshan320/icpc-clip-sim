import * as THREE from 'three';
import { tissueGlobals, type TissueMaterial } from '../anatomy/materials';
import { audio } from '../audio/engine';
import { events } from '../state/events';
import { insideField } from '../scene/field';
import { state, type ToolId } from '../state/store';
import type { Hover, StatusLevel, Tool, ToolContext, ToolStatus } from './tool';

const LEVEL_COLOR: Record<StatusLevel, number> = {
  ok: 0x5ad1e6,
  warn: 0xf3b34c,
  danger: 0xff5a5f,
  idle: 0x8497a1,
};
export const LEVEL_CSS: Record<StatusLevel, string> = {
  ok: '#5ad1e6',
  warn: '#f3b34c',
  danger: '#ff5a5f',
  idle: '#8497a1',
};

export interface ToolManagerHooks {
  /** Show the status tag near the cursor. */
  setTag(text: string | null, x: number, y: number, color?: string): void;
  /** Extra pickable objects (pool, bleeding points, …). */
  extraPickables(): THREE.Object3D[];
}

/**
 * Routes input to the active instrument and renders it as a 3D cursor:
 *  - picks what is under the pointer every frame (also while the scope moves),
 *  - glides the instrument tip there with a little inertia,
 *  - highlights valid / risky targets in cyan / amber / red,
 *  - pushes tissue in under the tip when pressed.
 */
export class ToolManager {
  readonly tools = new Map<ToolId, Tool>();
  active: Tool | null = null;
  hover: Hover | null = null;
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2(0, 0);
  private px = { x: 0, y: 0 };
  private inside = false;
  private pressed = false;
  private last = { x: 0, y: 0 };
  private tip = new THREE.Vector3();
  private tipPrev = new THREE.Vector3();
  private tipSpeed = 0;
  private tipValid = false;
  private cursorVisible = 0;
  private highlights = new Map<TissueMaterial, { value: number; target: number }>();
  private readonly group = new THREE.Group();
  private tmp = new THREE.Vector3();
  private basis = new THREE.Matrix4();
  /** Demo playback drives the instruments through a virtual pointer. */
  private virtual = false;

  constructor(
    private ctx: ToolContext,
    private dom: HTMLElement,
    scene: THREE.Scene,
    private hooks: ToolManagerHooks,
  ) {
    (this.raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = false;
    this.group.name = 'instruments';
    scene.add(this.group);

    dom.addEventListener('pointermove', (e) => {
      if (this.virtual) return;
      const r = dom.getBoundingClientRect();
      this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      if (this.pressed && this.active) this.active.onDrag(e.clientX - this.last.x, e.clientY - this.last.y, this.hover);
      this.last = { x: e.clientX, y: e.clientY };
      this.px = { x: e.clientX, y: e.clientY };
      this.inside = true;
    });
    dom.addEventListener('pointerleave', () => {
      if (this.virtual) return;
      this.inside = false;
      this.release();
    });
    dom.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.altKey || e.shiftKey || !this.active || state.ended || this.virtual) return;
      this.pressed = true;
      this.active.pressed = true;
      this.last = { x: e.clientX, y: e.clientY };
      dom.setPointerCapture(e.pointerId);
      this.active.onDown(this.hover);
    });
    dom.addEventListener('pointerup', (e) => {
      if (e.button !== 0) return;
      this.release();
    });
    window.addEventListener('blur', () => this.release());
    dom.addEventListener(
      'wheel',
      (e) => {
        if (this.active?.onWheel(e.deltaY, this.hover)) e.preventDefault();
      },
      { passive: false },
    );

    window.addEventListener('keydown', (e) => {
      if (!state.started || state.ended || e.metaKey || e.ctrlKey) return;
      if ((e.target as HTMLElement)?.closest?.('input, textarea')) return;
      if (e.key === 'Escape') {
        this.select(null);
        return;
      }
      for (const t of this.tools.values()) {
        if (t.key === e.key) {
          this.select(t.id);
          e.preventDefault();
          return;
        }
      }
      if (this.active?.onKey(e.key === 'Tab' ? 'tab' : e.key.toLowerCase(), this.hover)) e.preventDefault();
    });
  }

  // ---------------------------------------------------------------- virtual pointer (demo)

  /** Drive the pointer from code (NDC), or hand it back to the mouse with null. */
  setVirtualPointer(ndc: THREE.Vector2 | null) {
    if (!ndc) {
      this.release();
      this.virtual = false;
      this.inside = false;
      return;
    }
    this.virtual = true;
    this.ndc.copy(ndc);
    const r = this.dom.getBoundingClientRect();
    this.px = { x: r.left + ((ndc.x + 1) / 2) * r.width, y: r.top + ((1 - ndc.y) / 2) * r.height };
    this.inside = true;
  }

  virtualPress(down: boolean) {
    if (!this.active) return;
    if (down) {
      this.pressed = true;
      this.active.pressed = true;
      this.last = { ...this.px };
      this.active.onDown(this.hover);
    } else this.release();
  }

  virtualDrag(dx: number, dy: number) {
    if (this.pressed && this.active) this.active.onDrag(dx, dy, this.hover);
  }

  get pointerPx() {
    return this.px;
  }

  private release() {
    if (!this.pressed) return;
    this.pressed = false;
    if (this.active) {
      this.active.pressed = false;
      this.active.onUp(this.hover);
    }
  }

  register(tool: Tool) {
    this.tools.set(tool.id, tool);
    if (tool.model) {
      tool.model.root.visible = false;
      this.group.add(tool.model.root);
    }
  }

  select(id: ToolId | null) {
    const next = id ? this.tools.get(id) ?? null : null;
    if (next && !next.available) {
      events.emit('toast', { text: `${next.name} arrives in milestone ${next.milestone}`, level: 'info', key: `na-${next.id}` });
      return;
    }
    if (next === this.active) return;
    this.release();
    if (this.active) {
      this.active.deactivate();
      if (this.active.model) this.active.model.root.visible = false;
    }
    this.active = next;
    this.tipValid = false;
    this.cursorVisible = 0;
    state.activeTool = next?.id ?? null;
    next?.activate();
    audio.tick(next ? 1500 : 900);
    events.emit('tool:changed', { tool: state.activeTool });
  }

  /** Objects the instruments can touch. */
  private pickables(): THREE.Object3D[] {
    const list: THREE.Object3D[] = [];
    const { anatomy } = this.ctx;
    for (const p of anatomy.arachnoid.values()) if (!p.cut && p.mesh.visible) list.push(p.mesh);
    for (const m of anatomy.solids) list.push(m);
    for (const o of this.hooks.extraPickables()) list.push(o);
    if (this.active) for (const o of this.active.extraPickables()) list.push(o);
    return list;
  }

  private pick(): Hover | null {
    if (!this.inside || !insideField(this.ndc, this.ctx.camera.aspect)) return null;
    this.raycaster.setFromCamera(this.ndc, this.ctx.camera);
    const hits = this.raycaster.intersectObjects(this.pickables(), false);
    const ignore = this.active?.ignoreKinds;
    for (const h of hits) {
      const o = h.object as THREE.Mesh;
      if (!isShown(o)) continue;
      const kind = (o.userData.kind as string) ?? 'unknown';
      if (ignore?.has(kind)) continue;
      if (kind === 'instrument' && !this.active?.pickInstruments) continue;
      // Through the clear window that suction holds open in the blood.
      if (kind === 'blood' && this.ctx.blood.inSuctionWindow(h.point)) continue;
      const normal = h.face ? h.face.normal.clone().transformDirection(o.matrixWorld) : new THREE.Vector3(0, 0, 1);
      // Face the camera (double-sided membranes).
      if (normal.dot(this.raycaster.ray.direction) > 0) normal.negate();
      return { object: o, point: h.point.clone(), normal, kind, id: String(o.userData.id ?? ''), label: String(o.userData.label ?? '') };
    }
    return null;
  }

  private setHighlight(h: Hover | null, s: ToolStatus | null) {
    for (const v of this.highlights.values()) v.target = 0;
    if (h && s && s.level !== 'idle') {
      const mat = h.object.material as TissueMaterial;
      const tu = mat?.userData?.tissue;
      if (tu) {
        tu.uHighlightColor.value.setHex(LEVEL_COLOR[s.level]);
        const e = this.highlights.get(mat) ?? { value: 0, target: 0 };
        e.target = s.level === 'danger' ? 1 : 0.8;
        this.highlights.set(mat, e);
      }
    }
  }

  private updateHighlights(dt: number) {
    const k = 1 - Math.exp(-dt * 14);
    for (const [mat, e] of this.highlights) {
      e.value += (e.target - e.value) * k;
      mat.userData.tissue.uHighlight.value = e.value;
      if (e.target === 0 && e.value < 0.002) {
        mat.userData.tissue.uHighlight.value = 0;
        this.highlights.delete(mat);
      }
    }
  }

  /** Orient an instrument: tip at `tip`, shaft entering from the surgeon's side of the field. */
  private placeModel(tool: Tool, tip: THREE.Vector3, normal: THREE.Vector3 | null) {
    const m = tool.model!;
    const cam = this.ctx.camera;
    m.root.position.copy(tip);
    if (tool.orientModel(m.root, this.hover)) return;
    if (!m.shafted) {
      // Surface marker: lie on the tissue.
      const n = normal ?? this.tmp.set(0, 0, 1);
      m.root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      return;
    }
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const back = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 2);
    const side = tool.hand === 'right' ? 1 : -1;
    // Instruments come down the corridor close to the optical axis (~20°), entering from the
    // lower corner on their hand's side. Staying near the line of sight keeps the working tip
    // visible in any scope position, as a surgeon's instruments are.
    const y = back.clone().addScaledVector(up, -0.12).addScaledVector(right, 0.32 * side).normalize();
    const x = new THREE.Vector3().crossVectors(y, back).normalize();
    const z = new THREE.Vector3().crossVectors(x, y).normalize();
    this.basis.makeBasis(x, y, z);
    m.root.quaternion.setFromRotationMatrix(this.basis);
  }

  update(dt: number) {
    const tool = state.ended ? null : this.active;
    this.hover = tool ? this.pick() : null;
    const h = this.hover;
    const status = tool ? tool.status(h) : null;
    this.setHighlight(h, status);
    this.updateHighlights(dt);

    // Instrument tip target.
    if (tool && h) {
      const lift = this.pressed ? -tool.pressDepth * 0.4 : tool.hoverLift;
      this.tmp.copy(h.point).addScaledVector(h.normal, lift);
      if (!this.tipValid) {
        this.tip.copy(this.tmp);
        this.tipPrev.copy(this.tmp);
        this.tipValid = true;
      }
      this.tip.lerp(this.tmp, 1 - Math.exp(-dt * 30));
    }
    const speed = this.tipValid ? this.tip.distanceTo(this.tipPrev) / Math.max(dt, 1e-4) : 0;
    this.tipSpeed += (speed - this.tipSpeed) * (1 - Math.exp(-dt * 10));
    this.tipPrev.copy(this.tip);

    // Tool pushes tissue under its tip.
    const deforming = !!tool && tool.deforms(h);
    if (deforming && h) {
      tissueGlobals.uToolTip.value.copy(h.point);
      tissueGlobals.uToolDir.value.copy(h.normal).negate();
    }
    const targetDepth = deforming ? tool!.pressDepth : 0;
    tissueGlobals.uToolDepth.value += (targetDepth - tissueGlobals.uToolDepth.value) * (1 - Math.exp(-dt * 16));

    if (tool?.model) {
      const want = h && this.inside ? 1 : 0;
      this.cursorVisible += (want - this.cursorVisible) * (1 - Math.exp(-dt * 12));
      tool.model.root.visible = this.tipValid && this.cursorVisible > 0.02;
      if (tool.model.root.visible) this.placeModel(tool, this.tip, h?.normal ?? null);
    }

    if (tool) {
      if (this.pressed) tool.onHold(h, dt, this.tipSpeed);
      tool.update(dt, h);
    }

    // Cursor + status tag.
    this.dom.style.cursor = tool ? (h ? 'none' : 'crosshair') : '';
    if (tool && this.inside) {
      const s = status!;
      const text = h && h.label ? `${h.label} · ${s.text}` : s.text;
      this.hooks.setTag(text, this.px.x, this.px.y, LEVEL_CSS[s.level]);
    }
  }

  /** World position of the instrument tip (smoothed). */
  get tipPosition(): THREE.Vector3 {
    return this.tip;
  }
}

function isShown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}
