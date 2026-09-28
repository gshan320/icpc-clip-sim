/**
 * ANATOMY CONFIGURATION — every size and position of the procedural anatomy lives here.
 *
 * Units: 1 scene unit = 1 millimetre.
 *
 * Surgical coordinate frame (what you see through the microscope, right pterional approach,
 * patient supine with the head turned ~30° to the left):
 *
 *   +X  = lateral  (screen right, toward the right sylvian fissure / insula)
 *   -X  = medial   (screen left, toward the midline, optic chiasm)
 *   +Y  = frontal  (screen up, frontal lobe side of the fissure)
 *   -Y  = temporal (screen down, temporal lobe / skull-base side)
 *   +Z  = superficial (toward the surgeon and the microscope)
 *   -Z  = deep
 *
 * The origin is placed near the IC-PC junction (where the posterior communicating artery leaves
 * the internal carotid artery), because that is where the aneurysm and the whole operation is.
 *
 * Tip: run the app with `?debug` in the URL to get a live tuning panel.
 */

export type V3 = [number, number, number];

// ---------------------------------------------------------------------------------------------
// Brain lobes
// ---------------------------------------------------------------------------------------------

export interface LobeConfig {
  /**
   * Centre of the underlying superquadric when the fissure is closed (gap = 0). The lobe's
   * "lip" — the part of the operculum that faces the fissure — is at the centre's height (z).
   */
  center: V3;
  /** Half-extents (x, y, z). */
  radii: V3;
  /**
   * Squareness of the cross-section across the fissure (y–z). 2 = ellipse (round, dome-like),
   * higher = flatter cortical surface with a more rounded-square edge at the fissure.
   */
  exponent: number;
  /** Depth (mm) of the sulci carved into the cortex. */
  sulcusDepth: number;
  /** Spatial frequency of the gyral pattern (1 / mm). Real gyri are ~8–12 mm wide. */
  gyrusFrequency: number;
  /** Mesh resolution (sphere width/height segments). */
  segments: [number, number];
  /** Random seed so each lobe gets a different gyral pattern. */
  seed: number;
}

export const LOBES = {
  /**
   * Frontal lobe: in the pterional view it sits above the fissure. Its opercular surface forms
   * the upper wall of the transsylvian corridor; deeper, its orbital surface overhangs the optic
   * nerve and A1.
   */
  frontal: {
    center: [4, 22, 8],
    radii: [48, 22, 15],
    exponent: 2.6,
    sulcusDepth: 2.3,
    gyrusFrequency: 0.075,
    segments: [260, 190],
    seed: 11,
  } satisfies LobeConfig,
  /**
   * Temporal lobe: below the fissure. Its superior (opercular) surface forms the lower wall.
   * The superficial sylvian veins run along its upper edge.
   */
  temporal: {
    center: [8, -20, 7],
    radii: [42, 20, 14],
    exponent: 2.6,
    sulcusDepth: 2.1,
    gyrusFrequency: 0.08,
    segments: [240, 180],
    seed: 23,
  } satisfies LobeConfig,
};

/**
 * Sylvian fissure opening. The gap is the distance (mm) between the frontal and temporal
 * opercula at their closest point. Closed = arachnoid intact; open = split and gently retracted.
 *
 * Opening is earned in the simulation: each cut arachnoid segment releases CSF and lets the lobes
 * fall apart a little; the spatulas add a little more (at the cost of retraction pressure).
 */
export const FISSURE = {
  /** Slightly negative: the closed opercula press together, so nothing shows through. */
  closedGap: -1.2,
  openGap: 14,
  /** Starting opening (0 = closed, 1 = fully open). */
  initialOpen: 0,
  /**
   * When open, the superficial lips splay outward (like opercula retracted apart), making the
   * corridor V-shaped: extra mm of lateral displacement at the surface.
   */
  lipFlare: 5,
  /** Heights (z) between which the flare ramps in (from the lip up to the cortical surface). */
  flareZ: [8, 22] as [number, number],
  /** Contribution of each arachnoid group to the opening (sums with retraction, capped at 1). */
  openingFromCuts: { 'sylvian-superficial': 0.6, 'sylvian-deep': 0.15 },
  /** Maximum extra opening from full retraction with both spatulas. */
  openingFromRetraction: 0.3,
  /** Seconds for the brain to settle after each cut (CSF drains, lobes relax apart). */
  relaxTime: 1.4,
};

// ---------------------------------------------------------------------------------------------
// Arteries and veins (TubeGeometry along Catmull-Rom splines)
// ---------------------------------------------------------------------------------------------

export type VesselKind = 'artery' | 'vein' | 'perforator';

export interface VesselConfig {
  id: string;
  label: string;
  kind: VesselKind;
  /** Control points of the centreline spline, from proximal (upstream) to distal (downstream). */
  points: V3[];
  /** Radius (mm) at the start and at the end; interpolated along the length. */
  radius: [number, number];
  /** Parent vessel id (for the flow graph) — flow into this vessel depends on the parent. */
  parent?: string;
  /** Fraction of the parent's flow this vessel normally receives (for Doppler/ICG later). */
  flowShare?: number;
  /** Pulsation amplitude (mm of radial wall motion). */
  pulse: number;
  /** Tube resolution. */
  tubular?: number;
  radial?: number;
}

/**
 * Supraclinoid internal carotid artery (ICA): leaves the distal dural ring under the anterior
 * clinoid process (deep, lower-left in the view), climbs toward the ICA bifurcation under the
 * medial end of the sylvian fissure. On its way it gives off (from proximal to distal):
 *   ophthalmic artery (not modelled, hidden under the clinoid) → PCom → anterior choroidal.
 * A typical adult supraclinoid ICA is ~4 mm in diameter.
 */
export const VESSELS: VesselConfig[] = [
  {
    id: 'ica',
    label: 'Internal carotid artery (ICA)',
    kind: 'artery',
    points: [
      [-5.6, -12.0, -6.2],
      [-4.6, -8.2, -3.8],
      [-3.1, -4.5, -2.2],
      [-1.4, -0.6, -1.2],
      [-0.2, 3.0, -0.4],
      [1.0, 6.0, 0.4],
    ],
    radius: [2.05, 1.8],
    flowShare: 1,
    pulse: 0.07,
    tubular: 160,
    radial: 40,
  },
  {
    /**
     * M1 (sphenoidal segment of the middle cerebral artery): runs laterally from the ICA
     * bifurcation along the sphenoid ridge, deep in the sylvian fissure. Identifying M1 early lets
     * the surgeon follow it back (proximally) to the ICA.
     */
    id: 'm1',
    label: 'M1 — middle cerebral artery',
    kind: 'artery',
    parent: 'ica',
    flowShare: 0.62,
    points: [
      [1.0, 6.0, 0.4],
      [4.2, 7.2, 1.2],
      [9.0, 7.6, 1.0],
      [14.0, 7.0, 0.0],
      [18.0, 5.8, -1.0],
    ],
    radius: [1.4, 1.3],
    pulse: 0.05,
    tubular: 120,
    radial: 28,
  },
  {
    /** M2 superior trunk: runs over the insula and climbs out of the fissure toward the frontal operculum. */
    id: 'm2s',
    label: 'M2 — superior trunk',
    kind: 'artery',
    parent: 'm1',
    flowShare: 0.5,
    points: [
      [18.0, 5.8, -1.0],
      [22.0, 6.6, 1.5],
      [26.0, 5.2, 6.0],
      [30.0, 4.5, 11.0],
      [33.0, 6.0, 15.0],
      [35.0, 12.0, 18.0],
    ],
    radius: [1.05, 0.9],
    pulse: 0.04,
    tubular: 110,
    radial: 24,
  },
  {
    /** M2 inferior trunk: toward the temporal operculum. */
    id: 'm2i',
    label: 'M2 — inferior trunk',
    kind: 'artery',
    parent: 'm1',
    flowShare: 0.5,
    points: [
      [18.0, 5.8, -1.0],
      [22.0, 3.2, 0.3],
      [26.0, 0.2, 4.6],
      [30.0, -2.4, 10.0],
      [33.0, -5.0, 14.0],
      [35.0, -11.0, 17.0],
    ],
    radius: [1.0, 0.85],
    pulse: 0.04,
    tubular: 110,
    radial: 24,
  },
  {
    /**
     * A1 (precommunicating anterior cerebral artery): runs medially from the bifurcation, passing
     * ABOVE (superficial to) the optic nerve / chiasm toward the anterior communicating artery.
     */
    id: 'a1',
    label: 'A1 — anterior cerebral artery',
    kind: 'artery',
    parent: 'ica',
    flowShare: 0.3,
    points: [
      [1.0, 6.0, 0.4],
      [-2.0, 7.6, -0.2],
      [-7.0, 8.8, -1.5],
      [-12.0, 10.5, -3.0],
      [-18.0, 10.0, -5.0],
    ],
    radius: [1.05, 0.95],
    pulse: 0.04,
    tubular: 110,
    radial: 24,
  },
  {
    /**
     * Posterior communicating artery (PCom): arises from the POSTERIOR wall of the supraclinoid
     * ICA and runs posteromedially (deep and toward the midline) to join the posterior cerebral
     * artery. It is often partly hidden behind the ICA and the aneurysm neck — the surgeon must
     * see it (and its thalamoperforators) before clipping, and keep it open afterwards.
     */
    id: 'pcom',
    label: 'Posterior communicating artery (PCom)',
    kind: 'artery',
    parent: 'ica',
    flowShare: 0.05,
    points: [
      // Seen through the opticocarotid window (between the ICA and the optic nerve).
      [-1.9, -1.6, -2.2],
      [-3.7, -2.7, -3.4],
      [-5.6, -4.0, -4.6],
      [-7.3, -5.9, -6.4],
      [-8.8, -8.4, -8.9],
    ],
    radius: [0.7, 0.6],
    pulse: 0.03,
    tubular: 90,
    radial: 18,
  },
  {
    /**
     * Anterior choroidal artery (AChA): arises from the posterior wall 2–4 mm DISTAL to the PCom
     * and runs posterolaterally toward the choroidal fissure. It is small (~1 mm) but supplies the
     * internal capsule — occluding it with a clip can cause hemiplegia, so it must stay patent.
     */
    id: 'acha',
    label: 'Anterior choroidal artery (AChA)',
    kind: 'artery',
    parent: 'ica',
    flowShare: 0.03,
    points: [
      [-0.35, 3.0, -1.6],
      [1.8, 2.8, -3.0],
      [5.2, 1.4, -4.6],
      [10.0, -1.2, -6.4],
      [16.0, -3.4, -7.4],
    ],
    radius: [0.45, 0.38],
    pulse: 0.02,
    tubular: 90,
    radial: 16,
  },
  // Lenticulostriate perforators from the deep (posterior-superior) wall of M1.
  {
    id: 'lsa1',
    label: 'Lenticulostriate perforator',
    kind: 'perforator',
    parent: 'm1',
    flowShare: 0.02,
    points: [
      [7.0, 8.0, 0.4],
      [7.4, 9.2, -1.6],
      [7.0, 10.4, -4.4],
      [6.4, 10.8, -8.0],
    ],
    radius: [0.2, 0.16],
    pulse: 0.01,
    tubular: 40,
    radial: 8,
  },
  {
    id: 'lsa2',
    label: 'Lenticulostriate perforator',
    kind: 'perforator',
    parent: 'm1',
    flowShare: 0.02,
    points: [
      [11.0, 7.7, 0.2],
      [11.8, 8.8, -1.8],
      [12.0, 9.6, -4.6],
      [11.6, 10.2, -8.0],
    ],
    radius: [0.2, 0.15],
    pulse: 0.01,
    tubular: 40,
    radial: 8,
  },
];

/**
 * Superficial sylvian veins: run along the fissure on the TEMPORAL side, draining into the
 * sphenoparietal sinus. The fissure is usually opened on the frontal side of these veins so they
 * stay with the temporal lobe. They are dropped onto the temporal cortex from above.
 */
export const SYLVIAN_VEINS = {
  /** Radius of the main vein (mm). */
  radius: 1.0,
  /** x range sampled along the fissure (medial → lateral). */
  xRange: [-6, 46] as [number, number],
  /** Distance (mm) of the main vein from the temporal lip. */
  lipDistance: 2.6,
  /** Smaller tributaries: [x start, x end, distance-from-lip start, distance end, radius]. */
  tributaries: [
    [14, 22, 14, 3, 0.55],
    [30, 37, 16, 3, 0.6],
    [4, 9, 12, 3, 0.45],
  ] as [number, number, number, number, number][],
};

// ---------------------------------------------------------------------------------------------
// The aneurysm
// ---------------------------------------------------------------------------------------------

export const ANEURYSM = {
  /** Where along the ICA centreline (0 = proximal, 1 = bifurcation) the neck is centred. */
  icaT: 0.53,
  /**
   * Projection of the dome. IC-PC aneurysms classically point POSTEROLATERALLY and INFERIORLY,
   * toward the tentorial edge and the oculomotor nerve (which is why they can present with a
   * third-nerve palsy). In our frame: lateral (+x), deep (-z), downward toward the temporal side (-y).
   */
  direction: [0.62, -0.36, -0.7] as V3,
  /** Maximum dome diameter (mm). */
  domeDiameter: 6.6,
  /** Neck diameter (mm) — small neck relative to the dome makes it "clippable". */
  neckDiameter: 4.1,
  /** Height from the ICA wall to the dome apex (mm). */
  height: 7.4,
  /**
   * Bleb (daughter sac) on the dome: thin-walled, the most rupture-prone spot.
   * Position is given as angles on the dome: polar from the dome axis, azimuth around it.
   */
  bleb: { polarDeg: 40, azimuthDeg: 120, radius: 1.1, height: 1.5 },
  /** Wall pulsation at the dome apex (mm) — thinner wall pulses more than the parent artery. */
  pulse: 0.12,
  /** Surface irregularity (mm). */
  irregularity: 0.18,
  segments: [96, 72] as [number, number],
};

// ---------------------------------------------------------------------------------------------
// Cranial nerves
// ---------------------------------------------------------------------------------------------

export const NERVES = {
  /**
   * Right optic nerve (CN II): flat, white, lying medial to the ICA. It runs from the optic canal
   * back to the chiasm. The space between the optic nerve and the ICA is the opticocarotid
   * triangle, a common working window.
   */
  optic: {
    label: 'Optic nerve (CN II)',
    points: [
      [-10.2, -13.0, -1.6],
      [-8.6, -6.0, -2.2],
      [-7.9, 0.5, -3.0],
      [-9.0, 6.8, -4.4],
      [-12.5, 11.5, -6.2],
    ] as V3[],
    /** Elliptical cross-section: half-width, half-thickness (mm). */
    halfWidth: 2.5,
    halfThickness: 1.5,
  },
  /**
   * Oculomotor nerve (CN III): leaves the midbrain, passes between the posterior cerebral and
   * superior cerebellar arteries, then runs forward along the tentorial edge. A posterolaterally
   * pointing IC-PC aneurysm sits right on top of it.
   */
  oculomotor: {
    label: 'Oculomotor nerve (CN III)',
    points: [
      [-7.0, -8.6, -12.5],
      [-1.5, -8.3, -9.6],
      [4.0, -8.9, -8.0],
      [10.0, -10.0, -7.4],
      [17.0, -11.6, -7.6],
    ] as V3[],
    radius: 1.2,
  },
};

// ---------------------------------------------------------------------------------------------
// Other structures in the depth of the field
// ---------------------------------------------------------------------------------------------

export const SURROUNDINGS = {
  /** Anterior clinoid process (bone), covering the proximal ICA as it leaves the dural ring. */
  clinoid: { center: [-7.5, -16.0, 0.0] as V3, radii: [6.0, 4.4, 3.4] as V3 },
  /** Tentorial edge (free edge of the tentorium cerebelli, dura) running along the deep field. */
  tentorium: {
    points: [
      [-14, -12.5, -13.5],
      [-2, -12.0, -11.5],
      [10, -13.4, -10.0],
      [24, -15.5, -10.0],
    ] as V3[],
    radius: 1.6,
  },
  /** Deep cistern floor (interpeduncular / crural cistern membranes) — the dark background. */
  floor: { z: -14, size: [80, 60] as [number, number] },
  /** Insula (island of Reil): the cortex at the bottom of the lateral sylvian fissure. */
  insula: { center: [25, 3, -7.5] as V3, radii: [11, 10, 4] as V3 },
};

// ---------------------------------------------------------------------------------------------
// Arachnoid membranes (cuttable)
// ---------------------------------------------------------------------------------------------

export interface ArachnoidPatchConfig {
  id: string;
  /** Which group this membrane belongs to — used by the procedure stages. */
  group: 'sylvian-superficial' | 'sylvian-deep' | 'carotid-cistern' | 'neck';
  center: V3;
  /** Width (along x), height (along y, before stretching with the fissure gap). */
  size: [number, number];
  /** Tilt around x and y (degrees). */
  tilt?: [number, number];
  /** Whether the patch spans the fissure (stretches as the lobes separate). */
  spansFissure: boolean;
}

export const ARACHNOID: ArachnoidPatchConfig[] = [
  // Superficial sylvian arachnoid, bridging the fissure lips (opened first, lateral → medial).
  { id: 'ss1', group: 'sylvian-superficial', center: [15, 0, 18.4], size: [7, 8], spansFissure: true },
  { id: 'ss2', group: 'sylvian-superficial', center: [9, 0, 18.8], size: [7, 8], spansFissure: true },
  { id: 'ss3', group: 'sylvian-superficial', center: [3, 0, 19.0], size: [7, 8], spansFissure: true },
  { id: 'ss4', group: 'sylvian-superficial', center: [-3, 0, 19.0], size: [7, 8], spansFissure: true },
  { id: 'ss5', group: 'sylvian-superficial', center: [-9, 0, 18.8], size: [7, 8], spansFissure: true },
  { id: 'ss6', group: 'sylvian-superficial', center: [-15, 0, 18.2], size: [7, 8], spansFissure: true },
  // Deep sylvian trabeculae around M1/M2.
  { id: 'sd1', group: 'sylvian-deep', center: [21, 2, 5], size: [9, 10], tilt: [0, 18], spansFissure: false },
  { id: 'sd2', group: 'sylvian-deep', center: [13, 2.5, 4], size: [9, 10], tilt: [8, 6], spansFissure: false },
  { id: 'sd3', group: 'sylvian-deep', center: [6, 3, 3.6], size: [8, 9], tilt: [10, 0], spansFissure: false },
  // Carotid cistern membrane over the ICA and optic nerve.
  { id: 'cc1', group: 'carotid-cistern', center: [-3, 3, 3.4], size: [9, 9], tilt: [-8, 0], spansFissure: false },
  { id: 'cc2', group: 'carotid-cistern', center: [-4, -5, 3.0], size: [10, 9], tilt: [10, 0], spansFissure: false },
  { id: 'cc3', group: 'carotid-cistern', center: [-10, -1, 2.4], size: [7, 14], tilt: [0, -12], spansFissure: false },
  // Arachnoid adhesions around the aneurysm neck (freed with the dissector in stage 4).
  { id: 'nk1', group: 'neck', center: [2.0, -1.5, 1.6], size: [5, 4], tilt: [20, 30], spansFissure: false },
  { id: 'nk2', group: 'neck', center: [1.0, -4.2, -0.6], size: [5, 4], tilt: [55, 20], spansFissure: false },
];

// ---------------------------------------------------------------------------------------------
// Brain spatulas (self-retaining retractor blades)
// ---------------------------------------------------------------------------------------------

export const SPATULAS = {
  /** Blade width, length and thickness (mm). A typical tapered spatula is 3–6 mm at the tip. */
  width: 5,
  tipWidth: 3.8,
  length: 34,
  thickness: 0.45,
  /** Tip positions (x, z); y is computed from the lobe wall at that depth. */
  frontalTip: [15, 7] as [number, number],
  temporalTip: [19, 6.5] as [number, number],
  /** How deep (mm) the blade presses into the cortex. */
  indent: 0.7,
};

// ---------------------------------------------------------------------------------------------
// Default microscope view
// ---------------------------------------------------------------------------------------------

export const VIEW = {
  /** The point the microscope is aimed at by default (≈ aneurysm neck). */
  target: [0.6, -0.5, 0] as V3,
  /** Working distance (mm) — distance from the objective to the focal point. */
  distance: 180,
  /** Vertical field of view of the virtual camera (degrees) at zoom 1. */
  fov: 14,
  /** Default approach angle: azimuth (+ = from lateral) and polar (90 = straight down the Z axis). */
  azimuthDeg: 10,
  polarDeg: 90,
  /** How far the scope can be tilted from the default axis (degrees). */
  azimuthRange: [-26, 36] as [number, number],
  polarRange: [66, 120] as [number, number],
  /** Zoom range (camera.zoom). The HUD shows magnification = zoom × baseMagnification. */
  zoomRange: [0.7, 3.6] as [number, number],
  baseMagnification: 6,
  /** How far the pivot may be panned away from the default target (mm). */
  panLimit: [22, 18, 16] as V3,
};
