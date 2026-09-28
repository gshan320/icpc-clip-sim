/**
 * Simulation and rendering constants (non-anatomical). Anatomy lives in ./anatomy.ts.
 */

export const RENDER = {
  /** Maximum device pixel ratio per quality level. Retina screens are capped to keep 60 fps. */
  maxPixelRatio: { high: 1.6, low: 1.0 },
  minPixelRatio: 0.75,
  /** MSAA samples for the post-processing composer. */
  multisampling: { high: 4, low: 0 },
  shadows: { high: true, low: false },
  ambientOcclusion: { high: true, low: false },
  /** Target frame time (ms) for adaptive resolution. */
  targetFrameMs: 16.7,
};

export const MICROSCOPE = {
  /** Warm halogen/xenon-like light colour. */
  lightColor: 0xfff1de,
  lightIntensity: 6.0e4,
  /** Offset of the light from the optical axis (mm) — gives very soft relief shadows. */
  lightOffset: [6, 10, 0] as [number, number, number],
  lightAngleDeg: 16,
  /** Depth-of-field: in-focus range (mm) either side of the focal plane and blur strength. */
  focusRange: 9,
  bokehScale: 2.4,
  /** Autofocus smoothing (1/s). */
  autofocusSpeed: 5,
  /** Circular field stop (fraction of the smaller screen dimension). */
  fieldRadius: 0.485,
  fieldSoftness: 0.035,
  bloom: { intensity: 0.55, threshold: 0.62, smoothing: 0.25, radius: 0.72 },
  exposure: 1.0,
  grain: 0.045,
  chromaticAberration: 0.0012,
};

export const PHYSIOLOGY = {
  /** Baseline heart rate (beats per minute) — drives tissue pulsation. */
  heartRate: 72,
  /** Respiratory rate (breaths per minute, ventilated patient). */
  respRate: 12,
  /** Brain respiratory motion amplitude (mm). */
  brainRespAmp: 0.06,
  /** Brain cardiac pulsation amplitude (mm). */
  brainPulseAmp: 0.035,
};
