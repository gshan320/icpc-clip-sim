# IC-PC Aneurysm Clipping Simulator

This is a browser-based **educational** simulator of microsurgical clipping of a right internal
carotid–posterior communicating artery (IC-PC) aneurysm through a pterional, transsylvian
approach.

> **For education and demonstration only.** It is not a clinical training device and does not give medical advice.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
```

Add `?debug` to the URL to open a live tuning panel. It controls fissure opening, heart rate, pulsation, depth of
field, bloom, field stop, ambient occlusion and quality.

## Controls (microscope)

| Input | Action |
|---|---|
| Right-drag, or Option/Alt + drag | Tilt the scope around the focal point |
| Middle-drag, or Shift + drag | Pan |
| Wheel / pinch, `+` / `-` | Magnification |
| Double-click (no instrument) or `C` | Re-centre on the structure under the cursor |
| Arrow keys | Tilt |
| `F` | Back to the default view |
| `1`–`0` | Pick up an instrument, `Esc` puts it down |
| `H` | Help overlay |
| `M` / `G` | Collapse the mentor / guide view for the current step |

## Instruments (M2)

| Key | Instrument | What it does |
|---|---|---|
| 1 | Suction | Hold to aspirate droplets, stains and pooled blood. Never on the dome. |
| 2 | Micro scissors | Click an arachnoid membrane to cut it. Cutting releases CSF and the fissure opens. Cutting anything else causes injury. |
| 3 | Bipolar | Hold on a bleeding point to coagulate it. You must see it, so suction first if it's under blood. |
| 4 | Dissector | Sweep along the aneurysm neck to free it. Tilt the scope to reach the far side. Pressure on the dome or bleb raises the hidden rupture risk. You can also drag across arachnoid to separate it bluntly. |
| 5 | Spatula | Click a lobe edge to place a spatula once the fissure has started to open, drag to adjust retraction, and press `X` to remove it. Watch the retraction pressure. |
| 0 | Temporary clip | Click the proximal ICA (below the PCom) to apply it; distal flow drops to about 18% and the occlusion timer starts. Click the clip again to remove it. |
| `S` (suction) | Park suction | Leaves the suction aspirating at that spot (left hand) while you use another instrument. Held in blood, it opens a clear window down to the tissue. |
| 6 | Aneurysm clip | Point at the neck to preview. Q/E rotate the blades (aim parallel to the ICA), the wheel or W/S sets blade depth, Tab switches straight/curved, click applies. Click the placed clip to remove it and reposition. |
| 7 | ICG angiography | Click or press Space to inject. The scope switches to near-infrared and vessels light up by arrival time and flow (arterial, then capillary blush, then veins). A dome that still fills, or a branch that doesn't, is visible here. |
| 8 | Micro Doppler | Hold on a vessel. A pulsatile tone means flow, silence means none, and a harsh high pitch over the ICA beside the clip means stenosis. A DOPPLER trace appears on the monitor. |
| 9 | Endoscope | Click beside the aneurysm to insert a 30° endoscope. A picture-in-picture view at the bottom left looks behind the neck. X withdraws it. |

## Procedure (M3)

The **checklist** on the left lists six steps. Each step unlocks when its sub-tasks are met, and each completed step shows the time it was finished.

1. Open the sylvian fissure: cut the 6 superficial arachnoid segments and place a frontal spatula
2. Identify M1: open the deep sylvian arachnoid and identify M1
3. Identify the ICA and optic nerve: open the carotid cistern and identify both
4. Confirm the PCom and dissect the neck: identify the PCom and AChA (tilt the scope), and free at least 85% of the neck
5. Clip the aneurysm (M5)
6. Confirm PCom patency with Doppler and ICG (M5)

**Identifying a structure** means holding the cursor or an instrument tip on it for about a second. A ring fills, and then a label pins itself to the structure. Only structures you can actually see can be identified.

The **mentor** panel (bottom right) shows short guidance for the step, sub-task checkboxes with progress bars, live guidelines (retraction pressure, bleeding, pressure on the dome), and alerts. `M` collapses it. `G` (or **Guide view**) swings the scope to a good working angle for the step. Click a step in the checklist to preview its guidance.

## Vitals, bleeding and rupture (M4)

The **monitor** (top right) shows a lead II ECG and an arterial-pressure trace, beat-by-beat HR and ABP (with MAP), SpO₂, EtCO₂, MEP, operation time, the temporary occlusion timer and estimated blood loss. It plays a pulse-oximeter tone whose pitch follows SpO₂, and IEC-style alarm tones. The bell silences alarms for 2 minutes.

- **Blood loss** lowers MAP and raises HR. Anaesthesia replaces volume, so values recover once bleeding stops. During temporary occlusion MAP is raised by about 15% (induced hypertension).
- **MEP** tolerates about 3 minutes of reduced flow, then falls. It recovers after reperfusion, but only partially after very long occlusion. MEP also falls if MAP stays low.
- **Bleeding looks and behaves physically:**
  - Arterial injuries spurt a pulsatile jet that splashes on tissue.
  - All bleeders feed rivulets that run downhill along the real surface and drip off edges.
  - Blood pools in the depth, and once a bleeder is under blood you can only see it by its welling and froth.
  - Bleeding from an injured artery scales with that vessel's flow and with arterial pressure.
- **Rupture:** rough handling of the dome (pressure, suction, bipolar, and especially touching the bleb) raises a hidden risk. Cutting the dome ruptures it at once. A rupture bleeds about 3 mL/s and floods the field within seconds. To recover:
  1. Park the suction near the proximal ICA.
  2. Place the temporary clip through the window the suction holds open.
  3. Clear the field.
  4. Clip the neck (M5).

## Clipping and verification (M5)

The clip result is computed from the actual 3D geometry (`src/procedure/clipEval.ts`):
- neck closure (the blades must span the flattened neck, about π × neck radius)
- residual neck (clip placed too high, or a curved tip riding up)
- ICA stenosis (blades too low, or not parallel to the ICA)
- PCom / AChA patency (their first millimetres caught in the jaws)

The result is not announced. You find it through **ICG** and **Doppler**, and the mentor comments only on what you have actually observed. The flow model then carries the consequences: a residual keeps a rupture bleeding, an occluded anterior choroidal drops MEP after a few minutes, and a stenosed ICA reduces flow and ICG brightness downstream. Parts of the clip hidden behind tissue are shown as a faint X-ray outline.

## Monitor precision

All vitals come from one circulation engine (`src/physics/hemodynamics.ts`) integrated at a fixed **2 ms step (500 Hz)**, independent of frame rate. It combines a Windkessel arterial model, ventricular ejection, Frank–Starling preload, a baroreflex blunted by anaesthesia, ventilator-induced pulse-pressure variation, and anaesthetist actions (fluids and vasopressor). Displayed numbers are **measured from the generated signals** the way a monitor measures them:
- SBP and DBP from each beat's peak and trough
- MAP as the beat's mean pressure
- HR from the R–R interval averaged over 4 beats
- SpO₂ averaged over 8 beats
- EtCO₂ as the end-tidal plateau of the capnogram

The ECG, arterial, pleth, CO₂ and Doppler traces are drawn sample by sample from 500 Hz buffers. Tissue pulsation, arterial jets and the Doppler tone follow the same simulated beats. User actions reach the engine within one 2 ms step. The event log records each action with its operation time to 0.1 s.

## Life-threatening haemorrhage (M6)

The circulation engine models how haemorrhage kills, following the ATLS classes:
- **Below 15% volume loss:** little change.
- **15–30%:** narrowing pulse pressure and tachycardia (blunted by anaesthesia).
- **30–40%:** falling pressure.
- **Beyond that:** collapse.

**Oxygen delivery.** Haemoglobin and lactate are tracked. Crystalloid given first dilutes the blood and only half stays in the vessels; blood products arrive once the **massive transfusion protocol** runs. Oxygen delivery (cardiac output × Hb) and coronary perfusion feed a **shock spiral** of falling myocardial contractility, then pre-terminal bradycardia, then **cardiac arrest (PEA)**.

**Resuscitation.** The code team starts chest compressions (about 110/min, MAP about 25–35, EtCO₂ 10–20) and gives epinephrine every 3–4 minutes. PEA deteriorates to **asystole** after about 3 minutes. Return of spontaneous circulation is possible only once the bleeding is controlled, volume is restored and Hb is above about 6.5.

**Brain.** Cerebral oxygen delivery fails below the autoregulation limit (MAP about 50) and as Hb falls, and anoxic dose accumulates. Significant anoxia makes the **brain swell** into the field.

**Death** is declared after 10 minutes of failed resuscitation or unsurvivable anoxic injury, and the debrief opens.

**Rupture and lacerations:**
- An uncontrolled rupture bleeds about 5 mL/s and the tear extends over time. Untreated, it typically causes arrest at about 14 minutes and death at about 24.
- A lacerated parent artery (ICA about 3 mL/s, M1 about 1.6 mL/s) cannot be coagulated. It needs proximal control plus **clip reconstruction**: point the aneurysm clip (6) at the tear. This stops the bleeding at the cost of reduced flow in that vessel.

**Anaesthesia and code-team actions** (fluids, massive transfusion, vasopressor, blood gases, CPR, epinephrine, ROSC) appear time-stamped in the monitor's event log.

## Debrief and demo (M6)

- **Debrief:** opens when you finish (mentor → *Finish & debrief*), choose *End case & debrief* in the checklist, or when the patient dies. It shows:
  - the outcome and expected neurological result
  - total time, blood loss and fluids, temporary occlusion, rupture, clip result, branch patency, lowest MAP and lowest MEP
  - a timeline of MAP, HR and MEP (small multiples with event markers, crosshair tooltip and data table)
  - specific tips drawn from what happened in the case
- **Demo mode:** *Demo mode* on the start screen (or `D`) performs the whole operation with the real instruments and narration. Click anywhere or press any key to take over at that exact point. Random complications are suppressed during the demo.

## Tuning the anatomy

Every anatomical size and position is in **`src/config/anatomy.ts`**. Units are millimetres,
and the file header describes the coordinate frame. Render and physiology constants are in
`src/config/sim.ts`.

## Layout

```
src/
  config/     anatomy.ts (all anatomy parameters), sim.ts (render/physiology constants)
  scene/      renderer, microscope camera rig, coaxial lighting, post-processing, autofocus
  anatomy/    lobes, vessels, aneurysm, nerves, arachnoid, spatulas, deep structures, textures, materials
  physics/    circulation engine (500 Hz), vitals + alarms, flow model, ICG, rupture, fissure model, blood (jets, rivulets, pool)
  state/      in-memory store + typed event bus
  tools/      tool manager (picking, 3D instrument cursors, highlight) + one file per instrument
  audio/      synthesised instrument sounds (Web Audio)
  ui/         start screen, HUD, toolbar, checklist, mentor, callouts, toasts, help
  procedure/  stage definitions, stage manager, structure identification
```

See `PLAN.md` for the milestone plan.
