import type { IcgAngiography } from '../physics/icg';
import { toast } from '../state/events';
import type { InstrumentModel } from './models';
import { Tool, type ToolContext, type ToolStatus } from './tool';
import * as THREE from 'three';

/**
 * ICG videoangiography: not an instrument in the field but a microscope mode. Selecting it and
 * clicking anywhere (or pressing Enter / Space) asks the anaesthetist to inject ICG; the
 * microscope switches to its near-infrared view for the arterial, capillary and venous phases.
 */
export class IcgTool extends Tool {
  readonly id = 'icg' as const;
  readonly name = 'ICG angiography';
  readonly key = '7';

  constructor(ctx: ToolContext, private icg: IcgAngiography) {
    super(ctx);
    const root = new THREE.Group();
    const model: InstrumentModel = { root, setJaw: () => {}, setGlow: () => {}, shafted: false };
    this.model = model;
  }

  status(): ToolStatus {
    if (this.icg.running) return { text: `ICG run · ${this.icg.time.toFixed(1)} s — watch what fills, and when`, level: 'ok' };
    return { text: 'Click (or Space) to inject ICG', level: 'ok' };
  }

  private run() {
    if (this.icg.running) return;
    this.icg.start();
    toast('ICG injected — arterial phase in a moment', 'info');
  }

  override onDown() {
    this.run();
  }

  override onKey(key: string): boolean {
    if (key === ' ' || key === 'enter') {
      this.run();
      return true;
    }
    return false;
  }

  override deforms() {
    return false;
  }
}
