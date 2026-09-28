import { N8AOPostPass } from 'n8ao';
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  DepthOfFieldEffect,
  Effect,
  EffectComposer,
  EffectPass,
  NoiseEffect,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing';
import * as THREE from 'three';
import { MICROSCOPE, RENDER } from '../config/sim';

/**
 * The "looking through an operating microscope" look:
 *  1. Ambient occlusion (N8AO) — deep crevices and the corridor walls darken naturally.
 *  2. Shallow depth of field — only a few millimetres around the focal plane are sharp.
 *  3. Bloom on the wet specular highlights.
 *  4. MicroscopeEffect — circular field stop, eyepiece vignette, warm colour grade.
 *  5. Slight lateral chromatic aberration toward the edge and fine sensor grain.
 */

const microscopeFrag = /* glsl */ `
uniform float fieldRadius;
uniform float fieldSoftness;
uniform float vignette;
uniform vec3 warmth;
uniform float contrast;
uniform float fade;
uniform float icg;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float r = length(p);
  // Eyepiece field stop: crisp-but-soft circular edge.
  float mask = 1.0 - smoothstep(fieldRadius - fieldSoftness, fieldRadius, r);
  // Optical vignetting inside the field (cos^4-like fall-off).
  float v = 1.0 - vignette * pow(clamp(r / fieldRadius, 0.0, 1.0), 2.6);
  vec3 c = inputColor.rgb * mix(warmth, vec3(1.0), icg) * v;
  // NIR camera: monochrome, high-contrast fluorescence image.
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(c, vec3(pow(clamp(lum * 1.15, 0.0, 1.0), 0.85)) * vec3(0.93, 1.0, 0.96), icg);
  // Gentle S-curve for a punchier surgical image.
  c = mix(c, c * c * (3.0 - 2.0 * c), contrast);
  // A faint warm glow that bleeds just past the field stop.
  float halo = smoothstep(fieldRadius + 0.025, fieldRadius, r) * (1.0 - mask) * 0.015;
  vec3 outside = vec3(0.0015, 0.0013, 0.0012) + vec3(0.9, 0.55, 0.35) * halo;
  c = mix(outside, c, mask);
  outputColor = vec4(c * fade, inputColor.a);
}
`;

export class MicroscopeEffect extends Effect {
  constructor() {
    super('MicroscopeEffect', microscopeFrag, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ['fieldRadius', new THREE.Uniform(MICROSCOPE.fieldRadius)],
        ['fieldSoftness', new THREE.Uniform(MICROSCOPE.fieldSoftness)],
        ['vignette', new THREE.Uniform(0.42)],
        ['warmth', new THREE.Uniform(new THREE.Vector3(1.04, 0.99, 0.92))],
        ['contrast', new THREE.Uniform(0.22)],
        ['fade', new THREE.Uniform(1)],
        ['icg', new THREE.Uniform(0)],
      ]),
    });
  }
  get fieldRadius(): number {
    return this.uniforms.get('fieldRadius')!.value as number;
  }
  set fieldRadius(v: number) {
    this.uniforms.get('fieldRadius')!.value = v;
  }
  set fade(v: number) {
    this.uniforms.get('fade')!.value = v;
  }
  get fade(): number {
    return this.uniforms.get('fade')!.value as number;
  }
  set icg(v: number) {
    this.uniforms.get('icg')!.value = v;
  }
}

export interface PostFX {
  composer: EffectComposer;
  dof: DepthOfFieldEffect;
  bloom: BloomEffect;
  microscope: MicroscopeEffect;
  ao: N8AOPostPass | null;
  setFocusDistance(d: number): void;
  setSize(w: number, h: number): void;
  setAO(enabled: boolean): void;
  render(dt: number): void;
}

export function createPostFX(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  quality: 'high' | 'low',
): PostFX {
  const composer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,
    multisampling: RENDER.multisampling[quality],
  });
  composer.addPass(new RenderPass(scene, camera));

  let ao: N8AOPostPass | null = null;
  try {
    ao = new N8AOPostPass(scene, camera, window.innerWidth, window.innerHeight);
    ao.configuration.aoRadius = 3.2;
    ao.configuration.distanceFalloff = 1.0;
    ao.configuration.intensity = 2.6;
    ao.configuration.color = new THREE.Color(0x1a0504);
    ao.configuration.halfRes = true;
    ao.configuration.gammaCorrection = false;
    ao.setQualityMode('Medium');
    ao.enabled = RENDER.ambientOcclusion[quality];
    composer.addPass(ao);
  } catch (err) {
    console.warn('N8AO unavailable, continuing without ambient occlusion', err);
    ao = null;
  }

  const dof = new DepthOfFieldEffect(camera, {
    focusDistance: 180,
    focusRange: MICROSCOPE.focusRange,
    bokehScale: MICROSCOPE.bokehScale,
    resolutionScale: 0.6,
  });
  composer.addPass(new EffectPass(camera, dof));

  const bloom = new BloomEffect({
    mipmapBlur: true,
    intensity: MICROSCOPE.bloom.intensity,
    luminanceThreshold: MICROSCOPE.bloom.threshold,
    luminanceSmoothing: MICROSCOPE.bloom.smoothing,
    radius: MICROSCOPE.bloom.radius,
  });
  const ca = new ChromaticAberrationEffect({
    offset: new THREE.Vector2(MICROSCOPE.chromaticAberration, MICROSCOPE.chromaticAberration * 0.6),
    radialModulation: true,
    modulationOffset: 0.35,
  });
  const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
  const microscope = new MicroscopeEffect();
  const noise = new NoiseEffect({ premultiply: true, blendFunction: BlendFunction.SCREEN });
  noise.blendMode.opacity.value = MICROSCOPE.grain;

  composer.addPass(new EffectPass(camera, ca, bloom, tone, noise));
  composer.addPass(new EffectPass(camera, microscope));

  return {
    composer,
    dof,
    bloom,
    microscope,
    ao,
    setFocusDistance(d) {
      dof.cocMaterial.focusDistance = d;
    },
    setSize(w, h) {
      composer.setSize(w, h);
    },
    setAO(enabled) {
      if (ao) ao.enabled = enabled;
    },
    render(dt) {
      composer.render(dt);
    },
  };
}
