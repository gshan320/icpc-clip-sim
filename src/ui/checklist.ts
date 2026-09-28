import { events } from '../state/events';
import { state } from '../state/store';
import type { ProcedureManager } from '../procedure/manager';
import { h } from './dom';

export const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};

/**
 * Left procedure checklist: the six steps with locked / active / done states, a progress bar on
 * the active step, completion times, and overall progress. Clicking a step previews its
 * guidance in the mentor panel.
 */
export function createChecklist(root: HTMLElement, proc: ProcedureManager, onSelect: (i: number) => void, onEnd?: () => void) {
  const overall = h('span.v', {}, '0%');
  const timer = h('span.v', {}, '00:00');
  const rows: { el: HTMLElement; bar: HTMLElement; time: HTMLElement; sub: HTMLElement }[] = [];
  const list = h('div.cl-list');
  proc.stages.forEach((s, i) => {
    const bar = h('div.cl-bar-fill');
    const time = h('span.cl-time');
    const sub = h('div.cl-sub', {}, s.short);
    const el = h(
      'button.cl-row',
      {},
      h('span.cl-idx', {}, h('span.cl-num', {}, String(i + 1)), h('span.cl-check', { html: '<svg viewBox="0 0 16 16"><path d="M3.5 8.4l3 3 6-6.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' })),
      h('span.cl-text', {}, h('span.cl-title', {}, s.title), sub, h('div.cl-bar', {}, bar)),
      time,
    );
    el.addEventListener('click', () => onSelect(i));
    rows.push({ el, bar, time, sub });
    list.append(el);
  });
  const panel = h(
    'div.checklist.panel',
    {},
    h('div.cl-head', {}, h('span.label', {}, 'Procedure'), h('span.cl-meta', {}, timer, h('span.sep', {}, '·'), overall)),
    onEnd ? h('button.cl-end', { onclick: () => onEnd(), title: 'End the case and open the debrief' }, 'End case & debrief') : null,
    h('div.cl-overall', {}, h('div.cl-overall-fill')),
    list,
  );
  root.append(panel);
  const overallFill = panel.querySelector('.cl-overall-fill') as HTMLElement;

  const refresh = () => {
    rows.forEach((r, i) => {
      const status = i < state.stage ? 'done' : i === state.stage ? 'active' : 'locked';
      r.el.classList.toggle('done', status === 'done');
      r.el.classList.toggle('active', status === 'active');
      r.el.classList.toggle('locked', status === 'locked');
      r.bar.style.transform = `scaleX(${status === 'done' ? 1 : status === 'active' ? proc.stageProgress(i) : 0})`;
      r.time.textContent = state.stageTimes[i] !== undefined ? fmtTime(state.stageTimes[i]) : '';
    });
    const p = proc.overallProgress();
    overall.textContent = `${Math.round(p * 100)}%`;
    overallFill.style.transform = `scaleX(${p})`;
  };
  events.on('stage:completed', ({ index }) => {
    const r = rows[index];
    r.el.classList.add('just-done');
    setTimeout(() => r.el.classList.remove('just-done'), 1200);
  });

  let acc = 0;
  return {
    show() {
      panel.classList.add('on');
    },
    update(dt: number) {
      timer.textContent = fmtTime(state.elapsed);
      acc += dt;
      if (acc > 0.12) {
        acc = 0;
        refresh();
      }
    },
  };
}
