import { events, type ToastLevel } from '../state/events';
import { audio } from '../audio/engine';
import { h } from './dom';

/**
 * Short event messages at the top of the field. Keyed messages (repeated warnings) are shown
 * at most once every few seconds.
 */
export function createToasts(root: HTMLElement) {
  const stack = h('div.toasts');
  root.append(stack);
  const lastByKey = new Map<string, number>();

  events.on('toast', ({ text, level, key }) => {
    const now = performance.now();
    if (key) {
      const last = lastByKey.get(key) ?? -1e9;
      if (now - last < 4000) return;
      lastByKey.set(key, now);
    }
    const el = h(`div.toast.${level}` as 'div', {}, h('span.dot'), text);
    stack.prepend(el);
    requestAnimationFrame(() => el.classList.add('in'));
    if (level === 'danger' || level === 'warn') audio.caution();
    const life: Record<ToastLevel, number> = { info: 2600, ok: 2600, warn: 3800, danger: 4800 };
    setTimeout(() => {
      el.classList.remove('in');
      el.classList.add('out');
      setTimeout(() => el.remove(), 500);
    }, life[level]);
    while (stack.children.length > 4) stack.lastElementChild?.remove();
  });
}
