import * as THREE from 'three';

/**
 * Tissue materials: MeshPhysicalMaterial (clearcoat = the thin film of CSF/saline that makes
 * everything glisten under the microscope light) extended with shader hooks:
 *
 *  - Cardiac pulsation: vertices move along their normals following an arterial pressure wave.
 *    For tubes the wave is delayed along the length (uv.x), so it travels downstream.
 *  - Respiratory motion (brain): slow swelling with the ventilator.
 *  - Fresnel rim: vessel walls look paler at grazing angles (more wall, less blood).
 *  - Hover highlight: a soft emissive rim used by the tools to show what they target.
 *  - Spatula indentation (brain): up to two capsule-shaped dimples, in object space.
 *  - Instrument indentation (all tissue): the active instrument tip pushes tissue in, in world
 *    space — you see the dome or the ICA give way under the dissector.
 *  - Fissure lip flare (brain + veins on it): the opercula splay apart as the fissure opens.
 *  - Arachnoid cut: a membrane parts along the cut line and its halves retract and fade.
 */

/** Uniforms shared by every tissue material (one object, updated once per frame). */
export const tissueGlobals = {
  uPhase: { value: 0 },
  uResp: { value: 0 },
  uTime: { value: 0 },
  /** Multiplier on all pulsation (e.g. reduced under temporary occlusion). */
  uPulseGain: { value: 1 },
  // Active instrument tip (world space).
  uToolTip: { value: new THREE.Vector3(1e4, 1e4, 1e4) },
  uToolDir: { value: new THREE.Vector3(0, 0, -1) },
  uToolRadius: { value: 1.6 },
  uToolDepth: { value: 0 },
  // Fissure opening (world space).
  uFlare: { value: 0 },
  uFlareZ0: { value: 8 },
  uFlareZ1: { value: 22 },
  uFlareHalfGap: { value: 0.6 },
  // ICG videoangiography: seconds since the dye bolus reached the ICA, and the NIR view blend.
  uIcgTime: { value: -100 },
  uIcgMix: { value: 0 },
};

export interface TissueOptions extends THREE.MeshPhysicalMaterialParameters {
  /** Radial pulse amplitude (mm). */
  pulseAmp?: number;
  /** Pulse delay along uv.x in cycles (0 = whole tube moves together). */
  pulseDelay?: number;
  /** Respiratory motion amplitude (mm). */
  respAmp?: number;
  /** Use the per-vertex `aPulseW` attribute to weight the pulse (e.g. aneurysm dome > neck). */
  pulseWeightAttr?: boolean;
  rimColor?: THREE.ColorRepresentation;
  rimAmount?: number;
  rimPower?: number;
  highlightColor?: THREE.ColorRepresentation;
  /** Enables the two spatula indentation slots (object space). */
  indentable?: boolean;
  /** Follows the fissure lip flare; +1 = frontal side (moves +Y), -1 = temporal side. */
  flareSide?: 1 | -1;
  /** Arachnoid-style cut along a line of constant local y. */
  cuttable?: boolean;
  /** Receives the instrument-tip indentation (default true). */
  toolDeform?: boolean;
}

export interface TissueUniforms {
  uPulseAmp: { value: number };
  uPulseDelay: { value: number };
  uRespAmp: { value: number };
  uRimColor: { value: THREE.Color };
  uRimAmount: { value: number };
  uRimPower: { value: number };
  uHighlight: { value: number };
  uHighlightColor: { value: THREE.Color };
  uIndentA: { value: THREE.Vector3[] };
  uIndentB: { value: THREE.Vector3[] };
  uIndentDir: { value: THREE.Vector3[] };
  uIndentRadius: { value: number[] };
  uIndentDepth: { value: number[] };
  uFlareSide: { value: number };
  uCut: { value: number };
  uCutY: { value: number };
  uCutRetract: { value: number };
  uCutGap: { value: number };
  uCutSoft: { value: number };
  /** ICG: dye arrival (s after the ICA), peak brightness, transit along uv.x (s), and a cut in uv.y
   * above which brightness is scaled by uIcgAbove (the part of the aneurysm beyond the clip). */
  uIcgArrive: { value: number };
  uIcgPeak: { value: number };
  uIcgTransit: { value: number };
  uIcgCutV: { value: number };
  uIcgAbove: { value: number };
}

export type TissueMaterial = THREE.MeshPhysicalMaterial & { userData: { tissue: TissueUniforms } };

const VERTEX_HEADER = /* glsl */ `
uniform float uPhase;
uniform float uResp;
uniform float uPulseGain;
uniform float uPulseAmp;
uniform float uPulseDelay;
uniform float uRespAmp;
uniform vec3 uToolTip;
uniform vec3 uToolDir;
uniform float uToolRadius;
uniform float uToolDepth;
#ifdef USE_PULSE_WEIGHT
attribute float aPulseW;
#endif
#ifdef USE_INDENT
uniform vec3 uIndentA[2];
uniform vec3 uIndentB[2];
uniform vec3 uIndentDir[2];
uniform float uIndentRadius[2];
uniform float uIndentDepth[2];
float capsuleFalloff(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
  float d = length(pa - ba * h);
  return 1.0 - smoothstep(0.0, r, d);
}
#endif
#ifdef USE_FLARE
uniform float uFlare;
uniform float uFlareZ0;
uniform float uFlareZ1;
uniform float uFlareHalfGap;
uniform float uFlareSide;
#endif
#ifdef USE_CUT
uniform float uCut;
uniform float uCutY;
uniform float uCutRetract;
varying float vCutDist;
#endif
varying vec2 vIcgUv;
// Arterial pressure wave: systolic upstroke, run-off and a dicrotic notch.
float cardiacWave(float ph) {
  float up = smoothstep(0.0, 0.1, ph);
  float decay = exp(-max(ph - 0.1, 0.0) * 3.2);
  float notch = 0.18 * exp(-pow((ph - 0.36) / 0.045, 2.0));
  return up * decay * 0.92 + notch;
}
`;

const VERTEX_DISPLACE = /* glsl */ `
#include <begin_vertex>
vIcgUv = uv;
{
  float ph = fract(uPhase - uv.x * uPulseDelay);
  float w = 1.0;
  #ifdef USE_PULSE_WEIGHT
  w = aPulseW;
  #endif
  transformed += objectNormal * (uPulseAmp * uPulseGain * w * cardiacWave(ph) + uRespAmp * uResp);
  #ifdef USE_INDENT
  for (int i = 0; i < 2; i++) {
    if (uIndentDepth[i] > 0.0) {
      float f = capsuleFalloff(transformed, uIndentA[i], uIndentB[i], uIndentRadius[i]);
      transformed += uIndentDir[i] * f * f * uIndentDepth[i];
    }
  }
  #endif
  #ifdef USE_CUT
  {
    float dy = transformed.y - uCutY;
    vCutDist = dy;
    // The two halves spring back toward their attachments and bunch up.
    transformed.y += sign(dy) * uCut * uCutRetract * (0.35 + 0.65 * smoothstep(0.0, uCutRetract, abs(dy)));
    transformed.z -= uCut * uCut * 0.6;
  }
  #endif
  vec3 wOff = vec3(0.0);
  vec3 wp = (modelMatrix * vec4(transformed, 1.0)).xyz;
  #ifdef USE_TOOL_DEFORM
  if (uToolDepth > 0.0) {
    float d = length(wp - uToolTip);
    float f = 1.0 - smoothstep(0.0, uToolRadius, d);
    wOff += uToolDir * f * f * uToolDepth;
  }
  #endif
  #ifdef USE_FLARE
  {
    float h = clamp((wp.z - uFlareZ0) / (uFlareZ1 - uFlareZ0), 0.0, 1.0);
    float nearLip = exp(-max(abs(wp.y) - uFlareHalfGap, 0.0) / 9.0);
    wOff.y += uFlareSide * uFlare * h * h * (3.0 - 2.0 * h) * nearLip;
  }
  #endif
  if (dot(wOff, wOff) > 0.0) transformed += inverse(mat3(modelMatrix)) * wOff;
}
`;

const FRAGMENT_HEADER = /* glsl */ `
uniform float uIcgTime;
uniform float uIcgMix;
uniform float uIcgArrive;
uniform float uIcgPeak;
uniform float uIcgTransit;
uniform float uIcgCutV;
uniform float uIcgAbove;
varying vec2 vIcgUv;
// Indocyanine green time–intensity curve: gamma-variate bolus + recirculation plateau.
float icgCurve(float t) {
  if (t <= 0.0) return 0.0;
  float g = pow(t / 1.3, 2.0) * exp(2.0 * (1.0 - t / 1.3));
  return g + 0.3 * smoothstep(1.0, 6.0, t) * exp(-t / 30.0);
}
uniform vec3 uRimColor;
uniform float uRimAmount;
uniform float uRimPower;
uniform float uHighlight;
uniform vec3 uHighlightColor;
uniform float uTime;
#ifdef USE_CUT
uniform float uCut;
uniform float uCutGap;
uniform float uCutSoft;
varying float vCutDist;
#endif
`;

const FRAGMENT_ALPHA = /* glsl */ `
#include <alphamap_fragment>
#ifdef USE_CUT
if (uCut > 0.0) {
  diffuseColor.a *= smoothstep(uCut * uCutGap, uCut * uCutGap + uCutSoft, abs(vCutDist)) * (1.0 - 0.7 * uCut);
}
#endif
`;

const FRAGMENT_RIM = /* glsl */ `
#include <normal_fragment_maps>
float tissueFres = pow(1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0), uRimPower);
diffuseColor.rgb = mix(diffuseColor.rgb, uRimColor, tissueFres * uRimAmount);
`;

const FRAGMENT_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
if (uHighlight > 0.001) {
  float breathe = 0.8 + 0.2 * sin(uTime * 5.0);
  totalEmissiveRadiance += uHighlightColor * uHighlight * (0.08 + tissueFres * 0.9) * breathe * (1.0 - uIcgMix);
}
if (uIcgMix > 0.001 && uIcgPeak > 0.0) {
  // Near-infrared fluorescence of intravascular ICG (seen by the microscope's NIR camera).
  float tt = uIcgTime - uIcgArrive - vIcgUv.x * uIcgTransit;
  float part = vIcgUv.y < uIcgCutV ? 1.0 : uIcgAbove;
  float c = icgCurve(tt) * uIcgPeak * part;
  totalEmissiveRadiance += vec3(0.9, 1.0, 0.95) * c * uIcgMix * (0.55 + 0.95 * pow(1.0 - tissueFres, 1.5));
}
`;

export function createTissueMaterial(opts: TissueOptions): TissueMaterial {
  const {
    pulseAmp = 0,
    pulseDelay = 0,
    respAmp = 0,
    pulseWeightAttr = false,
    rimColor = 0xffffff,
    rimAmount = 0,
    rimPower = 3,
    highlightColor = 0x5ad1e6,
    indentable = false,
    flareSide,
    cuttable = false,
    toolDeform = true,
    ...params
  } = opts;

  const mat = new THREE.MeshPhysicalMaterial({
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    roughness: 0.42,
    metalness: 0,
    ...params,
  }) as TissueMaterial;

  const zero3 = () => [new THREE.Vector3(), new THREE.Vector3()];
  const u: TissueUniforms = {
    uPulseAmp: { value: pulseAmp },
    uPulseDelay: { value: pulseDelay },
    uRespAmp: { value: respAmp },
    uRimColor: { value: new THREE.Color(rimColor) },
    uRimAmount: { value: rimAmount },
    uRimPower: { value: rimPower },
    uHighlight: { value: 0 },
    uHighlightColor: { value: new THREE.Color(highlightColor) },
    uIndentA: { value: zero3() },
    uIndentB: { value: zero3() },
    uIndentDir: { value: zero3() },
    uIndentRadius: { value: [1, 1] },
    uIndentDepth: { value: [0, 0] },
    uFlareSide: { value: flareSide ?? 0 },
    uCut: { value: 0 },
    uCutY: { value: 0 },
    uCutRetract: { value: 0.5 },
    uCutGap: { value: 0.08 },
    uCutSoft: { value: 0.05 },
    uIcgArrive: { value: 0 },
    uIcgPeak: { value: 0 },
    uIcgTransit: { value: 0 },
    uIcgCutV: { value: 2 },
    uIcgAbove: { value: 1 },
  };
  mat.userData.tissue = u;

  const defines: Record<string, string> = {};
  if (pulseWeightAttr) defines.USE_PULSE_WEIGHT = '';
  if (indentable) defines.USE_INDENT = '';
  if (flareSide) defines.USE_FLARE = '';
  if (cuttable) defines.USE_CUT = '';
  if (toolDeform) defines.USE_TOOL_DEFORM = '';
  mat.defines = { ...mat.defines, ...defines };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, tissueGlobals, u);
    shader.vertexShader = VERTEX_HEADER + shader.vertexShader.replace('#include <begin_vertex>', VERTEX_DISPLACE);
    shader.fragmentShader =
      FRAGMENT_HEADER +
      shader.fragmentShader
        .replace('#include <alphamap_fragment>', FRAGMENT_ALPHA)
        .replace('#include <normal_fragment_maps>', FRAGMENT_RIM)
        .replace('#include <emissivemap_fragment>', FRAGMENT_EMISSIVE);
  };
  const key = `tissue-${Object.keys(defines).sort().join('-')}`;
  mat.customProgramCacheKey = () => key;
  return mat;
}

/** Surgical steel (spatulas, instruments, clips). */
export function createSteelMaterial(params: THREE.MeshPhysicalMaterialParameters = {}): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    // Brushed surgical steel: not a perfect mirror, so it still reads under the coaxial light
    // even when it reflects the dark surroundings.
    color: 0xc4c9ce,
    metalness: 0.55,
    roughness: 0.3,
    clearcoat: 0.3,
    clearcoatRoughness: 0.2,
    envMapIntensity: 2.6,
    ...params,
  });
}
