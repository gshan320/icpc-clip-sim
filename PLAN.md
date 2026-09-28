# IC-PC Aneurysm Clipping Simulator — Plan

Browser-based **educational** simulator of microsurgical clipping of a right IC-PC
aneurysm via a right pterional, transsylvian approach. The start screen shows a
disclaimer saying it is for education and demonstration only, not clinical training
or medical advice.

## 1. Stack and libraries

| Purpose | Choice | Why |
|---|---|---|
| Build | Vite + TypeScript (strict) | Fast HMR, simple static build |
| 3D | `three` | Scene, TubeGeometry vessels, materials |
| Post FX | `postprocessing` (pmndrs) | One merged pass for DoF, bloom, vignette, tone mapping, film grain, slight chromatic aberration. Cheaper than chaining separate three/examples passes |
| Camera | `camera-controls` | Damped, smooth orbit/dolly/truck with limits. Feels like moving a microscope head |
| Picking | `three-mesh-bvh` | Fast raycasts against dense tissue meshes every frame |
| Tweening | `gsap` | Smooth camera moves, UI transitions, demo-mode choreography |
| Noise | `simplex-noise` | Procedural gyri/sulci displacement, tissue textures, vitals drift |
| Fonts | `@fontsource/inter`, `@fontsource/jetbrains-mono` | Bundled locally, so it works offline |
| Audio | Web Audio API (no library) | Doppler tone synthesis, ECG beep, alarms |
| UI | Plain TS + CSS (no framework) | Small overlay UI. A tiny reactive store is enough |

No backend. All state lives in memory in one typed store.

## 2. Units, coordinates, orientation

- **1 scene unit = 1 mm.** All anatomy is set in real-world millimetres.
- The patient is supine, head turned about 30° to the left. We look through a
  right frontotemporal craniotomy: frontal lobe at the top of the view, temporal
  lobe at the bottom, and the sylvian fissure running across the middle.
- The default microscope axis points down the opened fissure toward the
  supraclinoid ICA. You can tilt ±25° around a pivot on the target, which
  imitates re-angling the scope.

## 3. Folder layout

```
src/
  main.ts                 bootstrap, render loop
  config/anatomy.ts       ALL tunable anatomy params (sizes, positions, spline points)
  config/sim.ts           physiology, bleeding, scoring constants
  scene/                  renderer, camera rig, lights, post-processing, PiP endoscope view
  anatomy/                lobes, arachnoid, vessels, nerves, aneurysm, spatulas, materials
  tools/                  Tool base class plus one file per tool; cursor models; ToolManager
  procedure/              stage definitions, goal checks, demo-mode scripts, clip evaluation
  physics/                hemodynamics (flow graph), rupture-risk model, blood particles and pooling, tissue pulsation
  audio/                  AudioEngine, Doppler synth, ECG beep, alarms
  ui/                     start screen, toolbar, checklist, mentor, vitals, ECG canvas, debrief
  state/                  store (events and a snapshot), event bus
```

## 4. Anatomy (procedural, from `config/anatomy.ts`)

Each part comes with learner comments in the code.

- **Frontal and temporal lobes**: displaced, noise-perturbed surfaces showing gyri,
  opercula meeting at the **sylvian fissure**, and superficial sylvian veins.
- **Arachnoid**: semi-transparent, glossy membrane patches bridging the fissure and
  the carotid/optic cisterns. Each patch is split into cuttable segments.
- **Vessels** (TubeGeometry on CatmullRom splines, radius tapering along the curve):
  supraclinoid ICA → bifurcation → **M1** (lateral) → **M2** superior/inferior trunks,
  and **A1** (medial). The **PCom** comes off the posterior wall of the ICA and runs
  posteromedially. The **anterior choroidal artery (AChA)** comes off distal to the
  PCom and runs posterolaterally.
- **Nerves**: optic nerve (medial to the ICA) and oculomotor nerve (CN III,
  posterolateral, running toward the tentorial edge).
- **Aneurysm**: 6.6 mm dome at the IC-PC junction, projecting posterolaterally and
  inferiorly toward CN III, with a defined neck ring and a small **bleb** (thin wall,
  where rupture risk is highest).
- **Materials**: `MeshPhysicalMaterial` with clearcoat for moist, glossy tissue, plus
  subtle subsurface-style tinting. A vertex-shader pulse is driven by the live
  heart rate, and arteries pulse more than brain.
- **Brain spatulas**: two retractor blades that hold the lobes apart. The contact
  area deforms with a vertex offset, and retraction pressure is tracked.

## 5. Tools (bottom toolbar, keys 1–0)

| Key | Tool | Interaction rule |
|---|---|---|
| 1 | Suction | Hold LMB: removes blood particles and lowers the pool near the tip |
| 2 | Micro scissors | Click an arachnoid segment to cut it (it peels back with an animation) |
| 3 | Bipolar | Hold on an oozing point for about 1 s to coagulate it. Using it on a major vessel or the dome counts as a penalty |
| 4 | Dissector | Drag along the neck to free it. Pressing on the dome raises rupture risk |
| 5 | Brain spatula | Drag to adjust retraction. Too much pressure for too long gives a warning |
| 6 | Aneurysm clip | Move to position, Q/E to rotate, wheel/W/S for blade depth, Tab for straight or curved, click to apply, R to remove |
| 7 | ICG | Switches to a near-infrared fluorescence view. Dye fills vessels arterial → capillary → venous, based on the flow graph |
| 8 | Micro Doppler | Probe touching a vessel: pulsatile tone scaled by flow. Silence if flow is zero |
| 9 | Endoscope | Picture-in-picture view from behind the aneurysm (checks for hidden branches or neck remnant) |
| 0 | Temporary clip | Place on the proximal ICA: flow drops, bleeding drops, occlusion timer starts |

Each tool has its own 3D cursor model, highlights what it is hovering over, and
shows a small status hint next to the cursor ("cut", "no target", etc.).

**Controls**: LMB = use tool · RMB drag = tilt scope · MMB/Shift-drag = pan ·
wheel = magnification (wheel adjusts clip depth when the clip tool is active) ·
F = refocus on target · H = help. Trackpad: Option-drag = tilt, Shift-drag = pan.

## 6. Simulation core

- **Flow graph**: vessels are nodes carrying a flow fraction. Clip and temporary-clip
  geometry is tested against vessel centrelines. That gives stenosis and occlusion
  per vessel, which then drives ICG, Doppler, pulsation strength and MEP.
- **Rupture risk**: a hidden value from 0 to 1 that goes up with dome contact force
  and time, touching the bleb, BP spikes, and incomplete clip closure. Rupture
  happens stochastically once it crosses a threshold.
- **Bleeding**: GPU instanced particles for jets and drips, plus decals on tissue
  and a **pooling layer**, a shader plane whose level and spread rise with blood
  volume. Oozing points (small vessel injuries) are separate emitters that the
  bipolar can close.
- **Vitals**: a beat-by-beat model. HR, BP and SpO₂ drift slowly (noise), and
  events push them: blood loss → BP↓ HR↑, rupture → a sharp drop, temporary
  occlusion over about 5 minutes → MEP falls. The ECG is drawn on a canvas as a
  sweeping trace. Alarms play when values cross thresholds.
- **Clip evaluation**: sample points on the neck ring are tested against the blade
  segment:
  neck closure %, residual neck (mm), ICA lumen reduction %, PCom and AChA patency.
  Results are shown **through ICG and Doppler**: a filling dome means residual
  neck, and a silent PCom means it was occluded. A short summary is also shown.

## 7. Procedure stages (left checklist)

1. **Open the sylvian fissure**: cut N arachnoid segments, place the spatulas
2. **Identify M1**: expose M1 and hover or Doppler it
3. **Identify ICA and optic nerve**: open the carotid cistern and touch both
4. **Confirm PCom and dissect the neck**: expose the PCom origin, free the neck (dissector)
5. **Clip the aneurysm**: apply a clip whose evaluation passes
6. **Confirm PCom patency**: requires BOTH Doppler signal on the PCom and AChA AND an ICG run showing them filling

Each stage unlocks when its goals are met. **Demo mode** plays each stage with a
scripted camera, tool moves and mentor narration (gsap timelines). Clicking
anywhere or pressing a key hands control back to the user from that point.

## 8. UI

- **Style**: dark, semi-transparent panels (backdrop blur), 1px hairline borders,
  cyan and amber accents, JetBrains Mono for numbers. It looks like an OR display.
- **Panels**: checklist on the left · vitals at the top right (ECG, HR, ABP, SpO₂,
  op time, occlusion timer, EBL, MEP%) · mentor at the bottom right (collapsible,
  sub-tasks, % progress) · toolbar at the bottom.
- **Screens**: start (disclaimer, Start / Demo) → operation → debrief (time,
  EBL, occlusion time, rupture yes/no, clip result, specific tips).
- **Language**: English only.

## 9. Visual quality and performance

- Warm microscope light: a coaxial spotlight from the camera plus a soft fill.
  Round vignette mask to match the eyepiece field. Shallow DoF focused on the
  raycast hit under the view centre, with smooth autofocus. Soft bloom on
  specular highlights and ICG glow.
- Target 60 fps on a recent laptop. Adaptive pixel ratio, BVH picking, and one
  merged post-processing pass. A quality toggle (High/Low) is included.
- Every transition is tweened: tool switches, stage unlocks, ICG fade, panel
  collapse, camera refocus.

## 10. Milestones (each one is runnable)

- **M1**: Vite scaffold, renderer, camera rig, microscope post FX, all procedural anatomy, `config/anatomy.ts`
- **M2**: toolbar, ToolManager, cursor models, hover highlight, scissors/suction/bipolar/dissector/spatula behaviours
- **M3**: store, stage system, checklist, mentor panel
- **M4**: vitals model and panel, ECG, audio alarms, blood particles and pooling, oozing, rupture model, temporary clip
- **M5**: aneurysm clip (straight/curved), clip evaluation, ICG view, Doppler audio, endoscope PiP
- **M6**: debrief, demo mode, start screen and disclaimer, polish and performance pass

After each milestone: run `npm run dev`, fix all TypeScript and console errors,
run `npm run build`, and give you a short "what to test" list.

## 11. Non-goals (for now)

Real patient imaging, soft-body FEM, haptics, VR, multiplayer, persistence.

## Status

All milestones M1–M6 implemented. Additions beyond the original plan:
- Physically based blood: jets, rivulets and a pool with suction windows.
- A 500 Hz circulation engine, with haemorrhagic shock, arrest, resuscitation and death.
- Clip reconstruction of lacerated arteries, and brain swelling after anoxic injury.
- The procedure is English only, as requested.
