import * as THREE from 'three';
import { mulberry32, noise4, tileFbm } from './noise';

/**
 * Procedural tissue textures painted on canvases at start-up (no image assets needed).
 * Every texture tiles seamlessly: noise is sampled on a 4D torus and strokes are drawn 9 times
 * with wrap-around offsets.
 */

let maxAnisotropy = 8;
export function setMaxAnisotropy(v: number) {
  maxAnisotropy = v;
}

export interface TextureSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap?: THREE.Texture;
  alphaMap?: THREE.Texture;
}

function canvas(w: number, h = w): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  return [c, ctx];
}

function toTexture(c: HTMLCanvasElement, color: boolean): THREE.Texture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = maxAnisotropy;
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Fill a W×H float field with tiling fBm (computed at low res then bilinear-upsampled). */
function noiseField(w: number, h: number, seed: number, scale: number, octaves: number, lowRes = 4): Float32Array {
  const n = noise4(seed);
  const lw = Math.max(8, Math.floor(w / lowRes));
  const lh = Math.max(8, Math.floor(h / lowRes));
  const low = new Float32Array(lw * lh);
  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) low[y * lw + x] = tileFbm(n, x / lw, y / lh, scale, octaves);
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = (y / h) * lh;
    const y0 = Math.floor(fy) % lh, y1 = (y0 + 1) % lh, ty = fy - Math.floor(fy);
    for (let x = 0; x < w; x++) {
      const fx = (x / w) * lw;
      const x0 = Math.floor(fx) % lw, x1 = (x0 + 1) % lw, tx = fx - Math.floor(fx);
      const a = low[y0 * lw + x0] * (1 - tx) + low[y0 * lw + x1] * tx;
      const b = low[y1 * lw + x0] * (1 - tx) + low[y1 * lw + x1] * tx;
      out[y * w + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

/** Sobel height → tangent-space normal map. */
function heightToNormal(height: Float32Array, w: number, h: number, strength: number): HTMLCanvasElement {
  const [c, ctx] = canvas(w, h);
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const at = (x: number, y: number) => height[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * w + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      // Canvas y goes down, texture v goes up → flip green.
      d[i + 1] = (-ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Read one channel of a canvas as a float field in 0…1. */
function readField(ctx: CanvasRenderingContext2D, w: number, h: number): Float32Array {
  const d = ctx.getImageData(0, 0, w, h).data;
  const f = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) f[i] = d[i * 4] / 255;
  return f;
}

/** Draw a path 9 times so it wraps seamlessly across tile edges. */
function wrapStroke(ctx: CanvasRenderingContext2D, pts: number[], w: number, h: number) {
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      ctx.beginPath();
      ctx.moveTo(pts[0] + ox * w, pts[1] + oy * h);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] + ox * w, pts[i + 1] + oy * h);
      ctx.stroke();
    }
  }
}

interface WalkOpts {
  steps: number;
  step: number;
  curl: number;
  branchChance: number;
  width: number;
  minWidth: number;
  taper: number;
}

/** Branching random walk — looks like a pial capillary / arteriole network. */
function vascularWalk(rand: () => number, x: number, y: number, angle: number, o: WalkOpts, out: { pts: number[]; width: number }[], depth = 0) {
  const pts = [x, y];
  let w = o.width;
  let a = angle;
  for (let i = 0; i < o.steps; i++) {
    a += (rand() - 0.5) * o.curl;
    x += Math.cos(a) * o.step;
    y += Math.sin(a) * o.step;
    pts.push(x, y);
    if (depth < 4 && rand() < o.branchChance) {
      vascularWalk(rand, x, y, a + (rand() < 0.5 ? -1 : 1) * (0.5 + rand() * 0.7), { ...o, steps: Math.floor(o.steps * 0.6), width: w * 0.7 }, out, depth + 1);
    }
  }
  w = Math.max(o.minWidth, w);
  out.push({ pts, width: w });
}

// ---------------------------------------------------------------------------------------------

/** Cortex: pinkish pia-covered grey matter with a fine capillary network and wet sheen variation. */
export function makeCortexTextures(size = 1024): TextureSet {
  const rand = mulberry32(101);
  const mott = noiseField(size, size, 7, 6, 4);
  const fine = noiseField(size, size, 8, 28, 3, 2);

  // --- Albedo ---
  const [c, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const m = mott[i] * 0.5 + 0.5;
    const f = fine[i] * 0.5 + 0.5;
    // Base: warm pink-cream; mottling toward rosier patches.
    d[i * 4] = 206 + m * 26 + f * 8;
    d[i * 4 + 1] = 132 + m * 18 - (1 - f) * 10;
    d[i * 4 + 2] = 116 + m * 14 - (1 - f) * 8;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  // --- Height (for normal map): starts as fine noise ---
  const [, hctx] = canvas(size);
  const himg = hctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = 110 + fine[i] * 30 + mott[i] * 20;
    himg.data[i * 4] = himg.data[i * 4 + 1] = himg.data[i * 4 + 2] = v;
    himg.data[i * 4 + 3] = 255;
  }
  hctx.putImageData(himg, 0, 0);

  // Capillary network (thin, many) and a few arterioles / venules (thicker).
  const paths: { pts: number[]; width: number }[] = [];
  for (let k = 0; k < 70; k++) {
    vascularWalk(rand, rand() * size, rand() * size, rand() * Math.PI * 2, { steps: 60, step: 4, curl: 0.55, branchChance: 0.05, width: 1.4, minWidth: 0.6, taper: 0.9 }, paths);
  }
  ctx.lineCap = hctx.lineCap = 'round';
  ctx.lineJoin = hctx.lineJoin = 'round';
  for (const p of paths) {
    ctx.strokeStyle = `rgba(176, 44, 40, ${0.28 + rand() * 0.3})`;
    ctx.lineWidth = p.width;
    wrapStroke(ctx, p.pts, size, size);
    hctx.strokeStyle = 'rgba(255,255,255,0.1)';
    hctx.lineWidth = p.width + 0.8;
    wrapStroke(hctx, p.pts, size, size);
  }
  const big: { pts: number[]; width: number }[] = [];
  for (let k = 0; k < 7; k++) {
    vascularWalk(rand, rand() * size, rand() * size, rand() * Math.PI * 2, { steps: 90, step: 6, curl: 0.3, branchChance: 0.04, width: 3.6, minWidth: 1.2, taper: 0.9 }, big);
  }
  big.forEach((p, i) => {
    const venous = i % 3 === 0;
    ctx.strokeStyle = venous ? 'rgba(96, 36, 70, 0.55)' : 'rgba(168, 30, 30, 0.6)';
    ctx.lineWidth = p.width;
    wrapStroke(ctx, p.pts, size, size);
    // Specular-looking centre line on bigger vessels.
    ctx.strokeStyle = 'rgba(255, 190, 170, 0.12)';
    ctx.lineWidth = p.width * 0.3;
    wrapStroke(ctx, p.pts, size, size);
    hctx.strokeStyle = 'rgba(255,255,255,0.28)';
    hctx.lineWidth = p.width + 2.5;
    wrapStroke(hctx, p.pts, size, size);
  });

  const height = readField(hctx, size, size);
  const normal = heightToNormal(height, size, size, 1.5);

  // --- Roughness (G channel): wet film is uneven — glossy puddles and slightly drier areas ---
  const rsize = size / 2;
  const rn = noiseField(rsize, rsize, 9, 5, 3);
  const [rc, rctx] = canvas(rsize);
  const rimg = rctx.createImageData(rsize, rsize);
  for (let i = 0; i < rsize * rsize; i++) {
    const r = 0.3 + (rn[i] * 0.5 + 0.5) * 0.35;
    rimg.data[i * 4] = rimg.data[i * 4 + 1] = rimg.data[i * 4 + 2] = r * 255;
    rimg.data[i * 4 + 3] = 255;
  }
  rctx.putImageData(rimg, 0, 0);

  return { map: toTexture(c, true), normalMap: toTexture(normal, false), roughnessMap: toTexture(rc, false) };
}

/** Artery / vein wall: mostly uniform, with faint vasa vasorum and longitudinal texture. */
export function makeVesselTextures(): TextureSet {
  const w = 512, h = 256;
  const rand = mulberry32(202);
  const n = noiseField(w, h, 12, 5, 4, 2);
  const [c, ctx] = canvas(w, h);
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = n[i] * 0.5 + 0.5;
    // Greyscale-ish detail; the tint comes from material.color so arteries/veins share it.
    const g = 205 + v * 50;
    img.data[i * 4] = g;
    img.data[i * 4 + 1] = g - 6;
    img.data[i * 4 + 2] = g - 6;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const [, hctx] = canvas(w, h);
  hctx.fillStyle = 'rgb(128,128,128)';
  hctx.fillRect(0, 0, w, h);
  // Vasa vasorum: tiny wiggly vessels on the adventitia.
  const paths: { pts: number[]; width: number }[] = [];
  for (let k = 0; k < 22; k++) {
    vascularWalk(rand, rand() * w, rand() * h, (rand() - 0.5) * 0.8, { steps: 40, step: 4, curl: 0.6, branchChance: 0.04, width: 1.2, minWidth: 0.6, taper: 0.9 }, paths);
  }
  ctx.lineCap = 'round';
  for (const p of paths) {
    ctx.strokeStyle = `rgba(120, 20, 24, ${0.25 + rand() * 0.25})`;
    ctx.lineWidth = p.width;
    wrapStroke(ctx, p.pts, w, h);
    hctx.strokeStyle = 'rgba(255,255,255,0.5)';
    hctx.lineWidth = p.width + 0.5;
    wrapStroke(hctx, p.pts, w, h);
  }
  // Longitudinal adventitial fibres.
  hctx.lineWidth = 1;
  for (let k = 0; k < 90; k++) {
    const y = rand() * h;
    hctx.strokeStyle = `rgba(${rand() < 0.5 ? '255,255,255' : '0,0,0'},0.08)`;
    wrapStroke(hctx, [0, y, w * 0.5, y + (rand() - 0.5) * 6, w, y], w, h);
  }
  const height = readField(hctx, w, h);
  return { map: toTexture(c, true), normalMap: toTexture(heightToNormal(height, w, h, 1.4), false) };
}

/** Cranial nerve: ivory with longitudinal fascicles and a few fine pial vessels. */
export function makeNerveTextures(): TextureSet {
  const w = 512, h = 256;
  const rand = mulberry32(303);
  const n = noiseField(w, h, 14, 4, 3, 2);
  const [c, ctx] = canvas(w, h);
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = n[i] * 0.5 + 0.5;
    img.data[i * 4] = 232 + v * 18;
    img.data[i * 4 + 1] = 214 + v * 16;
    img.data[i * 4 + 2] = 186 + v * 14;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const [, hctx] = canvas(w, h);
  hctx.fillStyle = 'rgb(128,128,128)';
  hctx.fillRect(0, 0, w, h);
  // Fascicles run along the nerve (texture u direction).
  for (let k = 0; k < 70; k++) {
    const y = (k / 70) * h + rand() * 2;
    const lw = 1.5 + rand() * 2.5;
    hctx.lineWidth = lw;
    hctx.strokeStyle = 'rgba(255,255,255,0.18)';
    wrapStroke(hctx, [0, y, w * 0.33, y + (rand() - 0.5) * 3, w * 0.66, y + (rand() - 0.5) * 3, w, y], w, h);
    ctx.lineWidth = 0.7;
    ctx.strokeStyle = 'rgba(170, 140, 110, 0.1)';
    wrapStroke(ctx, [0, y + lw, w, y + lw], w, h);
  }
  // Pial vessels on the nerve sheath.
  const paths: { pts: number[]; width: number }[] = [];
  for (let k = 0; k < 12; k++) {
    vascularWalk(rand, rand() * w, rand() * h, rand() * Math.PI * 2, { steps: 50, step: 5, curl: 0.4, branchChance: 0.05, width: 1.6, minWidth: 0.7, taper: 0.9 }, paths);
  }
  for (const p of paths) {
    ctx.strokeStyle = 'rgba(180, 50, 45, 0.45)';
    ctx.lineWidth = p.width;
    wrapStroke(ctx, p.pts, w, h);
  }
  const height = readField(hctx, w, h);
  return { map: toTexture(c, true), normalMap: toTexture(heightToNormal(height, w, h, 1.6), false) };
}

/** Arachnoid: a gossamer web of collagen trabeculae over a very faint film. */
export function makeArachnoidTextures(size = 1024): TextureSet {
  const rand = mulberry32(404);
  const film = noiseField(size, size, 15, 5, 3, 4);
  const [c, ctx] = canvas(size);
  // Alpha lives in the green channel (three.js alphaMap convention).
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const a = 6 + (film[i] * 0.5 + 0.5) * 22;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = a;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.lineCap = 'round';
  for (let k = 0; k < 380; k++) {
    const x = rand() * size, y = rand() * size;
    const a = rand() * Math.PI;
    const len = 60 + rand() * 260;
    const bend = (rand() - 0.5) * 60;
    const mx = x + Math.cos(a) * len * 0.5 + Math.cos(a + Math.PI / 2) * bend;
    const my = y + Math.sin(a) * len * 0.5 + Math.sin(a + Math.PI / 2) * bend;
    const ex = x + Math.cos(a) * len, ey = y + Math.sin(a) * len;
    const v = 110 + rand() * 120;
    ctx.strokeStyle = `rgba(${v},${v},${v},${0.1 + rand() * 0.35})`;
    ctx.lineWidth = 0.4 + rand() * 1.1;
    const pts: number[] = [];
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const it = 1 - t;
      pts.push(it * it * x + 2 * it * t * mx + t * t * ex, it * it * y + 2 * it * t * my + t * t * ey);
    }
    wrapStroke(ctx, pts, size, size);
  }
  const alpha = toTexture(c, false);
  const height = readField(ctx, size, size);
  const normal = heightToNormal(height, size, size, 1.2);
  const [mc, mctx] = canvas(8);
  mctx.fillStyle = 'rgb(235,240,245)';
  mctx.fillRect(0, 0, 8, 8);
  return { map: toTexture(mc, true), normalMap: toTexture(normal, false), alphaMap: alpha };
}

/** Bone (anterior clinoid): off-white with porous speckle. */
export function makeBoneTextures(): TextureSet {
  const s = 512;
  const n = noiseField(s, s, 16, 8, 4, 2);
  const rand = mulberry32(505);
  const [c, ctx] = canvas(s);
  const img = ctx.createImageData(s, s);
  const hf = new Float32Array(s * s);
  for (let i = 0; i < s * s; i++) {
    const v = n[i] * 0.5 + 0.5;
    const pore = rand() < 0.012 ? 0.55 : 1;
    img.data[i * 4] = (214 + v * 30) * pore;
    img.data[i * 4 + 1] = (196 + v * 26) * pore;
    img.data[i * 4 + 2] = (160 + v * 22) * pore;
    img.data[i * 4 + 3] = 255;
    hf[i] = v * 0.6 + (pore < 1 ? -0.4 : 0);
  }
  ctx.putImageData(img, 0, 0);
  return { map: toTexture(c, true), normalMap: toTexture(heightToNormal(hf, s, s, 3), false) };
}

/** Deep cistern membranes / dura: dark, fibrous, glistening. */
export function makeMembraneTextures(): TextureSet {
  const s = 512;
  const n = noiseField(s, s, 17, 4, 4, 2);
  const rand = mulberry32(606);
  const [c, ctx] = canvas(s);
  const img = ctx.createImageData(s, s);
  for (let i = 0; i < s * s; i++) {
    const v = n[i] * 0.5 + 0.5;
    img.data[i * 4] = 120 + v * 60;
    img.data[i * 4 + 1] = 84 + v * 40;
    img.data[i * 4 + 2] = 78 + v * 34;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const [, hctx] = canvas(s);
  hctx.fillStyle = 'rgb(128,128,128)';
  hctx.fillRect(0, 0, s, s);
  for (let k = 0; k < 160; k++) {
    const x = rand() * s, y = rand() * s, a = rand() * Math.PI, len = 40 + rand() * 160;
    hctx.strokeStyle = 'rgba(255,255,255,0.3)';
    hctx.lineWidth = 1 + rand() * 2;
    wrapStroke(hctx, [x, y, x + Math.cos(a) * len, y + Math.sin(a) * len], s, s);
    ctx.strokeStyle = 'rgba(230, 200, 190, 0.08)';
    ctx.lineWidth = 1;
    wrapStroke(ctx, [x, y, x + Math.cos(a) * len, y + Math.sin(a) * len], s, s);
  }
  const paths: { pts: number[]; width: number }[] = [];
  for (let k = 0; k < 8; k++) {
    vascularWalk(rand, rand() * s, rand() * s, rand() * Math.PI * 2, { steps: 40, step: 5, curl: 0.5, branchChance: 0.06, width: 2, minWidth: 0.8, taper: 0.9 }, paths);
  }
  for (const p of paths) {
    ctx.strokeStyle = 'rgba(150, 30, 30, 0.5)';
    ctx.lineWidth = p.width;
    wrapStroke(ctx, p.pts, s, s);
  }
  const height = readField(hctx, s, s);
  return { map: toTexture(c, true), normalMap: toTexture(heightToNormal(height, s, s, 1.5), false) };
}
