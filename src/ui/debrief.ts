import { state } from '../state/store';
import { fmtTime } from './checklist';
import { h } from './dom';

/**
 * Debrief: outcome, the numbers that matter, a vitals timeline with what the surgeon did, and
 * a few specific tips drawn from this case.
 */

type Level = 'good' | 'warning' | 'serious' | 'critical';
const STATUS: Record<Level, { color: string; icon: string }> = {
  good: { color: '#0ca30c', icon: '✓' },
  warning: { color: '#fab219', icon: '!' },
  serious: { color: '#ec835a', icon: '▲' },
  critical: { color: '#d03b3b', icon: '✕' },
};
// Chart tokens (dark surface): single validated series hue, recessive grid, text inks.
const SERIES = '#3987e5';
const GRID = 'rgba(255,255,255,0.07)';
const INK = '#d9e3e8';
const INK_DIM = '#8497a1';

interface Outcome {
  level: Level;
  title: string;
  subtitle: string;
  prognosis: string;
}

function outcome(): Outcome {
  const p = state.patient;
  const c = state.clip;
  const e = c.eval;
  if (p.dead) return { level: 'critical', title: 'Patient died', subtitle: `Cause: ${p.deathCause}.`, prognosis: '—' };
  let prognosis = 'Good recovery expected.';
  if (p.anoxia > 300) prognosis = 'Severe hypoxic–ischaemic brain injury expected.';
  else if (e && e.acha < 0.6) prognosis = 'High risk of contralateral hemiparesis (anterior choroidal territory — internal capsule).';
  else if (state.vitals.mepMin < 50) prognosis = 'MEPs were lost during the case — risk of a new motor deficit.';
  else if (e && e.pcom < 0.6) prognosis = 'Risk of thalamic infarction from PCom perforators.';
  else if (e && e.stenosis > 0.5) prognosis = 'Risk of MCA-territory ischaemia from ICA narrowing.';
  else if (p.roscCount > 0) prognosis = 'Survived a cardiac arrest — ICU, neurological assessment after sedation.';
  if (!c.applied || !e) return { level: 'critical', title: 'Aneurysm not secured', subtitle: 'The case ended without a clip across the neck.', prognosis };
  if (e.closure < 0.97 || e.residualMm > 0.6) return { level: 'serious', title: 'Residual aneurysm filling', subtitle: e.closure < 0.97 ? 'The blades did not span the whole neck.' : `About ${e.residualMm.toFixed(1)} mm of neck remains below the blades.`, prognosis };
  if (e.acha < 0.6) return { level: 'critical', title: 'Aneurysm secured — anterior choroidal occluded', subtitle: 'The clip jaws caught the AChA origin.', prognosis };
  if (e.pcom < 0.6) return { level: 'serious', title: 'Aneurysm secured — PCom compromised', subtitle: 'The clip jaws caught the PCom.', prognosis };
  if (e.stenosis > 0.35) return { level: 'serious', title: 'Aneurysm secured — ICA narrowed', subtitle: `The clip narrows the carotid by about ${Math.round(e.stenosis * 100)} %.`, prognosis };
  return { level: p.roscCount > 0 || state.ruptureAt !== null ? 'warning' : 'good', title: 'Aneurysm secured — branches patent', subtitle: 'Complete neck occlusion; PCom, anterior choroidal and ICA preserved.', prognosis };
}

function tips(): string[] {
  const out: string[] = [];
  const e = state.clip.eval;
  const tl = state.timeline;
  if (state.patient.dead) out.push('Uncontrolled haemorrhage is lethal: get proximal control (temporary clip on the ICA, 0) within the first minute, with the suction parked on the bleeding (S).');
  if (state.ruptureAt !== null) {
    if (/dome|bleb|manipulation/.test(state.ruptureReason)) out.push('The rupture followed handling of the dome. Free the neck, not the fundus — keep instruments off the dome and away from the bleb.');
    const tc = tl.find((x) => x.kind === 'tempclip-on' && x.t >= (state.ruptureAt ?? 0));
    const dt = tc ? tc.t - (state.ruptureAt ?? 0) : null;
    if (dt === null) out.push('After the rupture no temporary clip was applied. Proximal control turns a torrent into a manageable ooze.');
    else if (dt > 60) out.push(`It took ${fmtTime(dt)} to gain proximal control after the rupture — aim for under a minute.`);
  }
  if (state.tempClip.longest > 300) out.push(`Longest temporary occlusion ${fmtTime(state.tempClip.longest)} — keep each episode under 5 minutes and let the brain reperfuse between episodes.`);
  if (state.retractionOverTime > 15) out.push(`Retraction exceeded 20 mmHg for ${Math.round(state.retractionOverTime)} s — open more arachnoid rather than retracting harder.`);
  if (state.clipHistory.length > 2) out.push(`The clip was applied ${state.clipHistory.length} times — plan blade angle and depth before closing; every reapplication stresses the neck.`);
  if (e) {
    if (e.closure < 0.97) out.push('The blades did not span the neck: advance them (wheel / W) until the tips pass its far side.');
    else if (e.residualMm > 0.6) out.push('Neck remnant: place the blades closer to the parent vessel, parallel to the ICA.');
    if (e.stenosis > 0.35) out.push('The ICA was narrowed: align the blades with the ICA (Q/E) and keep them off the parent wall.');
    if (e.acha < 0.6) out.push('The anterior choroidal was caught: shorten the blade depth or use a curved clip whose tips ride over it.');
    if (e.pcom < 0.6) out.push('The PCom was caught: the blades sat too low or too far toward it — check with the endoscope (9) before closing.');
  }
  if (state.clip.applied && state.checks.icgClipId !== state.clip.id) out.push('Always confirm the final clip with ICG (7).');
  if (state.clip.applied && !Object.values(state.checks.doppler).some((d) => d.clipId === state.clip.id)) out.push('Use the micro-Doppler (8) on the PCom and anterior choroidal after clipping.');
  if (state.ebl > 500 && !state.patient.dead) out.push(`Blood loss ${Math.round(state.ebl)} mL — control bleeders early; small oozes add up.`);
  if (!out.length) out.push('Clean case. Next time, try the curved clip (Tab) and compare what the ICG shows.');
  return out.slice(0, 6);
}

/** Small multiples: one panel per measure on a shared time axis (never a dual axis). */
function timelineChart() {
  const hist = state.history;
  const W = 640, PH = 74, GAP = 22, PAD_L = 44, PAD_R = 12, TOP = 44;
  const panels: { key: 'map' | 'hr' | 'mep'; title: string; unit: string; min: number; max: number }[] = [
    { key: 'map', title: 'Mean arterial pressure', unit: 'mmHg', min: 0, max: 120 },
    { key: 'hr', title: 'Heart rate', unit: 'bpm', min: 0, max: 160 },
    { key: 'mep', title: 'Motor evoked potentials', unit: '%', min: 0, max: 100 },
  ];
  const H = TOP + panels.length * (PH + GAP) + 16;
  const wrap = h('div.db-chart');
  const cv = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = W * dpr;
  cv.height = H * dpr;
  cv.style.width = `${W}px`;
  cv.style.height = `${H}px`;
  const tip = h('div.db-tip');
  wrap.append(cv, tip);
  const ctx = cv.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const tMax = Math.max(10, hist.length ? hist[hist.length - 1].t : 10);
  const x = (t: number) => PAD_L + (t / tMax) * (W - PAD_L - PAD_R);
  const draw = (hoverT: number | null) => {
    ctx.clearRect(0, 0, W, H);
    ctx.font = '10.5px JetBrains Mono, monospace';
    // Event markers across all panels.
    for (const ev of state.timeline) {
      const X = x(ev.t);
      const critical = ev.kind === 'rupture' || ev.kind === 'arrest' || ev.kind === 'death';
      ctx.strokeStyle = critical ? STATUS.critical.color : 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(X + 0.5, 18);
      ctx.lineTo(X + 0.5, H - 16);
      ctx.stroke();
    }
    panels.forEach((p, i) => {
      const y0 = TOP + i * (PH + GAP);
      const y = (v: number) => y0 + PH - ((Math.min(p.max, Math.max(p.min, v)) - p.min) / (p.max - p.min)) * PH;
      // Grid: hairline, recessive; clean ticks.
      ctx.strokeStyle = GRID;
      for (const f of [0, 0.5, 1]) {
        const gy = y0 + PH - f * PH + 0.5;
        ctx.beginPath();
        ctx.moveTo(PAD_L, gy);
        ctx.lineTo(W - PAD_R, gy);
        ctx.stroke();
        ctx.fillStyle = INK_DIM;
        ctx.textAlign = 'right';
        ctx.fillText(String(Math.round(p.min + f * (p.max - p.min))), PAD_L - 6, gy + 3);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = INK;
      ctx.fillText(`${p.title} (${p.unit})`, PAD_L, y0 - 6);
      if (hist.length < 2) return;
      // Area wash + 2px line.
      ctx.beginPath();
      hist.forEach((pt, k) => (k ? ctx.lineTo(x(pt.t), y(pt[p.key])) : ctx.moveTo(x(pt.t), y(pt[p.key]))));
      ctx.lineTo(x(hist[hist.length - 1].t), y0 + PH);
      ctx.lineTo(x(hist[0].t), y0 + PH);
      ctx.closePath();
      ctx.fillStyle = 'rgba(57,135,229,0.10)';
      ctx.fill();
      ctx.beginPath();
      hist.forEach((pt, k) => (k ? ctx.lineTo(x(pt.t), y(pt[p.key])) : ctx.moveTo(x(pt.t), y(pt[p.key]))));
      ctx.strokeStyle = SERIES;
      ctx.lineWidth = 2;
      ctx.lineJoin = ctx.lineCap = 'round';
      ctx.stroke();
      if (hoverT !== null) {
        const pt = hist.reduce((a, b) => (Math.abs(b.t - hoverT) < Math.abs(a.t - hoverT) ? b : a));
        ctx.beginPath();
        ctx.arc(x(pt.t), y(pt[p.key]), 4, 0, Math.PI * 2);
        ctx.fillStyle = SERIES;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#0b1014';
        ctx.stroke();
      }
    });
    // Time axis.
    ctx.fillStyle = INK_DIM;
    ctx.textAlign = 'center';
    const step = tMax > 900 ? 300 : tMax > 300 ? 120 : 60;
    for (let t = 0; t <= tMax; t += step) ctx.fillText(fmtTime(t), x(t), H - 3);
    // Event labels (selective: rupture / arrest / clips) in text ink with an icon.
    ctx.textAlign = 'left';
    let lastX = -1e9;
    for (const ev of state.timeline) {
      const X = x(ev.t);
      if (X - lastX < 70) continue;
      lastX = X;
      const critical = ev.kind === 'rupture' || ev.kind === 'arrest' || ev.kind === 'death';
      const tw = ctx.measureText(ev.label).width;
      const left = X + 6 + tw > W - 2;
      ctx.fillStyle = critical ? STATUS.critical.color : INK_DIM;
      ctx.fillText(critical ? '▲' : '│', X - 3, 12);
      ctx.fillStyle = INK_DIM;
      ctx.fillText(ev.label, left ? X - 8 - tw : X + 6, 12);
    }
    if (hoverT !== null) {
      const X = x(hoverT);
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(X + 0.5, TOP - 4);
      ctx.lineTo(X + 0.5, H - 16);
      ctx.stroke();
    }
  };
  draw(null);
  // Crosshair + one tooltip with every measure at that time.
  cv.addEventListener('pointermove', (ev) => {
    if (hist.length < 2) return;
    const r = cv.getBoundingClientRect();
    const px = ev.clientX - r.left;
    const t = Math.min(tMax, Math.max(0, ((px - PAD_L) / (W - PAD_L - PAD_R)) * tMax));
    const pt = hist.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
    draw(pt.t);
    tip.replaceChildren();
    const row = (label: string, v: string) => h('div.db-tip-row', {}, h('span.db-key'), h('b', {}, v), h('span', {}, ` ${label}`));
    tip.append(h('div.db-tip-t', {}, fmtTime(pt.t)), row('MAP mmHg', pt.map.toFixed(0)), row('HR bpm', pt.hr.toFixed(0)), row('MEP %', pt.mep.toFixed(0)), row('EBL mL', pt.ebl.toFixed(0)));
    tip.style.left = `${Math.min(W - 150, px + 12)}px`;
    tip.style.top = `30px`;
    tip.classList.add('on');
  });
  cv.addEventListener('pointerleave', () => {
    draw(null);
    tip.classList.remove('on');
  });
  // Table view (every value reachable without hovering).
  const table = h('table.db-table');
  table.append(h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'MAP'), h('th', {}, 'HR'), h('th', {}, 'MEP'), h('th', {}, 'EBL')));
  hist.filter((_, i) => i % 15 === 0 || i === hist.length - 1).forEach((pt) => {
    table.append(h('tr', {}, h('td', {}, fmtTime(pt.t)), h('td', {}, pt.map.toFixed(0)), h('td', {}, pt.hr.toFixed(0)), h('td', {}, pt.mep.toFixed(0)), h('td', {}, pt.ebl.toFixed(0))));
  });
  const toggle = h('button.db-link', {}, 'Show data table');
  const tableWrap = h('div.db-table-wrap', {}, table);
  toggle.addEventListener('click', () => {
    tableWrap.classList.toggle('on');
    toggle.textContent = tableWrap.classList.contains('on') ? 'Hide data table' : 'Show data table';
  });
  return h('div', {}, wrap, toggle, tableWrap);
}

export function createDebrief(root: HTMLElement, opts: { onRestart: () => void }) {
  const el = h('div.debrief');
  const reopen = h('button.btn.db-reopen', {}, 'Debrief');
  root.append(el, reopen);

  const open = () => {
    const o = outcome();
    const st = STATUS[o.level];
    const e = state.clip.eval;
    const end = state.ended?.at ?? state.elapsed;
    const card = (label: string, value: string, sub = '', level?: Level) =>
      h(
        'div.db-card',
        {},
        h('div.label', {}, label),
        h('div.db-val', {}, level ? h('span.db-status', { style: { color: STATUS[level].color } }, STATUS[level].icon + ' ') : null, value),
        sub ? h('div.db-sub', {}, sub) : null,
      );
    const pct = (v: number) => `${Math.round(v * 100)} %`;
    const minMap = state.history.length ? Math.min(...state.history.map((x) => x.map)) : state.vitals.map;
    const content = h(
      'div.db-panel.panel',
      {},
      h(
        'div.db-head',
        {},
        h('div.db-badge', { style: { borderColor: st.color, color: st.color } }, st.icon),
        h('div', {}, h('div.label', {}, 'Debrief'), h('h2', {}, o.title), h('div.db-subtitle', {}, o.subtitle)),
      ),
      h('div.db-prog', {}, h('span.label', {}, 'Expected outcome'), h('span', {}, o.prognosis)),
      h(
        'div.db-grid',
        {},
        card('Total time', fmtTime(end), `${state.stage} of 6 steps completed`),
        card('Blood loss', `${Math.round(state.ebl)} mL`, `${Math.round(state.patient.fluids)} mL fluids / blood given`, state.ebl > 1000 ? 'critical' : state.ebl > 300 ? 'warning' : undefined),
        card('Temporary occlusion', state.tempClip.total > 0 || state.tempClip.on ? fmtTime(state.tempClip.total) : 'None', state.tempClip.episodes ? `${state.tempClip.episodes} episode(s), longest ${fmtTime(state.tempClip.longest)}` : '', state.tempClip.longest > 300 ? 'serious' : undefined),
        card('Intraoperative rupture', state.ruptureAt !== null ? `Yes · ${fmtTime(state.ruptureAt)}` : 'No', state.ruptureAt !== null ? state.ruptureReason : '', state.ruptureAt !== null ? 'critical' : 'good'),
        card('Clip result', e ? (e.closure >= 0.97 && e.residualMm <= 0.6 ? 'Neck closed' : 'Residual filling') : 'No clip', e ? `closure ${pct(e.closure)} · residual ${e.residualMm.toFixed(1)} mm · ICA narrowing ${pct(e.stenosis)}` : '', e ? (e.closure >= 0.97 && e.residualMm <= 0.6 ? 'good' : 'serious') : 'critical'),
        card('Branches', e ? `PCom ${e.pcom > 0.6 ? 'patent' : 'compromised'} · AChA ${e.acha > 0.6 ? 'patent' : 'occluded'}` : '—', e ? `${state.checks.icgRuns} ICG run(s), ${Object.keys(state.checks.doppler).length} Doppler check(s)` : '', e ? (e.pcom > 0.6 && e.acha > 0.6 ? 'good' : 'critical') : undefined),
        card('Lowest MAP', `${Math.round(minMap)} mmHg`, state.patient.roscCount || state.patient.arrest || state.patient.dead ? `cardiac arrest · ROSC ×${state.patient.roscCount}` : '', minMap < 50 ? 'critical' : minMap < 65 ? 'warning' : undefined),
        card('Lowest MEP', `${Math.round(state.vitals.mepMin)} %`, 'motor evoked potentials', state.vitals.mepMin < 50 ? 'critical' : state.vitals.mepMin < 80 ? 'warning' : undefined),
      ),
      h('div.label', { style: { margin: '18px 0 8px' } }, 'Timeline'),
      timelineChart(),
      h('div.label', { style: { margin: '18px 0 8px' } }, 'To improve'),
      h('ul.db-tips', {}, ...tips().map((t) => h('li', {}, t))),
      h('div.db-actions', {}, h('button.btn.primary', { onclick: opts.onRestart }, 'Restart case'), h('button.btn', { onclick: () => close() }, 'Back to the field')),
    );
    el.replaceChildren(content);
    el.classList.add('on');
    reopen.classList.remove('on');
  };
  const close = () => {
    el.classList.remove('on');
    reopen.classList.add('on');
  };
  reopen.addEventListener('click', open);
  return { open, close };
}
