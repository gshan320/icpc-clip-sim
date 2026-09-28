import * as THREE from 'three';
import { events } from '../state/events';
import { h } from './dom';

/**
 * Floating anatomical callouts. When a structure is identified, its name appears pinned to it in
 * the field for a few seconds. Also draws the small dwell ring next to the cursor while you hold
 * it on a structure to identify it.
 */
export function createCallouts(root: HTMLElement, camera: THREE.PerspectiveCamera) {
  const layer = h('div.callouts');
  root.append(layer);
  const dwell = h('div.dwell', { html: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" class="bg"/><circle cx="12" cy="12" r="9" class="fg"/></svg>' });
  layer.append(dwell);
  const fg = dwell.querySelector('.fg') as SVGCircleElement;
  const C = 2 * Math.PI * 9;
  fg.style.strokeDasharray = `${C}`;

  const items: { el: HTMLElement; p: THREE.Vector3; born: number }[] = [];
  const v = new THREE.Vector3();

  events.on('structure:identified', ({ label, point }) => {
    const el = h('div.callout', {}, h('span.callout-dot'), h('span.callout-line'), h('span.callout-label', {}, h('span.callout-kicker', {}, 'Identified'), label));
    layer.append(el);
    requestAnimationFrame(() => el.classList.add('in'));
    items.push({ el, p: new THREE.Vector3(point.x, point.y, point.z), born: performance.now() });
  });

  return {
    update(pointer: { x: number; y: number } | null, progress: number | null) {
      const now = performance.now();
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        const age = (now - it.born) / 1000;
        if (age > 3.2 && !it.el.classList.contains('out')) it.el.classList.add('out');
        if (age > 3.8) {
          it.el.remove();
          items.splice(i, 1);
          continue;
        }
        v.copy(it.p).project(camera);
        const x = ((v.x + 1) / 2) * window.innerWidth;
        const y = ((1 - v.y) / 2) * window.innerHeight;
        it.el.style.transform = `translate(${x}px, ${y}px)`;
      }
      if (pointer && progress !== null) {
        dwell.classList.add('on');
        dwell.style.transform = `translate(${pointer.x - 12}px, ${pointer.y - 34}px)`;
        fg.style.strokeDashoffset = `${C * (1 - progress)}`;
      } else {
        dwell.classList.remove('on');
      }
    },
  };
}
