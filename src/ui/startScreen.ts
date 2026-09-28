import { h } from './dom';

/**
 * Start screen: title, the educational-use disclaimer, controls, and build progress.
 */
export interface StartScreen {
  setProgress(fraction: number, label: string): void;
  ready(): void;
  onBegin(cb: () => void): void;
  onDemo(cb: () => void): void;
  hide(): void;
}

export function createStartScreen(root: HTMLElement): StartScreen {
  const bar = h('div');
  const label = h('div.progress-label', {}, 'Preparing…');
  const begin = h('button.btn.primary', { disabled: 'true' }, 'Enter the operating room', h('span.hint', {}, 'ENTER')) as HTMLButtonElement;
  const demo = h('button.btn', { disabled: 'true', title: 'Watch the operation performed step by step; click at any time to take over' }, 'Demo mode', h('span.hint', {}, 'D')) as HTMLButtonElement;

  const el = h(
    'div.start',
    {},
    h(
      'div.start-card.panel',
      {},
      h('div.label.start-eyebrow', {}, 'Microsurgery simulator · educational'),
      h('h1', {}, 'Clipping of a right IC-PC aneurysm'),
      h('div.subtitle', {}, 'Pterional craniotomy · transsylvian approach · 6.6 mm unruptured aneurysm'),
      h(
        'div.disclaimer',
        {},
        h('strong', {}, 'FOR EDUCATION AND DEMONSTRATION ONLY. '),
        'This simulator uses simplified, procedurally generated anatomy and physiology. It is not a clinical training ' +
          'device, is not validated for surgical skills assessment, and does not provide medical advice. ' +
          'Do not use it to make decisions about the care of any patient.',
      ),
      h(
        'div.controls-grid',
        {},
        h('span.k', {}, 'Right-drag / ⌥-drag'), h('span', {}, 'Tilt the microscope around the focal point'),
        h('span.k', {}, 'Middle-drag / ⇧-drag'), h('span', {}, 'Pan the microscope'),
        h('span.k', {}, 'Wheel / pinch'), h('span', {}, 'Magnification'),
        h('span.k', {}, 'Double-click / C'), h('span', {}, 'Centre the field on a structure'),
        h('span.k', {}, '1 – 0'), h('span', {}, 'Pick up an instrument (Esc puts it down)'),
        h('span.k', {}, 'H'), h('span', {}, 'Instrument rules and controls'),
      ),
      h('div.progress', {}, bar),
      label,
      h('div.actions', {}, begin, demo),
    ),
  );
  root.append(el);

  let beginCb: (() => void) | null = null;
  let demoCb: (() => void) | null = null;
  demo.addEventListener('click', () => !demo.disabled && demoCb?.());
  const fire = () => {
    if (begin.disabled) return;
    beginCb?.();
  };
  begin.addEventListener('click', fire);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !el.classList.contains('hidden')) fire();
    if ((e.key === 'd' || e.key === 'D') && !el.classList.contains('hidden') && !demo.disabled) demoCb?.();
  });

  return {
    setProgress(f, text) {
      bar.style.width = `${Math.round(f * 100)}%`;
      label.textContent = text;
    },
    ready() {
      bar.style.width = '100%';
      label.textContent = 'Ready.';
      begin.disabled = false;
      demo.disabled = false;
      begin.focus();
    },
    onBegin(cb) {
      beginCb = cb;
    },
    onDemo(cb) {
      demoCb = cb;
    },
    hide() {
      el.classList.add('hidden');
      setTimeout(() => el.remove(), 1000);
    },
  };
}
