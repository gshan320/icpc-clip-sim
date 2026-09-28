import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles/main.css';

import gsap from 'gsap';
import * as THREE from 'three';
import { buildAnatomy, type Anatomy } from './anatomy';
import { tissueGlobals } from './anatomy/materials';
import { setMaxAnisotropy } from './anatomy/textures';
import { audio } from './audio/engine';
import { VIEW } from './config/anatomy';
import { RENDER } from './config/sim';
import { BloodSystem } from './physics/blood';
import { cardiac } from './physics/cardiac';
import { FissureModel } from './physics/fissure';
import { FlowModel } from './physics/flow';
import { IcgAngiography } from './physics/icg';
import { RuptureModel } from './physics/rupture';
import { AlarmMonitor, VitalsModel } from './physics/vitals';
import { Autofocus } from './scene/autofocus';
import { createCameraRig } from './scene/cameraRig';
import { createLights } from './scene/lights';
import { createPostFX, type PostFX } from './scene/postfx';
import { DepthPrepass } from './scene/depthPrepass';
import { EndoscopeView } from './scene/endoscopeView';
import { insideField } from './scene/field';
import { createRenderer } from './scene/renderer';
import { events } from './state/events';
import { state } from './state/store';
import { IdentificationTracker } from './procedure/identify';
import { evaluateClip, suggestedDepth } from './procedure/clipEval';
import { ProcedureManager } from './procedure/manager';
import { registerTools } from './tools';
import { ToolManager } from './tools/manager';
import { createCallouts } from './ui/callouts';
import { createDebrief } from './ui/debrief';
import { DemoDirector } from './procedure/demo';
import { createChecklist } from './ui/checklist';
import { createHelp } from './ui/help';
import { createMentor } from './ui/mentor';
import { createHud } from './ui/hud';
import { createStartScreen } from './ui/startScreen';
import { createToasts } from './ui/toasts';
import { createToolbar } from './ui/toolbar';
import { createVitals } from './ui/vitals';
import { createPip } from './ui/pip';

const viewport = document.getElementById('viewport')!;
const uiRoot = document.getElementById('ui')!;
const debug = new URLSearchParams(location.search).has('debug');

const renderer = createRenderer(viewport);
setMaxAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050607);
// Depth cue: structures deeper in the corridor fall off into warm darkness.
scene.fog = new THREE.Fog(0x0a0605, 150, 260);

const rig = createCameraRig(renderer.domElement);
const lights = createLights(scene, renderer);
const start = createStartScreen(uiRoot);
const hud = createHud(uiRoot);
createToasts(uiRoot);
createHelp(uiRoot);

let pixelRatio = Math.min(window.devicePixelRatio, RENDER.maxPixelRatio[state.quality]);
renderer.setPixelRatio(pixelRatio);

let fx: PostFX = createPostFX(renderer, scene, rig.camera, state.quality);
let anatomy: Anatomy | null = null;
let blood: BloodSystem | null = null;
let fissure: FissureModel | null = null;
let tools: ToolManager | null = null;
let autofocus: Autofocus | null = null;
let toolbar: ReturnType<typeof createToolbar> | null = null;
let procedure: ProcedureManager | null = null;
let flow: FlowModel | null = null;
let vitals: VitalsModel | null = null;
let rupture: RuptureModel | null = null;
let monitor: ReturnType<typeof createVitals> | null = null;
let icg: IcgAngiography | null = null;
let demo: DemoDirector | null = null;
const debrief = createDebrief(uiRoot, { onRestart: () => location.reload() });

/** End the case (all steps done, the surgeon chose to, or the patient died) and debrief. */
function endCase(reason: 'complete' | 'ended' | 'death') {
  if (state.ended) return;
  state.ended = { reason, at: state.elapsed };
  demo?.stop(false);
  tools?.select(null);
  events.emit('case:ended', { reason });
  setTimeout(() => debrief.open(), reason === 'death' ? 4000 : 600);
}

// Key events for the debrief timeline.
const mark = (kind: string, label: string) => state.timeline.push({ t: state.elapsed, kind, label });
events.on('aneurysm:ruptured', () => mark('rupture', 'Rupture'));
events.on('tempclip:applied', () => mark('tempclip-on', 'Temp clip on'));
events.on('tempclip:removed', () => mark('tempclip-off', 'Temp clip off'));
events.on('clip:applied', () => mark('clip', 'Clip'));
events.on('clip:removed', () => mark('clip-off', 'Clip off'));
events.on('icg:started', () => mark('icg', 'ICG'));
events.on('stage:completed', ({ index }) => mark('stage', `Step ${index + 1} ✓`));
events.on('anaesthesia', ({ text }) => {
  if (text.startsWith('CARDIAC ARREST')) mark('arrest', 'Arrest');
  else if (text.startsWith('Return of spontaneous')) mark('rosc', 'ROSC');
});
events.on('patient:died', () => {
  mark('death', 'Death');
  endCase('death');
});
const endoscope = new EndoscopeView(scene);
const pip = createPip(uiRoot);
rig.camera.layers.enable(1); // the microscope sees the endoscope shaft; the endoscope doesn't
let checklist: ReturnType<typeof createChecklist> | null = null;
let mentor: ReturnType<typeof createMentor> | null = null;
const identify = new IdentificationTracker();
const callouts = createCallouts(uiRoot, rig.camera);
const depthPrepass = new DepthPrepass(0.75);
const drawSize = new THREE.Vector2();

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  rig.camera.aspect = w / h;
  rig.camera.updateProjectionMatrix();
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(w, h);
  fx.setSize(w, h);
}
window.addEventListener('resize', resize);

function setQuality(q: 'high' | 'low') {
  state.quality = q;
  renderer.shadowMap.enabled = RENDER.shadows[q];
  lights.key.castShadow = RENDER.shadows[q];
  scene.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | undefined;
    if (m) m.needsUpdate = true;
  });
  pixelRatio = Math.min(window.devicePixelRatio, RENDER.maxPixelRatio[q]);
  const old = fx;
  fx = createPostFX(renderer, scene, rig.camera, q);
  old.composer.dispose();
  resize();
  events.emit('quality:changed', { quality: q });
}

// ------------------------------------------------------------------ adaptive resolution
const frameTimes: number[] = [];
function adaptResolution(ms: number) {
  frameTimes.push(ms);
  if (frameTimes.length < 90) return;
  const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
  frameTimes.length = 0;
  const max = Math.min(window.devicePixelRatio, RENDER.maxPixelRatio[state.quality]);
  let next = pixelRatio;
  if (avg > RENDER.targetFrameMs * 1.25) next = Math.max(RENDER.minPixelRatio, pixelRatio - 0.15);
  else if (avg < RENDER.targetFrameMs * 0.8) next = Math.min(max, pixelRatio + 0.1);
  if (Math.abs(next - pixelRatio) > 0.01) {
    pixelRatio = next;
    resize();
  }
}

// ------------------------------------------------------------------ labels & re-centring (no instrument)
const pointer = new THREE.Vector2();
const pointerPx = { x: 0, y: 0, moved: false, inside: false };
const picker = new THREE.Raycaster();
(picker as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
renderer.domElement.addEventListener('pointermove', (e) => {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  pointerPx.x = e.clientX;
  pointerPx.y = e.clientY;
  pointerPx.moved = true;
  pointerPx.inside = true;
});
renderer.domElement.addEventListener('pointerleave', () => {
  pointerPx.inside = false;
  hud.setTag(null, 0, 0);
});

function pickSolid(ndc: THREE.Vector2): THREE.Intersection | null {
  if (!anatomy || !insideField(ndc, rig.camera.aspect)) return null;
  picker.setFromCamera(ndc, rig.camera);
  const list: THREE.Object3D[] = [...anatomy.solids];
  if (blood?.pool.visible) list.push(blood.pool);
  return picker.intersectObjects(list, false).find((h) => h.object.userData.kind !== 'instrument' && isShown(h.object)) ?? null;
}

// Double-click (detected from pointer events — camera-controls swallows native dblclick):
// re-centre the microscope on the clicked structure. With an instrument in hand, use C instead.
let lastUp = { t: 0, x: 0, y: 0 };
let downAt = { x: 0, y: 0 };
renderer.domElement.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !anatomy || state.activeTool) return;
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return; // was a drag
  const now = performance.now();
  const isDouble = now - lastUp.t < 350 && Math.hypot(e.clientX - lastUp.x, e.clientY - lastUp.y) < 8;
  lastUp = { t: isDouble ? 0 : now, x: e.clientX, y: e.clientY };
  if (!isDouble) return;
  const r = renderer.domElement.getBoundingClientRect();
  const hit = pickSolid(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1));
  if (hit) rig.focusOn(hit.point);
});
window.addEventListener('keydown', (e) => {
  if ((e.key === 'c' || e.key === 'C') && pointerPx.inside && state.started) {
    const hit = pickSolid(pointer);
    if (hit) rig.focusOn(hit.point);
  }
});

const TAG_COLORS: Record<string, string> = {
  vessel: '#ff6b5e',
  aneurysm: '#ffb199',
  vein: '#a57bd6',
  nerve: '#f4e7c8',
  brain: '#f0b6a8',
  bone: '#e9dcc0',
  dura: '#cfd8dc',
  membrane: '#b58b80',
  instrument: '#c9ccd0',
  blood: '#c0302c',
  bleeding: '#ff4040',
};

/** What the bare cursor points at (no instrument), refreshed every frame. */
let freeHover: THREE.Intersection | null = null;
function updateTag() {
  if (!anatomy || state.activeTool || !pointerPx.inside) {
    freeHover = null;
    return;
  }
  freeHover = pickSolid(pointer);
  if (!freeHover) return hud.setTag(null, 0, 0);
  const ud = freeHover.object.userData as { kind: string; label: string };
  const known = state.identified[String((freeHover.object.userData as { id?: string }).id)] ? ' ✓' : '';
  hud.setTag(ud.label + known, pointerPx.x, pointerPx.y, TAG_COLORS[ud.kind]);
}

/** Structure currently pointed at by the cursor or the instrument tip. */
function pointedAt(): { id: string; point: THREE.Vector3 } | null {
  if (state.activeTool) {
    const h = tools?.hover;
    return h ? { id: h.id, point: h.point } : null;
  }
  if (!freeHover) return null;
  return { id: String(freeHover.object.userData.id ?? ''), point: freeHover.point };
}

function isShown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

// ------------------------------------------------------------------ main loop
const target = new THREE.Vector3();
let last = performance.now();
let elapsed = 0;

function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  elapsed += dt;

  // The circulation engine (fixed 2 ms steps) drives every beat in the scene.
  if (vitals) vitals.update(dt);
  else cardiac.update(dt);
  tissueGlobals.uPhase.value = cardiac.phase;
  // Wall motion scales with the measured pulse pressure.
  tissueGlobals.uPulseGain.value = Math.min(1.6, Math.max(0.2, (state.vitals.sbp - state.vitals.dbp) / 48));
  tissueGlobals.uResp.value = cardiac.resp;
  tissueGlobals.uTime.value = elapsed;
  if (state.started) state.elapsed += dt;

  rig.update(dt);
  rig.target(target);
  lights.update(rig.camera, target);

  fissure?.update(dt);
  if (state.started) {
    flow?.update(dt);
    rupture?.update(dt);
    tools?.update(dt);
    icg?.update(dt);
  }
  blood?.update(dt);

  if (autofocus) fx.setFocusDistance(autofocus.update(dt));
  // Keep the depth-fog anchored to the focal plane regardless of zoom / tilt.
  const fog = scene.fog as THREE.Fog;
  const d = rig.camera.position.distanceTo(target);
  fog.near = d - 12;
  fog.far = d + 70;

  updateTag();
  if (state.started) {
    identify.update(dt, pointedAt());
    procedure?.update();
    checklist?.update(dt);
    mentor?.update(dt);
    monitor?.update(dt);
  }
  callouts.update(pointerPx.inside ? pointerPx : null, state.started ? identify.progress : null);
  if (blood && anatomy && blood.pool.visible) {
    // Depth of the tissue under the blood, for thickness shading of the pool.
    const arach = anatomy.root.getObjectByName('arachnoid');
    depthPrepass.render(renderer, scene, rig.camera, arach ? [blood.group, arach] : [blood.group]);
    renderer.getDrawingBufferSize(drawSize);
    blood.surface.setDepth(depthPrepass.texture, drawSize.x, drawSize.y, rig.camera);
  }
  fx.render(dt);
  if (endoscope.active || pip.visible) endoscope.render(renderer, scene, pip.rect(), dt);

  hud.update({ mag: rig.magnification(), focus: autofocus?.distance ?? d, fps: 1 / Math.max(dt, 1e-3), dpr: pixelRatio });
  if (state.started) adaptResolution(dt * 1000);
}

// ------------------------------------------------------------------ boot
async function boot() {
  anatomy = await buildAnatomy((f, label) => start.setProgress(f, label));
  scene.add(anatomy.root);
  const a = anatomy;

  blood = new BloodSystem(() => a.solids);
  blood.camera = rig.camera;
  scene.add(blood.group);
  const b = blood;
  fissure = new FissureModel(a);
  flow = new FlowModel(a);
  const fl = flow;
  vitals = new VitalsModel(fl);
  rupture = new RuptureModel(a, b);
  // Bleeding follows flow in the injured vessel and arterial pressure.
  b.rateModifier = (o) => {
    const f = o.vesselId ? fl.forVessel(o.vesselId) : 1;
    const p = o.kind === 'arterial' ? Math.min(1.4, Math.max(0.25, state.vitals.map / 80)) : 1;
    return f * p;
  };
  monitor = createVitals(uiRoot, new AlarmMonitor(), vitals.engine);

  icg = new IcgAngiography(a, fl, lights, () => fx, scene);
  const ctx = { anatomy: a, blood: b, fissure, camera: rig.camera, setWheelZoom: (on: boolean) => rig.setWheelZoom(on) };
  tools = new ToolManager(ctx, renderer.domElement, scene, {
    setTag: (text, x, y, color) => hud.setTag(text, x, y, color),
    extraPickables: () => {
      const list: THREE.Object3D[] = b.oozes.filter((o) => o.active).map((o) => o.blob);
      if (b.pool.visible) list.push(b.pool);
      return list;
    },
  });
  registerTools(tools, ctx, { flow: fl, engine: vitals.engine, icg, endoscope, onEndoscope: (on) => pip.show(on) });
  toolbar = createToolbar(uiRoot, tools);
  procedure = new ProcedureManager({ anatomy: a, fissure, blood: b });
  const proc = procedure;
  demo = new DemoDirector(a, tools, rig, proc, uiRoot);
  demo.onFinish = () => endCase('complete');
  mentor = createMentor(uiRoot, proc, (i) => rig.goTo(proc.stages[i].view), () => endCase('complete'));
  const m = mentor;
  checklist = createChecklist(uiRoot, proc, (i) => m.preview(i), () => endCase(state.stage >= proc.stages.length ? 'complete' : 'ended'));
  events.on('tool:changed', ({ tool }) => {
    if (!tool) hud.setTag(null, 0, 0);
    pointerPx.moved = true;
  });

  autofocus = new Autofocus(rig.camera, () => (b.pool.visible ? [...a.solids, b.pool] : a.solids), VIEW.distance);

  // Pre-compile every shader so the first frames after "Enter" don't stutter.
  start.setProgress(0.97, 'Compiling shaders');
  b.pool.visible = true; // include the (initially hidden) blood surface
  await renderer.compileAsync(scene, rig.camera);
  b.pool.visible = false;
  fx.microscope.fade = 0;
  fx.microscope.fieldRadius = 0.04;
  renderer.setAnimationLoop(frame);
  start.ready();

  if (import.meta.env.DEV) {
    (window as unknown as { __sim: unknown }).__sim = { anatomy: a, blood: b, fissure, tools, procedure: proc, rig, flow: fl, vitals, demo, endCase, evaluateClip, suggestedDepth, get fx() { return fx; }, state, scene, renderer };
  }
  if (debug) {
    const { createDebugGui } = await import('./debug/gui');
    createDebugGui({ anatomy: a, fissure, blood: b, fx: () => fx, lights, setQuality });
  }
}

start.onDemo(() => {
  begin();
  gsap.delayedCall(2.4, () => demo?.start());
});

start.onBegin(() => begin());

function begin() {
  audio.init();
  start.hide();
  state.started = true;
  events.emit('sim:started', {});
  // Opening the eyepiece: the field stop irises open, the image fades up and the scope settles
  // from a slightly wider, tilted view into the working position.
  rig.controls.zoom(-0.28, false);
  void rig.controls.rotate(THREE.MathUtils.degToRad(-8), THREE.MathUtils.degToRad(-5), false);
  const params = { r: fx.microscope.fieldRadius, fade: 0 };
  gsap.to(params, {
    r: 0.485,
    fade: 1,
    duration: 1.8,
    ease: 'power3.out',
    onUpdate: () => {
      fx.microscope.fieldRadius = params.r;
      fx.microscope.fade = params.fade;
    },
  });
  gsap.delayedCall(0.25, () => rig.resetView(true));
  gsap.delayedCall(0.6, () => {
    hud.show();
    toolbar?.show();
    checklist?.show();
    mentor?.show();
    monitor?.show();
  });
}

boot().catch((err) => {
  console.error(err);
  start.setProgress(1, `Failed to build the scene: ${String(err)}`);
});
