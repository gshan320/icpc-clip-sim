import { h } from './dom';

/**
 * Microscope readout: magnification, focus distance, frame rate, plus the label / instrument
 * status tag that follows the cursor. Later milestones add the full OR panels.
 */
export interface Hud {
  show(): void;
  update(info: { mag: number; focus: number; fps: number; dpr: number }): void;
  setTag(text: string | null, x: number, y: number, color?: string): void;
}

export function createHud(root: HTMLElement): Hud {
  const mag = h('span.v', {}, '×6.0');
  const focus = h('span.v', {}, '—');
  const fps = h('span.v', {}, '—');
  const res = h('span.v', {}, '—');
  const scope = h(
    'div.hud-scope.panel',
    {},
    h('div.title', {}, 'OPMI · RIGHT PTERIONAL'),
    h('div.row', {}, h('span.label', {}, 'Mag'), mag),
    h('div.row', {}, h('span.label', {}, 'Focus'), focus),
    h('div.row', {}, h('span.label', {}, 'FPS'), fps),
    h('div.row', {}, h('span.label', {}, 'Res'), res),
  );
  const tag = h('div.hud-tag');
  const wrap = h('div', { style: { position: 'fixed', inset: '0', pointerEvents: 'none' } }, scope, tag);
  scope.style.pointerEvents = 'auto';
  root.append(wrap);

  let fpsSmooth = 60;
  return {
    show() {
      wrap.classList.add('hud-visible');
    },
    update(i) {
      fpsSmooth += (i.fps - fpsSmooth) * 0.08;
      mag.textContent = `×${i.mag.toFixed(1)}`;
      focus.textContent = `${i.focus.toFixed(1)} mm`;
      fps.textContent = fpsSmooth.toFixed(0);
      res.textContent = `${i.dpr.toFixed(2)}x`;
    },
    setTag(text, x, y, color) {
      if (!text) {
        tag.classList.remove('on');
        return;
      }
      tag.textContent = text;
      tag.style.left = `${x}px`;
      tag.style.top = `${y}px`;
      tag.style.setProperty('--tag-color', color ?? 'var(--cyan)');
      tag.classList.add('on');
    },
  };
}
