import { h } from './dom';

/** Help overlay (H): microscope controls and instrument rules. */
export function createHelp(root: HTMLElement) {
  const row = (k: string, t: string) => [h('span.k', {}, k), h('span', {}, t)];
  const el = h(
    'div.help.panel',
    {},
    h('div.label', { style: { marginBottom: '10px', color: 'var(--cyan)' } }, 'Microscope'),
    h(
      'div.controls-grid',
      {},
      ...row('Right-drag / ⌥-drag', 'Tilt the scope'),
      ...row('Middle-drag / ⇧-drag', 'Pan'),
      ...row('Wheel', 'Magnification'),
      ...row('C', 'Centre on the point under the cursor'),
      ...row('F', 'Default view'),
      ...row('G', 'Guide view for the current step'),
      ...row('M', 'Collapse / expand the mentor'),
      ...row('Hold cursor', 'Identify the structure under it'),
    ),
    h('div.label', { style: { margin: '6px 0 10px', color: 'var(--cyan)' } }, 'Instruments'),
    h(
      'div.controls-grid',
      {},
      ...row('1 Suction', 'Hold to aspirate blood (left hand). Never on the dome.'),
      ...row('2 Scissors', 'Click arachnoid to cut it. Cutting releases CSF and opens the fissure.'),
      ...row('3 Bipolar', 'Hold on a bleeding point to coagulate. Suction first so you can see it.'),
      ...row('4 Dissector', 'Drag along the aneurysm neck to free it; tilt to reach its far side.'),
      ...row('5 Spatula', 'Click a lobe edge to place; drag to adjust retraction; X removes.'),
      ...row('6 Aneurysm clip', 'Point at the neck; Q/E rotate, wheel or W/S blade depth, Tab straight/curved, click to apply; click the clip to remove.'),
      ...row('7 ICG', 'Click or Space: near-infrared angiography — see what fills (and what doesn\'t).'),
      ...row('8 Doppler', 'Hold on a vessel: pulsatile sound = flow, silence = none.'),
      ...row('9 Endoscope', 'Click beside the aneurysm to look behind the neck (picture-in-picture); X withdraws.'),
      ...row('0 Temporary clip', 'Click the proximal ICA (below the PCom) to apply; click the clip to remove. Watch the timer.'),
      ...row('S (with suction)', 'Park the suction here — it keeps aspirating while you use another instrument.'),
      ...row('Esc', 'Put the instrument down'),
      ...row('End case', 'Button above the checklist (or Finish in the mentor) opens the debrief. In demo mode, any click or key takes over.'),
    ),
    h('div', { style: { color: 'var(--text-faint)', fontSize: '11px' } }, 'Press H to close'),
  );
  root.append(el);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'h' || e.key === 'H') el.classList.toggle('on');
    if (e.key === 'Escape') el.classList.remove('on');
  });
}
