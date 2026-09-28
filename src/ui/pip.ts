import { h } from './dom';

/** Frame and label for the endoscope picture-in-picture (bottom left). */
export function createPip(root: HTMLElement) {
  const el = h('div.pip', {}, h('div.pip-label', {}, h('span.label', {}, 'Endoscope 30°'), h('span.pip-hint', {}, '9 · X withdraws')));
  root.append(el);
  let on = false;
  return {
    get visible() {
      return on || el.classList.contains('on');
    },
    show(v: boolean) {
      on = v;
      el.classList.toggle('on', v);
    },
    /** Image area in CSS px (excluding the label strip). */
    rect() {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + 1), y: Math.round(r.top + 22), w: Math.round(r.width - 2), h: Math.round(r.height - 23) };
    },
  };
}
