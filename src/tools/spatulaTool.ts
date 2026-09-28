import gsap from 'gsap';
import { audio } from '../audio/engine';
import { SAFE_RETRACTION_MMHG } from '../physics/fissure';
import { events, toast } from '../state/events';
import { state } from '../state/store';
import { reticleModel } from './models';
import { Tool, type Hover, type ToolContext, type ToolStatus } from './tool';

type LobeName = 'frontal' | 'temporal';

/**
 * Brain spatula: place a blade on the frontal or temporal operculum once the arachnoid is open
 * enough, then drag to adjust how hard it holds the lobe back. Retraction buys a little extra
 * room but costs brain pressure — let the arachnoid dissection do most of the work.
 */
export class SpatulaTool extends Tool {
  readonly id = 'spatula' as const;
  readonly name = 'Brain spatula';
  readonly key = '5';
  override hoverLift = 0.15;
  override readonly pickInstruments = true;
  private dragging: LobeName | null = null;

  constructor(ctx: ToolContext) {
    super(ctx);
    this.model = reticleModel();
  }

  private lobeOf(h: Hover | null): LobeName | null {
    if (!h) return null;
    if (h.kind === 'brain' && (h.id === 'frontal' || h.id === 'temporal')) return h.id;
    if (h.kind === 'instrument' && h.id.startsWith('spatula-')) return h.id.slice(8) as LobeName;
    if (h.kind === 'vein') return 'temporal';
    return null;
  }

  override deforms() {
    return false;
  }

  status(h: Hover | null): ToolStatus {
    const lobe = this.dragging ?? this.lobeOf(h);
    if (!lobe) return { text: 'Brain spatula — point at a lobe', level: 'idle' };
    const s = state.spatulas[lobe];
    if (!s.placed) {
      if (!this.ctx.fissure.canPlaceSpatula()) return { text: 'Fissure too tight — open the arachnoid first', level: 'warn' };
      return { text: `Click to place a spatula on the ${lobe} lobe`, level: 'ok' };
    }
    const p = state.retractionPressure;
    const level = p > SAFE_RETRACTION_MMHG ? 'danger' : p > SAFE_RETRACTION_MMHG * 0.75 ? 'warn' : 'ok';
    return { text: `Drag to retract ${Math.round(s.retraction * 100)}% · ${p.toFixed(0)} mmHg · X removes`, level };
  }

  override onDown(h: Hover | null) {
    const lobe = this.lobeOf(h);
    if (!lobe) return;
    const s = state.spatulas[lobe];
    if (!s.placed) {
      if (!this.ctx.fissure.canPlaceSpatula()) {
        toast('Open the superficial arachnoid before placing a spatula', 'warn', 'spatula-tight');
        return;
      }
      s.placed = true;
      s.retraction = 0.25;
      gsap.to(s, { inserted: 1, duration: 0.9, ease: 'power2.out' });
      audio.tick(700, 0.06);
      events.emit('spatula:placed', { lobe });
      toast(`Spatula placed on the ${lobe} lobe`, 'ok');
      return;
    }
    this.dragging = lobe;
  }

  override onUp() {
    this.dragging = null;
  }

  override onDrag(_dx: number, dy: number) {
    if (!this.dragging) return;
    const s = state.spatulas[this.dragging];
    // Drag away from the fissure to retract more (up for frontal, down for temporal).
    const dir = this.dragging === 'frontal' ? -1 : 1;
    s.retraction = Math.min(1, Math.max(0, s.retraction + dy * dir * 0.004));
  }

  override onKey(key: string, h: Hover | null): boolean {
    if (key !== 'x') return false;
    const lobe = this.lobeOf(h);
    if (!lobe || !state.spatulas[lobe].placed) return false;
    const s = state.spatulas[lobe];
    gsap.to(s, {
      inserted: 0,
      retraction: 0,
      duration: 0.6,
      ease: 'power2.in',
      onComplete: () => {
        s.placed = false;
      },
    });
    events.emit('spatula:removed', { lobe });
    toast(`Spatula removed from the ${lobe} lobe`, 'info');
    return true;
  }

  override update() {
    this.model!.setGlow(state.retractionPressure > SAFE_RETRACTION_MMHG ? 1 : 0);
  }
}
