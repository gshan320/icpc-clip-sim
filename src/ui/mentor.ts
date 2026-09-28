import { events } from '../state/events';
import { state } from '../state/store';
import type { ProcedureManager } from '../procedure/manager';
import { h } from './dom';

/**
 * Mentor panel (bottom right): calm guidance for the current step, its sub-tasks with
 * checkboxes, live guidelines, and a progress percentage. Collapsible (M). "Guide view" (G)
 * swings the microscope to a good working angle for the step.
 */
export function createMentor(root: HTMLElement, proc: ProcedureManager, onGuideView: (i: number) => void, onFinish: () => void) {
  let viewing = state.stage;
  let collapsed = false;

  const stepLabel = h('span.label', {}, 'Step 1 of 6');
  const pct = h('span.mn-pct', {}, '0%');
  const chevron = h('button.mn-toggle', { title: 'Collapse (M)', html: '<svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' });
  const title = h('div.mn-title');
  const guidance = h('p.mn-guidance');
  const tasks = h('ul.mn-tasks');
  const guides = h('div.mn-guides');
  const alert = h('div.mn-alert');
  const tools = h('span.mn-tools');
  const guideBtn = h('button.btn.mn-btn', {}, 'Guide view', h('span.hint', {}, 'G'));
  const back = h('button.mn-back', {}, '← back to current step');
  const finish = h('button.btn.primary.mn-finish', { onclick: () => onFinish() }, 'Finish & debrief');
  const compact = h('div.mn-compact');
  const ring = h('div.mn-ring', { html: '<svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" class="bg"/><circle cx="18" cy="18" r="15" class="fg"/></svg>' });
  const content = h('div.mn-content', {}, title, guidance, tasks, guides, alert, h('div.mn-foot', {}, tools, back, guideBtn));
  const body = h('div.mn-body', {}, content);
  const panel = h(
    'div.mentor.panel',
    {},
    h('div.mn-head', {}, ring, h('div.mn-headtext', {}, h('span.label.mn-kicker', {}, 'Mentor'), stepLabel), compact, pct, chevron),
    body,
  );
  root.append(panel);
  const ringFg = ring.querySelector('.fg') as SVGCircleElement;
  const C = 2 * Math.PI * 15;
  ringFg.style.strokeDasharray = `${C}`;

  let taskEls: { li: HTMLElement; label: HTMLElement; bar: HTMLElement }[] = [];
  const build = () => {
    const def = proc.stages[viewing];
    if (!def) {
      title.textContent = 'All steps complete';
      guidance.textContent = 'Clip confirmed: dome excluded, PCom, anterior choroidal and ICA patent. Close up — and review the case in the debrief.';
      tasks.replaceChildren(finish);
      guides.replaceChildren();
      taskEls = [];
      return;
    }
    stepLabel.textContent = `Step ${viewing + 1} of ${proc.stages.length}${viewing !== state.stage ? ' · preview' : ''}`;
    title.textContent = def.title;
    guidance.textContent = def.guidance;
    tools.textContent = `Instruments: ${def.tools}`;
    back.style.display = viewing !== state.stage && state.stage < proc.stages.length ? '' : 'none';
    taskEls = proc.tasks(viewing).map((t) => {
      const label = h('span.mn-task-label', {}, t.label);
      const bar = h('span.mn-task-bar');
      const li = h('li.mn-task', {}, h('span.mn-box', { html: '<svg viewBox="0 0 16 16"><path d="M3.5 8.4l3 3 6-6.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' }), h('span.mn-task-main', {}, label, h('span.mn-task-track', {}, bar)), t.pending ? h('span.mn-badge', {}, t.pending) : null);
      return { li, label, bar };
    });
    tasks.replaceChildren(...taskEls.map((e) => e.li));
  };

  const swap = (i: number) => {
    viewing = i;
    content.classList.add('swap');
    setTimeout(() => {
      build();
      content.classList.remove('swap');
    }, 220);
  };

  const refresh = () => {
    const list = proc.tasks(viewing);
    list.forEach((t, k) => {
      const e = taskEls[k];
      if (!e) return;
      e.label.textContent = t.label;
      e.li.classList.toggle('done', t.done);
      e.li.classList.toggle('pending', !!t.pending);
      e.bar.style.transform = `scaleX(${t.progress})`;
    });
    guides.replaceChildren(
      ...proc.guidelines(viewing).map((g) => h(`div.mn-guide.${g.ok ? 'ok' : 'bad'}` as 'div', {}, h('span.dot'), g.label)),
    );
    // Context alerts that override the step: what matters right now.
    let a = '';
    const ruptured = state.ruptureAt !== null && state.bleedingRate > 0.05;
    const occ = state.tempClip.on ? state.elapsed - state.tempClip.since : 0;
    // Findings the learner has actually observed with ICG or Doppler for the current clip.
    const clip = state.clip;
    const e = clip.eval;
    let finding = '';
    if (clip.applied && e) {
      const d = state.checks.doppler;
      if (state.checks.icgClipId === clip.id) {
        if (e.closure < 0.97) finding = 'ICG: the dome still fills — the blades don\'t span the whole neck. Open the clip and advance the blades deeper.';
        else if (e.residualMm > 0.6) finding = 'ICG: a neck remnant fills below the blades. Reposition the clip closer to the parent vessel.';
        else if (e.pcom < 0.6) finding = 'ICG: the PCom no longer fills from the carotid — the clip is catching it. Reposition.';
        else if (e.acha < 0.6) finding = 'ICG: the anterior choroidal does not fill — reposition now (risk of hemiplegia).';
      }
      if (!finding && d.pcom?.clipId === clip.id && d.pcom.flow < 0.3) finding = 'No Doppler signal in the PCom — the clip is occluding it.';
      if (!finding && d.acha?.clipId === clip.id && d.acha.flow < 0.3) finding = 'No Doppler signal in the anterior choroidal — reposition the clip.';
      if (!finding && d.ica?.clipId === clip.id && e.stenosis >= 0.35) finding = 'Harsh, high-pitched ICA signal beside the clip — it is narrowing the carotid. Align the blades with the ICA.';
    }
    if (finding) a = finding;
    else if (ruptured && !state.tempClip.on) a = 'Rupture. Stay calm: keep the field visible with suction, then put a temporary clip on the proximal ICA (0).';
    else if (ruptured) a = 'Proximal control achieved. Suction the field clear, then clip the neck definitively (M5). Watch the occlusion time.';
    else if (state.vitals.mep < 60) a = 'MEP falling — restore flow: shorten occlusion, raise MAP, check that no branch is compromised.';
    else if (occ > 300) a = 'Temporary occlusion beyond 5 minutes — release the clip if you can and let the brain reperfuse.';
    else if (state.fieldBlood > 3) a = 'The field is filling with blood — suction first, then find the source.';
    else if (state.bleedingRate > 0.05) a = 'Active bleeding. Suction to see it, then coagulate with the bipolar.';
    else if (state.retractionPressure > 20) a = 'Retraction pressure is high — relax the spatula; open more arachnoid instead.';
    alert.textContent = a;
    alert.classList.toggle('on', !!a);
    const p = proc.stageProgress(viewing);
    pct.textContent = `${Math.round(p * 100)}%`;
    ringFg.style.strokeDashoffset = `${C * (1 - p)}`;
    const next = list.find((t) => !t.done);
    compact.textContent = next ? next.label : proc.stages[viewing]?.title ?? '';
  };

  chevron.addEventListener('click', () => setCollapsed(!collapsed));
  panel.querySelector('.mn-head')!.addEventListener('dblclick', () => setCollapsed(!collapsed));
  guideBtn.addEventListener('click', () => onGuideView(viewing));
  back.addEventListener('click', () => swap(state.stage));
  const setCollapsed = (c: boolean) => {
    collapsed = c;
    panel.classList.toggle('collapsed', c);
  };
  window.addEventListener('keydown', (e) => {
    if (!state.started || e.metaKey || e.ctrlKey) return;
    if (e.key === 'm' || e.key === 'M') setCollapsed(!collapsed);
    if (e.key === 'g' || e.key === 'G') onGuideView(viewing);
  });
  events.on('stage:changed', ({ index }) => {
    panel.classList.add('advance');
    setTimeout(() => panel.classList.remove('advance'), 900);
    swap(index);
  });

  build();
  let acc = 0;
  return {
    show() {
      panel.classList.add('on');
    },
    preview(i: number) {
      swap(Math.min(i, proc.stages.length - 1));
      if (collapsed) setCollapsed(false);
    },
    update(dt: number) {
      acc += dt;
      if (acc > 0.1) {
        acc = 0;
        refresh();
      }
    },
  };
}
