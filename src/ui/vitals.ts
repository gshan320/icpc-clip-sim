import { audio } from '../audio/engine';
import { FS, type Hemodynamics, type RingBuffer } from '../physics/hemodynamics';
import type { AlarmMonitor } from '../physics/vitals';
import { events } from '../state/events';
import { occlusionSeconds, state } from '../state/store';
import { fmtTime } from './checklist';
import { h } from './dom';

/**
 * OR monitor (top right). Every trace is drawn sample-by-sample from the circulation engine's
 * 500 Hz buffers at a fixed sweep speed; every number is the engine's measurement (per-beat
 * SBP/DBP/MAP, R–R-averaged HR, 8-beat SpO₂, end-tidal CO₂). An event log time-stamps what
 * the surgeon did, so cause and effect can be read off the traces.
 */

class Sweep {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private x = 0;
  private lastY: number | null = null;
  private read = 0;
  private dpr = Math.min(2, window.devicePixelRatio || 1);

  constructor(
    private buf: RingBuffer,
    private w: number,
    private hgt: number,
    private color: string,
    private map: (v: number) => number,
    private pxPerSec = 62,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w * this.dpr;
    this.canvas.height = hgt * this.dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${hgt}px`;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(this.dpr, this.dpr);
    this.read = buf.count;
  }

  draw() {
    const ctx = this.ctx;
    const end = this.buf.count;
    if (end - this.read > 4000) this.read = end - 4000;
    const dx = this.pxPerSec / FS;
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.4;
    ctx.shadowColor = this.color;
    ctx.shadowBlur = 4;
    ctx.beginPath();
    let moved = false;
    for (let i = this.read; i < end; i++) {
      const y = this.hgt - 3 - Math.min(1, Math.max(0, this.map(this.buf.at(i)))) * (this.hgt - 6);
      const nx = this.x + dx;
      if (this.lastY !== null) {
        if (!moved) {
          ctx.moveTo(this.x, this.lastY);
          moved = true;
        }
        ctx.lineTo(nx, y);
      }
      this.x = nx;
      this.lastY = y;
      if (this.x >= this.w) {
        ctx.stroke();
        ctx.beginPath();
        moved = false;
        this.x = 0;
        this.lastY = null;
      }
    }
    ctx.stroke();
    // Erase bar ahead of the pen.
    ctx.clearRect(this.x + 1, 0, 12, this.hgt);
    this.read = end;
  }
}

export function createVitals(root: HTMLElement, alarms: AlarmMonitor, engine: Hemodynamics) {
  const W = 190;
  const ecg = new Sweep(engine.ecg, W, 42, '#57d68d', (v) => (v + 0.45) / 1.75);
  const art = new Sweep(engine.abp, W, 40, '#ff5a5f', (v) => (v - 30) / 130);
  const plet = new Sweep(engine.pleth, W, 26, '#5ad1e6', (v) => 0.1 + v * 0.8);
  const co2 = new Sweep(engine.capno, W, 26, '#f2e35c', (v) => v / 50);
  const dop = new Sweep(engine.doppler, W, 30, '#f0f0f0', (v) => v / 1.4);

  const hr = h('span.vt-big.green', {}, '--');
  const abp = h('span.vt-big.red', {}, '--/--');
  const map = h('span.vt-small.red', {}, '(--)');
  const spo2 = h('span.vt-mid.cyan', {}, '--');
  const pi = h('span.vt-small.cyan', {}, '');
  const etco2 = h('span.vt-mid.yellow', {}, '--');
  const rr = h('span.vt-small.yellow', {}, '');
  const mep = h('span.vt-mid.amber', {}, '--');
  const op = h('span.vt-mid', {}, '00:00');
  const occ = h('span.vt-mid', {}, '--:--');
  const ebl = h('span.vt-mid', {}, '0');
  const banner = h('div.vt-banner');
  const log = h('div.vt-log');
  const bell = h('button.vt-bell', { title: 'Silence alarms for 2 minutes', html: '<svg viewBox="0 0 16 16"><path d="M8 2.2c-2 0-3.4 1.5-3.4 3.6v2.6L3.3 10.6h9.4l-1.3-2.2V5.8C11.4 3.7 10 2.2 8 2.2zM6.6 12.4a1.5 1.5 0 0 0 2.8 0" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path class="slash" d="M3 3l10 10" stroke="currentColor" stroke-width="1.3"/></svg>' });
  const cell = (label: string, value: HTMLElement, unit = '') => h('div.vt-cell', {}, h('span.vt-label', {}, label), h('span.vt-val', {}, value, unit ? h('span.vt-unit', {}, unit) : null));

  const hrCell = h('div.vt-num', {}, h('span.vt-label', {}, 'HR'), hr);
  const abpCell = h('div.vt-num', {}, h('span.vt-label', {}, 'ABP'), h('span.vt-val', {}, abp, map));
  const spo2Cell = h('div.vt-num.small', {}, h('span.vt-label', {}, 'SpO₂ %'), h('span.vt-val', {}, spo2, pi));
  const co2Cell = h('div.vt-num.small', {}, h('span.vt-label', {}, 'EtCO₂'), h('span.vt-val', {}, etco2, rr));
  const mepCell = cell('MEP', mep, '%');
  const occCell = cell('T-OCC', occ);
  const eblCell = cell('EBL', ebl, 'mL');
  const trace = (lead: string, c: HTMLCanvasElement) => h('div.vt-trace', {}, h('span.vt-lead', {}, lead), c);
  const dopVel = h('span.vt-mid', {}, '—');
  const dopRow = h('div.vt-row.vt-dop', {}, trace('DOPPLER', dop.canvas), h('div.vt-num.small', {}, h('span.vt-label', {}, 'VEL'), h('span.vt-val', {}, dopVel)));
  const panel = h(
    'div.vitals.panel',
    {},
    h('div.vt-head', {}, h('span.label', {}, 'Monitor'), banner, bell),
    h('div.vt-row', {}, trace('II', ecg.canvas), hrCell),
    h('div.vt-row', {}, trace('ART', art.canvas), abpCell),
    h('div.vt-row', {}, trace('PLETH', plet.canvas), spo2Cell),
    h('div.vt-row', {}, trace('CO₂', co2.canvas), co2Cell),
    dopRow,
    h('div.vt-grid', {}, mepCell, cell('OP', op), occCell, eblCell),
    log,
  );
  root.append(panel);

  // Event log: what the surgeon did, time-stamped to 0.1 s.
  const stamp = () => {
    const s = state.elapsed;
    return `${fmtTime(s)}.${Math.floor((s % 1) * 10)}`;
  };
  const addLog = (text: string, level: 'info' | 'warn' | 'danger' | 'ok' = 'info') => {
    const row = h(`div.vt-ev.${level}` as 'div', {}, h('span.vt-ev-t', {}, stamp()), text);
    log.prepend(row);
    while (log.children.length > 5) log.lastElementChild?.remove();
  };
  events.on('bleeding:started', ({ label, kind }) => {
    if (label !== 'Aneurysm rupture') addLog(label, kind === 'arterial' ? 'danger' : 'warn');
  });
  events.on('bleeding:stopped', () => addLog('Bleeding point coagulated', 'ok'));
  events.on('aneurysm:ruptured', () => addLog('ANEURYSM RUPTURE', 'danger'));
  events.on('tempclip:applied', () => addLog('Temporary clip ON (ICA)', 'warn'));
  events.on('tempclip:removed', ({ duration }) => addLog(`Temporary clip OFF · ${fmtTime(duration)}`, 'info'));
  events.on('clip:applied', ({ type }) => addLog(`Aneurysm clip applied (${type})`, 'info'));
  events.on('clip:removed', () => addLog('Aneurysm clip removed', 'info'));
  events.on('icg:started', () => addLog('ICG injected', 'info'));
  events.on('anaesthesia', ({ text, level }) => addLog(text, level));

  let lastBeat = engine.beats;
  let lastTick = engine.measureTick;
  let silencedUntil = 0;
  let alarmTimer = 0;
  let acc = 0;
  bell.addEventListener('click', () => {
    silencedUntil = state.elapsed + 120;
    bell.classList.add('silenced');
  });

  return {
    show() {
      panel.classList.add('on');
    },
    update(dt: number) {
      ecg.draw();
      art.draw();
      plet.draw();
      co2.draw();
      dop.draw();
      const probing = !!engine.dopplerProbe;
      dopRow.classList.toggle('on', probing);
      if (probing) dopVel.textContent = (engine.doppler.at(engine.doppler.count - 1) * 60).toFixed(0);
      const v = state.vitals;
      // Numbers refresh on each detected beat (every 2 s in arrest), as on a real monitor.
      if (engine.measureTick !== lastTick) {
        lastTick = engine.measureTick;
        hr.textContent = v.hr.toFixed(0);
        abp.textContent = `${v.sbp.toFixed(0)}/${v.dbp.toFixed(0)}`;
        map.textContent = ` (${v.map.toFixed(0)})`;
        spo2.textContent = Number.isNaN(v.spo2) ? '--' : v.spo2.toFixed(0);
        pi.textContent = ` PI ${v.pi.toFixed(1)}`;
      }
      // Pulse tone on each mechanical beat only (no pulse, no tone).
      if (engine.beats !== lastBeat) {
        lastBeat = engine.beats;
        if (!Number.isNaN(v.spo2)) audio.beep(v.spo2); // never silenced — only alarms are
        panel.classList.add('beat');
        setTimeout(() => panel.classList.remove('beat'), 110);
      }
      etco2.textContent = v.etco2.toFixed(0);
      rr.textContent = ` RR ${v.rr.toFixed(0)}`;
      mep.textContent = v.mep.toFixed(0);
      op.textContent = fmtTime(state.elapsed);
      const o = occlusionSeconds();
      occ.textContent = state.tempClip.on ? fmtTime(o) : state.tempClip.total > 0 ? `Σ ${fmtTime(state.tempClip.total)}` : '--:--';
      occCell.classList.toggle('on', state.tempClip.on);
      occCell.classList.toggle('warn', state.tempClip.on && o > 180 && o <= 300);
      occCell.classList.toggle('alarm', state.tempClip.on && o > 300);
      ebl.textContent = state.ebl < 10 ? state.ebl.toFixed(1) : state.ebl.toFixed(0);

      acc += dt;
      if (acc < 0.2) return;
      acc = 0;
      const active = alarms.update();
      const ids = new Set(active.map((a) => a.id));
      abpCell.classList.toggle('alarm', ids.has('map'));
      hrCell.classList.toggle('alarm', ids.has('hr'));
      spo2Cell.classList.toggle('alarm', ids.has('spo2'));
      mepCell.classList.toggle('alarm', ids.has('mep'));
      eblCell.classList.toggle('alarm', ids.has('bleed'));
      banner.textContent = active.map((a) => a.text).join(' · ');
      banner.classList.toggle('on', active.length > 0);
      banner.classList.toggle('high', active.some((a) => a.priority === 'high'));
      if (state.elapsed >= silencedUntil) bell.classList.remove('silenced');
      alarmTimer -= 0.2;
      if (active.length && alarmTimer <= 0 && state.elapsed >= silencedUntil) {
        const high = active.some((a) => a.priority === 'high');
        audio.alarm(high ? 'high' : 'medium');
        alarmTimer = high ? 5 : 12;
      }
    },
  };
}
