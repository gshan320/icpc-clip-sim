import * as THREE from 'three';
import { mulberry32, noise4, tileFbm } from '../anatomy/noise';

/**
 * The surface of blood pooled in the depth of the field.
 *
 *  - A dense plane perpendicular to gravity; where it lies above the anatomy, it is blood.
 *  - Thickness shading from the depth prepass: thin films are translucent bright crimson, deep
 *    blood dark and opaque, and the waterline fades softly onto tissue.
 *  - The surface moves: the suction tip pulls a dimple with capillary ripples, falling drops
 *    send out rings, and a bleeder under the surface keeps it welling.
 *  - Froth: small bubbles ride the surface and spiral into the suction tip.
 */
const MAX_RIPPLES = 8;
const MAX_BUBBLES = 160;
/** Radius (mm) of the clear window that sustained suction holds open. */
export const CRATER_R = 4.5;

const VERT_HEADER = /* glsl */ `
// Two suction slots (a parked suction + the one in hand): xy = centre, z = strength, w = window depth.
uniform vec4 uSuckA;
uniform vec4 uSuckB;
uniform vec4 uRipples[${MAX_RIPPLES}];
uniform float uPoolTime;
varying vec2 vPoolLocal;
float suckH(vec2 p, vec4 S) {
  float h = 0.0;
  float r = length(p - S.xy);
  if (S.z > 0.001) {
    // Funnel under the tip, a raised lip around it, and fast capillary ripples.
    h += -S.z * 1.3 * exp(-r * r / 2.6) + S.z * 0.2 * exp(-pow((r - 2.4) / 1.0, 2.0));
    h += S.z * 0.06 * sin(r * 3.6 - uPoolTime * 18.0) * exp(-r / 3.0);
  }
  // Sustained suction holds a clear window open down to the tissue.
  if (S.w > 0.01) h -= S.w * exp(-pow(r / ${CRATER_R.toFixed(1)}, 4.0));
  return h;
}
float poolH(vec2 p) {
  float h = suckH(p, uSuckA) + suckH(p, uSuckB);
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    vec4 R = uRipples[i];
    float age = uPoolTime - R.z;
    if (R.w > 0.0 && age > 0.0 && age < 2.2) {
      float r = length(p - R.xy);
      float front = age * 6.5;
      h += R.w * exp(-age * 1.8) * sin((r - front) * 2.6) * exp(-pow((r - front) / 1.7, 2.0));
    }
  }
  return h;
}
`;

const FRAG_HEADER = /* glsl */ `
uniform sampler2D uSceneDepth;
uniform vec2 uDrawRes;
uniform float uCamNear;
uniform float uCamFar;
uniform float uDepthValid;
uniform vec3 uThin;
uniform vec3 uThick;
uniform float uRadius;
varying vec2 vPoolLocal;
`;

function rippleNormalTexture(): THREE.Texture {
  const s = 256;
  const n = noise4(909);
  const h = new Float32Array(s * s);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) h[y * s + x] = tileFbm(n, x / s, y / s, 4, 3);
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(s, s);
  const v = new THREE.Vector3();
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx = h[y * s + ((x + 1) % s)] - h[y * s + ((x - 1 + s) % s)];
      const dy = h[((y + 1) % s) * s + x] - h[((y - 1 + s) % s) * s + x];
      v.set(-dx * 3, -dy * 3, 1).normalize();
      const i = (y * s + x) * 4;
      img.data[i] = (v.x * 0.5 + 0.5) * 255;
      img.data[i + 1] = (v.y * 0.5 + 0.5) * 255;
      img.data[i + 2] = (v.z * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(9, 9);
  return t;
}

export class BloodPool {
  readonly mesh: THREE.Mesh;
  private time = 0;
  private rippleHead = 0;
  /** Two suction slots (surface-local). */
  private slots = [0, 1].map(() => ({ x: 0, y: 0, strength: 0, target: 0, crater: 0, used: false, seen: 0 }));
  private bubbleAcc = 0;
  private rand = mulberry32(777);
  private tmp = new THREE.Vector3();
  private readonly u = {
    uSuckA: { value: new THREE.Vector4() },
    uSuckB: { value: new THREE.Vector4() },
    uRipples: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, -99, 0)) },
    uPoolTime: { value: 0 },
    uSceneDepth: { value: null as THREE.Texture | null },
    uDrawRes: { value: new THREE.Vector2(1, 1) },
    uCamNear: { value: 1 },
    uCamFar: { value: 1000 },
    uDepthValid: { value: 0 },
    // Linear-space colours: thin film vs. deep pool.
    uThin: { value: new THREE.Color(0x7a0a10) },
    uThick: { value: new THREE.Color(0x3c0306) },
    uRadius: { value: 1 },
  };

  // Bubbles (local xy on the surface).
  private bubbles: THREE.InstancedMesh;
  private bPos = new Float32Array(MAX_BUBBLES * 2);
  private bVel = new Float32Array(MAX_BUBBLES * 2);
  private bLife = new Float32Array(MAX_BUBBLES);
  private bSize = new Float32Array(MAX_BUBBLES);
  private bCount = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();

  constructor(radius: number, up: THREE.Vector3) {
    const geom = new THREE.PlaneGeometry(radius * 2, radius * 2, 220, 220);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.16,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      normalMap: rippleNormalTexture(),
      normalScale: new THREE.Vector2(0.35, 0.35),
      sheen: 0.6,
      sheenColor: new THREE.Color(0xff2418),
      sheenRoughness: 0.35,
      transparent: true,
      opacity: 0.97,
      envMapIntensity: 1.6,
    });
    this.u.uRadius.value = radius;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.u);
      shader.vertexShader = VERT_HEADER + shader.vertexShader
        .replace(
          '#include <beginnormal_vertex>',
          `float pH0 = poolH(position.xy);
          float pHx = poolH(position.xy + vec2(0.15, 0.0));
          float pHy = poolH(position.xy + vec2(0.0, 0.15));
          vec3 objectNormal = normalize(vec3(-(pHx - pH0) / 0.15, -(pHy - pH0) / 0.15, 1.0));
          #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
          #endif
          vPoolLocal = position.xy;`,
        )
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.z += pH0;');
      shader.fragmentShader = FRAG_HEADER + shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float thick = 3.0;
        if (uDepthValid > 0.5) {
          float sd = texture2D(uSceneDepth, gl_FragCoord.xy / uDrawRes).x;
          // Depth-buffer value → distance along the view axis (perspective projection).
          float sceneZ = (uCamNear * uCamFar) / (uCamFar - (uCamFar - uCamNear) * sd);
          thick = max(sceneZ - vViewPosition.z, 0.0);
        }
        diffuseColor.rgb = mix(uThin, uThick, smoothstep(0.0, 2.4, thick));
        float edge = 1.0 - smoothstep(uRadius * 0.82, uRadius, length(vPoolLocal));
        diffuseColor.a = clamp((1.0 - exp(-thick * 4.0)) * 1.1, 0.0, 1.0) * opacity * edge;`,
      );
    };
    mat.customProgramCacheKey = () => 'blood-pool';
    this.mesh = new THREE.Mesh(geom, mat);
    this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), up);
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.userData = { kind: 'blood', id: 'pool', label: 'Blood in the field' };

    const bubbleMat = new THREE.MeshPhysicalMaterial({
      color: 0x5a060a,
      roughness: 0.04,
      clearcoat: 1,
      clearcoatRoughness: 0.01,
      envMapIntensity: 2,
      sheen: 0.6,
      sheenColor: new THREE.Color(0xff5030),
      transparent: true,
      opacity: 0.85,
    });
    this.bubbles = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), bubbleMat, MAX_BUBBLES);
    this.bubbles.count = 0;
    this.bubbles.frustumCulled = false;
    this.mesh.add(this.bubbles);
  }

  /** Surface-local 2D coordinates of a world point. */
  toLocal(world: THREE.Vector3): THREE.Vector2 {
    this.mesh.updateMatrixWorld();
    const l = this.mesh.worldToLocal(this.tmp.copy(world));
    return new THREE.Vector2(l.x, l.y);
  }

  /** Concentric ring from an impact (drop landing, welling bleeder). */
  addRipple(world: THREE.Vector3, amp: number) {
    const l = this.toLocal(world);
    this.u.uRipples.value[this.rippleHead].set(l.x, l.y, this.time, amp);
    this.rippleHead = (this.rippleHead + 1) % MAX_RIPPLES;
  }

  /** Is this surface-local point inside a clear window held open by suction? */
  inWindow(local: THREE.Vector2): boolean {
    return this.slots.some((sl) => sl.crater > 1 && Math.hypot(local.x - sl.x, local.y - sl.y) < CRATER_R * 0.85);
  }

  /** Surface height offset (mm) at a local point from the suction funnels (mirrors the shader). */
  private suctionHeight(x: number, y: number): number {
    let h = 0;
    for (const sl of this.slots) {
      const r = Math.hypot(x - sl.x, y - sl.y);
      if (sl.strength > 0.001) h += -sl.strength * 1.3 * Math.exp((-r * r) / 2.6) + sl.strength * 0.2 * Math.exp(-(((r - 2.4) / 1.0) ** 2));
      if (sl.crater > 0.01) h -= sl.crater * Math.exp(-((r / CRATER_R) ** 4));
    }
    return h;
  }

  /**
   * Suction at the surface this frame (world point where the instrument meets the blood);
   * strength 0…1. Up to two suctions are tracked independently.
   */
  suction(world: THREE.Vector3, strength: number, dt: number) {
    const l = this.toLocal(world);
    // Same slot if close to one already in use, else the least recently used one.
    let slot = this.slots.find((sl) => (sl.strength > 0.01 || sl.crater > 0.1) && Math.hypot(sl.x - l.x, sl.y - l.y) < 4);
    if (!slot) slot = this.slots.reduce((a, b) => (a.seen <= b.seen ? a : b));
    if (Math.hypot(slot.x - l.x, slot.y - l.y) > 4) slot.crater = 0; // moved far: the old window refills
    slot.x += (l.x - slot.x) * Math.min(1, dt * 20);
    slot.y += (l.y - slot.y) * Math.min(1, dt * 20);
    if (slot.strength < 0.01 && slot.crater < 0.1) {
      slot.x = l.x;
      slot.y = l.y;
    }
    slot.target = Math.max(slot.target, strength);
    slot.used = true;
    slot.seen = this.time;
    // Froth is drawn in from around the tip.
    this.bubbleAcc += strength * 38 * dt;
    for (; this.bubbleAcc >= 1 && this.bCount < MAX_BUBBLES; this.bubbleAcc--) {
      const a = this.rand() * Math.PI * 2;
      const r = 1.2 + this.rand() * 3.2;
      this.spawnBubble(l.x + Math.cos(a) * r, l.y + Math.sin(a) * r, 0.04 + this.rand() * 0.07);
    }
  }

  /** Bubbles welling up from a submerged bleeder. */
  froth(world: THREE.Vector3, n: number) {
    const l = this.toLocal(world);
    for (let k = 0; k < n && this.bCount < MAX_BUBBLES; k++) {
      this.spawnBubble(l.x + (this.rand() - 0.5) * 1.2, l.y + (this.rand() - 0.5) * 1.2, 0.05 + this.rand() * 0.08);
    }
  }

  private spawnBubble(x: number, y: number, size: number) {
    const i = this.bCount++;
    this.bPos[i * 2] = x;
    this.bPos[i * 2 + 1] = y;
    this.bVel[i * 2] = (this.rand() - 0.5) * 0.6;
    this.bVel[i * 2 + 1] = (this.rand() - 0.5) * 0.6;
    this.bLife[i] = 0.8 + this.rand() * 1.2;
    this.bSize[i] = size;
  }

  private removeBubble(i: number) {
    const last = --this.bCount;
    if (i === last) return;
    this.bPos[i * 2] = this.bPos[last * 2];
    this.bPos[i * 2 + 1] = this.bPos[last * 2 + 1];
    this.bVel[i * 2] = this.bVel[last * 2];
    this.bVel[i * 2 + 1] = this.bVel[last * 2 + 1];
    this.bLife[i] = this.bLife[last];
    this.bSize[i] = this.bSize[last];
  }

  setDepth(tex: THREE.Texture | null, drawW: number, drawH: number, camera: THREE.PerspectiveCamera) {
    this.u.uSceneDepth.value = tex;
    this.u.uDepthValid.value = tex ? 1 : 0;
    this.u.uDrawRes.value.set(drawW, drawH);
    this.u.uCamNear.value = camera.near;
    this.u.uCamFar.value = camera.far;
  }

  update(dt: number, flowBoost: number) {
    this.time += dt;
    this.u.uPoolTime.value = this.time;
    // Suction strength eases in and out so the funnel forms and relaxes smoothly; the window
    // deepens while suction is held in the blood and refills when it stops.
    this.slots.forEach((sl, i) => {
      sl.strength += (sl.target - sl.strength) * (1 - Math.exp(-dt * (sl.target > sl.strength ? 10 : 4)));
      sl.crater = sl.used ? Math.min(16, sl.crater + dt * 10) : Math.max(0, sl.crater - dt * 7);
      sl.target = 0;
      sl.used = false;
      (i === 0 ? this.u.uSuckA : this.u.uSuckB).value.set(sl.x, sl.y, sl.strength, sl.crater);
    });
    const nm = (this.mesh.material as THREE.MeshPhysicalMaterial).normalMap!;
    nm.offset.x += dt * 0.012;
    nm.offset.y += dt * 0.007 * (1 + flowBoost * 20);

    // Bubbles: drift, spiral into the nearest suction funnel, pop.
    for (let i = this.bCount - 1; i >= 0; i--) {
      let x = this.bPos[i * 2], y = this.bPos[i * 2 + 1];
      let vx = this.bVel[i * 2], vy = this.bVel[i * 2 + 1];
      let sink = false;
      for (const sl of this.slots) {
        if (sl.strength < 0.05) continue;
        const dx = sl.x - x, dy = sl.y - y;
        const r = Math.hypot(dx, dy) + 1e-3;
        if (r > 8) continue;
        const pull = (sl.strength * 22) / (r + 0.8);
        // Radial inflow plus a swirl — the vortex around a suction tip.
        vx += ((dx / r) * pull - (dy / r) * pull * 0.55) * dt * 6;
        vy += ((dy / r) * pull + (dx / r) * pull * 0.55) * dt * 6;
        if (r < 0.55) sink = true;
      }
      if (sink) {
        this.removeBubble(i);
        continue;
      }
      const drag = Math.exp(-dt * 3);
      vx *= drag;
      vy *= drag;
      x += vx * dt;
      y += vy * dt;
      this.bPos[i * 2] = x;
      this.bPos[i * 2 + 1] = y;
      this.bVel[i * 2] = vx;
      this.bVel[i * 2 + 1] = vy;
      this.bLife[i] -= dt;
      if (this.bLife[i] <= 0) this.removeBubble(i);
    }
    for (let i = 0; i < this.bCount; i++) {
      const x = this.bPos[i * 2], y = this.bPos[i * 2 + 1];
      // Ride the (displaced) surface, so froth follows the funnel and window down.
      const h = this.suctionHeight(x, y);
      const size = this.bSize[i] * Math.min(1, this.bLife[i] * 3);
      this.m.compose(this.s.set(x, y, h + size * 0.35), this.q, new THREE.Vector3(size, size, size * 0.7));
      this.bubbles.setMatrixAt(i, this.m);
    }
    this.bubbles.count = this.bCount;
    this.bubbles.instanceMatrix.needsUpdate = true;
  }
}
