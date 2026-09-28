import * as THREE from 'three';
import { createSteelMaterial } from '../anatomy/materials';
import { audio } from '../audio/engine';
import type { EndoscopeView } from '../scene/endoscopeView';
import { toast } from '../state/events';
import type { InstrumentModel } from './models';
import { reticleModel } from './models';
import { Tool, type Hover, type ToolContext, type ToolStatus } from './tool';

/**
 * Endoscope-assisted inspection: click tissue near the aneurysm to slide the endoscope in there;
 * it looks at the neck from that side (typically from medial, through the opticocarotid window,
 * to see the PCom origin and the far clip blade). X withdraws it; clicking elsewhere repositions.
 */
export class EndoscopeTool extends Tool {
  readonly id = 'endoscope' as const;
  readonly name = 'Endoscope';
  readonly key = '9';
  override hoverLift = 0.2;
  private shaft: THREE.Mesh;

  constructor(ctx: ToolContext, private view: EndoscopeView, private onChange: (on: boolean) => void) {
    super(ctx);
    const m: InstrumentModel = reticleModel(0x9be7f3);
    this.model = m;
    const geom = new THREE.CylinderGeometry(1.35, 1.35, 90, 24);
    geom.translate(0, 45, 0);
    this.shaft = new THREE.Mesh(geom, createSteelMaterial({ color: 0x6f777e, roughness: 0.5, envMapIntensity: 1.2 }));
    this.shaft.layers.set(1);
    this.shaft.castShadow = true;
    this.shaft.visible = false;
    this.shaft.userData = { kind: 'instrument', id: 'endoscope', label: 'Endoscope' };
    ctx.anatomy.root.add(this.shaft);
  }

  private valid(h: Hover | null) {
    return !!h && h.kind !== 'blood' && h.point.distanceTo(this.ctx.anatomy.aneurysm.neckCenter) < 14;
  }

  status(h: Hover | null): ToolStatus {
    if (!h) return { text: this.view.active ? 'Endoscope in · X withdraws' : 'Endoscope — click beside the aneurysm to insert', level: 'idle' };
    if (!this.valid(h)) return { text: 'Too far from the aneurysm', level: 'warn' };
    return { text: this.view.active ? 'Click to move the endoscope here · X withdraws' : 'Click to insert the endoscope here', level: 'ok' };
  }

  override deforms() {
    return false;
  }

  override onDown(h: Hover | null) {
    if (!this.valid(h)) return;
    const neck = this.ctx.anatomy.aneurysm.neckCenter;
    // Park the lens ~6 mm from the neck on the chosen side, clear of the tissue surface.
    const side = h!.point.clone().addScaledVector(h!.normal, 2).sub(neck).normalize();
    const tip = neck.clone().addScaledVector(side, 6);
    // Look at the neck; the shaft leaves toward the surgeon.
    this.view.insert(tip, neck);
    // Shaft comes in obliquely from the medial side of the corridor (not end-on to the microscope).
    const cam = this.ctx.camera;
    const toCam = cam.position.clone().sub(tip).normalize();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const back = toCam.multiplyScalar(0.55).addScaledVector(right, -0.83).normalize();
    this.shaft.position.copy(tip);
    this.shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), back);
    this.shaft.visible = true;
    audio.tick(900, 0.05);
    this.onChange(true);
    toast('Endoscope in — view from beside the neck (bottom left)', 'info', 'endo');
  }

  override onKey(key: string): boolean {
    if (key !== 'x' || !this.view.active) return false;
    this.view.withdraw();
    this.shaft.visible = false;
    this.onChange(false);
    return true;
  }
}
