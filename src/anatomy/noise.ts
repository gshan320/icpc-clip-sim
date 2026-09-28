import { createNoise3D, createNoise4D, type NoiseFunction3D, type NoiseFunction4D } from 'simplex-noise';

/** Deterministic PRNG (mulberry32) so the procedural anatomy is identical on every load. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function noise3(seed: number): NoiseFunction3D {
  return createNoise3D(mulberry32(seed));
}

export function noise4(seed: number): NoiseFunction4D {
  return createNoise4D(mulberry32(seed));
}

/** Fractal Brownian motion over a 3D noise function. Returns roughly -1 … 1. */
export function fbm3(n: NoiseFunction3D, x: number, y: number, z: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * n(x * freq, y * freq, z * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/**
 * Seamlessly tiling 2D fBm (u, v in 0…1) by sampling 4D noise on a torus.
 * `scale` controls feature size in tiles.
 */
export function tileFbm(n: NoiseFunction4D, u: number, v: number, scale: number, octaves = 4): number {
  const TAU = Math.PI * 2;
  let amp = 0.5;
  let freq = scale / TAU;
  let sum = 0;
  let norm = 0;
  const cu = Math.cos(u * TAU), su = Math.sin(u * TAU);
  const cv = Math.cos(v * TAU), sv = Math.sin(v * TAU);
  for (let i = 0; i < octaves; i++) {
    sum += amp * n(cu * freq, su * freq, cv * freq, sv * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}
