import { events } from '../state/events';
import type { ToolId } from '../state/store';
import type { ToolManager } from '../tools/manager';
import { h } from './dom';
import { toolIcon } from './icons';

/**
 * Bottom instrument tray: one slot per instrument, number keys 1…0. A glowing indicator glides
 * to the selected slot; instruments that arrive in later milestones are dimmed with a badge.
 */
export function createToolbar(root: HTMLElement, manager: ToolManager) {
  const indicator = h('div.tb-indicator');
  const name = h('div.tb-name', {}, 'No instrument');
  const hint = h('div.tb-hint', {}, '1–0 pick up an instrument · Esc puts it down · H help');
  const slots = h('div.tb-slots', {}, indicator);
  const buttons = new Map<ToolId, HTMLButtonElement>();

  for (const t of manager.tools.values()) {
    const b = h(
      'button.tb-slot',
      { title: `${t.name} (${t.key})${t.available ? '' : ` — arrives in ${t.milestone}`}`, 'aria-label': t.name },
      h('span.tb-key', {}, t.key),
      h('span.tb-icon', { html: toolIcon(t.id) }),
      t.available ? null : h('span.tb-badge', {}, t.milestone ?? ''),
    ) as HTMLButtonElement;
    if (!t.available) b.classList.add('na');
    b.addEventListener('click', () => manager.select(manager.active?.id === t.id ? null : t.id));
    buttons.set(t.id, b);
    slots.append(b);
  }

  const bar = h('div.toolbar.panel', {}, slots, h('div.tb-caption', {}, name, hint));
  root.append(bar);

  const place = (id: ToolId | null) => {
    for (const [k, b] of buttons) b.classList.toggle('active', k === id);
    const b = id ? buttons.get(id) : null;
    if (b) {
      indicator.style.opacity = '1';
      indicator.style.transform = `translateX(${b.offsetLeft}px)`;
      indicator.style.width = `${b.offsetWidth}px`;
    } else {
      indicator.style.opacity = '0';
    }
    const t = id ? manager.tools.get(id) : null;
    name.textContent = t ? t.name : 'No instrument';
  };
  events.on('tool:changed', ({ tool }) => place(tool));
  requestAnimationFrame(() => place(null));

  return {
    show() {
      bar.classList.add('on');
    },
  };
}
