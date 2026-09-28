import gsap from 'gsap';
import * as THREE from 'three';
import { mulberry32 } from '../anatomy/noise';
import { audio } from '../audio/engine';
import { events } from '../state/events';
import { state } from '../state/store';
import { ArterialJet } from './bloodJet';
import { BloodPool } from './bloodPool';
import { RivuletSystem, type Rivulet } from './bloodRivulets';
import { cardiac } from './cardiac';

/**
 * Blood in the surgical field — modelled after how it actually behaves at this scale:
 *
 *  - ARTERIAL injury: a pulsatile jet leaves the hole at arterial speed (nearly straight at this
 *    scale), hits tissue and splashes; a little also wells out of the hole and runs down the
 *    vessel wall. The suction tip can intercept the jet.
 *  - VENOUS / PIAL / CAPILLARY oozing: a welling bead at the source feeding a rivulet.
 *  - RIVULETS run downhill over the real surface, drip off overhangs and restart where the drop
 *    lands, then clot and darken when the source stops (see RivuletSystem).
 *  - SPLASH droplets fly under gravity and leave small flat stains.
 *  - The POOL collects in the depth and rises with the volume in the field (see BloodPool).
 *  - SUCTION removes everything near its tip: pooled blood, films, stains, droplets, and the jet.
 *
 * Gravity: patient supine with the head turned left — "down" is mostly into the depth of the
 * field (-Z) and slightly toward the temporal side.
 */
export const GRAVITY = new THREE.Vector3(0.06, -0.3, -0.95).normalize();
const UP = GRAVITY.clone().negate();
/** Gravity used for free droplets (mm/s²) — real is 9800; slightly less keeps splashes readable. */
const DROP_G = 5200;

export type BleedKind = 'ooze' | 'arterial';

export interface Ooze {
  id: number;
  kind: BleedKind;
  label: string;
  /** Welling bead rendered at the bleeding point (child of the tissue it sits on). */
  blob: THREE.Mesh;
  /** World-space surface normal at creation (kept for API compatibility). */
  normal: THREE.Vector3;
  /** Surface normal in the parent's space (follows moving lobes). */
  normalLocal: THREE.Vector3;
  /** Current rate (mL/s) = baseRate × flow in the injured vessel × pressure. */
  rate: number;
  /** Rate at normal flow and pressure (mL/s). */
  baseRate: number;
  /** Injured vessel (for flow-dependent bleeding), if any. */
  vesselId?: string;
  /** Small bleeders can be coagulated; a ruptured aneurysm cannot. */
  coagulable: boolean;
  active: boolean;
  /** Coagulation progress 0…1 (bipolar). */
  coag: number;
  /** Capillary oozes slow down with time (tamponade, clotting). */
  selfLimiting: boolean;
  jet?: ArterialJet;
  sourceRiv?: Rivulet;
  impactRiv?: Rivulet;
  impactAt?: THREE.Vector3;
  impactWait?: number;
  restart: number;
  sprayAcc: number;
  wellAcc: number;
}

const MAX_PARTICLES = 500;
const MAX_STAINS = 400;
const POOL = {
  origin: new THREE.Vector3(6, -3, 0),
  /** Level (mm along "up") with no blood — just below the deep cistern floor. */
  emptyLevel: -15.8,
  /** Level when the field is completely flooded. */
  fullLevel: 13,
  /** Effective area (mm²) of the corridor floor for volume → level. */
  area: 700,
  radius: 38,
};

interface Stain {
  parent: THREE.Object3D;
  local: THREE.Vector3;
  normalLocal: THREE.Vector3;
  size: number;
  grow: number;
  alive: boolean;
  /** Smear along the suction stroke (0…1) and its direction (parent-local). */
  smear: number;
  smearDir: THREE.Vector3;
}

function softDotTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class BloodSystem {
  readonly group = new THREE.Group();
  readonly pool: THREE.Mesh;
  readonly surface: BloodPool;
  readonly rivulets: RivuletSystem;
  readonly oozes: Ooze[] = [];
  /** Pooled blood volume in the field (mL). */
  volume = 0;
  private level = POOL.emptyLevel;
  private nextId = 1;
  private rand = mulberry32(4242);
  private rippleAcc = 0;
  private meniscus: THREE.Mesh;
  private meniscusAmt = 0;
  private suctionTip = new THREE.Vector3();
  private suctionActive = false;
  /** Microscope camera: the suction funnel sits where the line of sight to the tip meets the blood. */
  camera: THREE.Camera | null = null;
  /** Suction parked by the left hand (keeps aspirating while other tools are used). */
  parked: THREE.Vector3 | null = null;
  /** Aspiration intensity of the parked suction this frame (for the sound). */
  parkedDrawn = 0;
  private wasParked = false;
  private raycaster = new THREE.Raycaster();
  private jetMat: THREE.MeshPhysicalMaterial;

  // Droplets (splash, drips).
  private particles: THREE.InstancedMesh;
  private pPos = new Float32Array(MAX_PARTICLES * 3);
  private pVel = new Float32Array(MAX_PARTICLES * 3);
  private pRad = new Float32Array(MAX_PARTICLES);
  /** >0: the drop comes off a rivulet and starts a new one where it lands. */
  private pFlow = new Float32Array(MAX_PARTICLES);
  private pSrc = new Int32Array(MAX_PARTICLES);
  private pCount = 0;

  // Stains.
  private stains: Stain[] = [];
  private stainMesh: THREE.InstancedMesh;

  // Steam from coagulation.
  private steam: THREE.Points;
  private sPos: Float32Array;
  private sCol: Float32Array;
  private sVel: Float32Array;
  private sLife: Float32Array;
  private sHead = 0;

  private blobGeom = new THREE.SphereGeometry(1, 20, 14);
  private oozeMat: THREE.MeshPhysicalMaterial;
  private charMat: THREE.MeshPhysicalMaterial;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private v3 = new THREE.Vector3();
  private s = new THREE.Vector3();
  private zAxis = new THREE.Vector3(0, 0, 1);
  private tissueCache: THREE.Object3D[] = [];

  constructor(private solids: () => THREE.Object3D[]) {
    this.group.name = 'blood';
    (this.raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;

    const bloodMat = new THREE.MeshPhysicalMaterial({
      color: 0x7a080d,
      roughness: 0.1,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      sheen: 0.4,
      sheenColor: new THREE.Color(0xff3020),
      envMapIntensity: 1.2,
    });
    this.particles = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), bloodMat, MAX_PARTICLES);
    this.particles.count = 0;
    this.particles.frustumCulled = false;
    this.group.add(this.particles);

    // Arterial blood is bright (oxygenated); the jet is a little lighter than pooled blood.
    this.jetMat = new THREE.MeshPhysicalMaterial({
      color: 0xa50e15,
      roughness: 0.08,
      clearcoat: 1,
      clearcoatRoughness: 0.02,
      sheen: 0.6,
      sheenColor: new THREE.Color(0xff4a30),
      envMapIntensity: 1.4,
    });

    // Flat splash stain: a closed, flattened drop (+Z = surface normal), shaded with the surface
    // normal so it reads as a thin wet film from any angle.
    const stainGeom = new THREE.SphereGeometry(1, 18, 10);
    const stainMat = new THREE.MeshPhysicalMaterial({
      color: 0x86090f,
      roughness: 0.18,
      clearcoat: 1,
      clearcoatRoughness: 0.04,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      envMapIntensity: 1,
    });
    stainMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        objectNormal = normalize(mix(vec3(0.0, 0.0, sign(objectNormal.z + 1e-4)), objectNormal, 0.3));`,
      );
    };
    this.stainMesh = new THREE.InstancedMesh(stainGeom, stainMat, MAX_STAINS);
    this.stainMesh.count = 0;
    this.stainMesh.frustumCulled = false;
    this.group.add(this.stainMesh);

    // Rivulets running over tissue.
    this.rivulets = new RivuletSystem({
      gravity: GRAVITY,
      raycast: (o, d, far) => this.cast(o, d, far),
      submerged: (p) => this.submerged(p, -0.15),
      drip: (pos, vel, src, flow) => this.spawnAt(pos, vel, 0.16 + Math.min(0.2, flow * 0.6), flow, src),
      sourceRate: (id) => {
        const o = this.oozeById(id);
        return o && o.active ? o.rate : 0;
      },
    });
    this.group.add(this.rivulets.mesh);

    // Pool surface.
    this.surface = new BloodPool(POOL.radius, UP);
    this.pool = this.surface.mesh;
    this.group.add(this.pool);

    this.meniscus = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), bloodMat);
    this.meniscus.visible = false;
    this.meniscus.quaternion.setFromUnitVectors(this.zAxis, UP);
    this.group.add(this.meniscus);

    this.oozeMat = new THREE.MeshPhysicalMaterial({
      color: 0x8a0a10,
      roughness: 0.06,
      clearcoat: 1,
      clearcoatRoughness: 0.02,
      sheen: 0.6,
      sheenColor: new THREE.Color(0xff2a20),
      envMapIntensity: 1.3,
    });
    this.charMat = new THREE.MeshPhysicalMaterial({ color: 0x2a140c, roughness: 0.75, clearcoat: 0.3 });

    // Steam puffs.
    const N = 160;
    this.sPos = new Float32Array(N * 3).fill(1e4);
    this.sCol = new Float32Array(N * 4);
    this.sVel = new Float32Array(N * 3);
    this.sLife = new Float32Array(N);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(this.sPos, 3));
    sg.setAttribute('color', new THREE.BufferAttribute(this.sCol, 4));
    this.steam = new THREE.Points(
      sg,
      new THREE.PointsMaterial({ size: 1.6, map: softDotTexture(), vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true }),
    );
    this.steam.frustumCulled = false;
    this.steam.renderOrder = 3;
    this.group.add(this.steam);
  }

  // ------------------------------------------------------------------------------ queries

  /** Current pool level (mm along "up"). */
  get poolLevel() {
    return this.level;
  }

  /** Height of a world point along "up", comparable to poolLevel. */
  heightOf(p: THREE.Vector3): number {
    return this.v3.copy(p).sub(POOL.origin).dot(UP);
  }

  /** Is this point under the blood surface? */
  submerged(p: THREE.Vector3, margin = 0): boolean {
    return this.volume > 0.02 && this.heightOf(p) < this.level + margin;
  }

  /** Tissue meshes blood can run over (no instruments). */
  private tissue(): THREE.Object3D[] {
    const all = this.solids();
    if (this.tissueCache.length === 0 || this.tissueCache.length > all.length) {
      this.tissueCache = all.filter((o) => o.userData.kind !== 'instrument');
    }
    return this.tissueCache;
  }

  private cast(origin: THREE.Vector3, dir: THREE.Vector3, far: number): THREE.Intersection | null {
    this.raycaster.set(origin, dir);
    this.raycaster.near = 0;
    this.raycaster.far = far;
    const hits = this.raycaster.intersectObjects(this.tissue(), false);
    for (const h of hits) if (isShown(h.object)) return h;
    return null;
  }

  private castSegment(a: THREE.Vector3, b: THREE.Vector3): THREE.Intersection | null {
    this.s.subVectors(b, a);
    const len = this.s.length();
    if (len < 1e-6) return null;
    return this.cast(a, this.s.multiplyScalar(1 / len), len);
  }

  // ------------------------------------------------------------------------------ bleeding

  /** Scales bleeding by flow and pressure (set by the app from the flow and vitals models). */
  rateModifier: (o: Ooze) => number = () => 1;

  addOoze(opts: {
    object: THREE.Object3D;
    point: THREE.Vector3;
    normal: THREE.Vector3;
    kind: BleedKind;
    rate: number;
    label: string;
    selfLimiting?: boolean;
    vesselId?: string;
    coagulable?: boolean;
  }): Ooze {
    const blob = new THREE.Mesh(this.blobGeom, this.oozeMat);
    blob.userData = { kind: 'bleeding', id: `ooze-${this.nextId}`, label: opts.label };
    blob.scale.setScalar(0.01);
    opts.object.add(blob);
    const n = opts.normal.clone().normalize();
    blob.position.copy(opts.object.worldToLocal(opts.point.clone().addScaledVector(n, 0.04)));
    const parentQ = opts.object.getWorldQuaternion(new THREE.Quaternion());
    const invQ = parentQ.clone().invert();
    const worldQ = new THREE.Quaternion().setFromUnitVectors(this.zAxis, n);
    blob.quaternion.copy(invQ.clone().multiply(worldQ));
    const ooze: Ooze = {
      id: this.nextId++,
      kind: opts.kind,
      label: opts.label,
      blob,
      normal: n.clone(),
      normalLocal: n.clone().applyQuaternion(invQ),
      rate: opts.rate,
      baseRate: opts.rate,
      vesselId: opts.vesselId,
      coagulable: opts.coagulable ?? true,
      active: true,
      coag: 0,
      selfLimiting: opts.selfLimiting ?? opts.kind === 'ooze',
      restart: 0,
      sprayAcc: 0,
      wellAcc: 0,
    };
    blob.userData.oozeId = ooze.id;
    if (ooze.kind === 'arterial') {
      ooze.jet = new ArterialJet(this.jetMat);
      this.group.add(ooze.jet.mesh);
    }
    this.oozes.push(ooze);
    events.emit('bleeding:started', { id: ooze.id, kind: ooze.kind, label: ooze.label });
    return ooze;
  }

  oozeById(id: number): Ooze | undefined {
    return this.oozes.find((o) => o.id === id);
  }

  /** Nearest active bleeding point to `p` within `radius` mm. */
  nearestActiveOoze(p: THREE.Vector3, radius: number, coagulableOnly = false): Ooze | null {
    let best: Ooze | null = null;
    let bd = radius;
    for (const o of this.oozes) {
      if (!o.active || (coagulableOnly && !o.coagulable)) continue;
      const d = o.blob.getWorldPosition(this.v2).distanceTo(p);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    return best;
  }

  /** Bipolar coagulation completed on this point. */
  coagulate(o: Ooze) {
    if (!o.active) return;
    o.active = false;
    o.rate = 0;
    o.blob.material = this.charMat;
    if (o.jet) {
      this.group.remove(o.jet.mesh);
      o.jet.mesh.geometry.dispose();
      o.jet = undefined;
    }
    gsap.to(o.blob.scale, { x: o.blob.scale.x * 0.8, y: o.blob.scale.y * 0.8, z: 0.12, duration: 0.4 });
    this.puff(o.blob.getWorldPosition(new THREE.Vector3()), 14);
    events.emit('bleeding:stopped', { id: o.id });
  }

  /** Tear closed with a clip (clip reconstruction): bleeding stops, no char. */
  sealByClip(o: Ooze) {
    if (!o.active) return;
    o.active = false;
    o.rate = 0;
    if (o.jet) {
      this.group.remove(o.jet.mesh);
      o.jet.mesh.geometry.dispose();
      o.jet = undefined;
    }
    gsap.to(o.blob.scale, { x: 0.01, y: 0.01, z: 0.01, duration: 0.3 });
    events.emit('bleeding:stopped', { id: o.id });
  }

  /** Small puff of steam (bipolar on wet tissue). */
  puff(p: THREE.Vector3, n = 3) {
    const N = this.sLife.length;
    for (let k = 0; k < n; k++) {
      const i = this.sHead;
      this.sHead = (this.sHead + 1) % N;
      this.sPos[i * 3] = p.x + (this.rand() - 0.5) * 0.6;
      this.sPos[i * 3 + 1] = p.y + (this.rand() - 0.5) * 0.6;
      this.sPos[i * 3 + 2] = p.z + (this.rand() - 0.5) * 0.6;
      this.sVel[i * 3] = (this.rand() - 0.5) * 2 + UP.x * 5;
      this.sVel[i * 3 + 1] = (this.rand() - 0.5) * 2 + UP.y * 5;
      this.sVel[i * 3 + 2] = UP.z * (5 + this.rand() * 5);
      this.sLife[i] = 1;
    }
  }

  // ------------------------------------------------------------------------------ suction

  /**
   * Aspirate around the suction tip. `tipVel` (world mm/s) smears stains along the stroke.
   * Returns how much blood (0…1 intensity) was drawn this frame — drives the gurgle sound.
   */
  suction(tip: THREE.Vector3, dt: number, power = 1, tipVel?: THREE.Vector3): number {
    let drawn = 0;
    const r = 2.4;
    this.suctionActive = true;
    this.suctionTip.copy(tip);
    // Droplets: pulled in, then gone.
    for (let i = this.pCount - 1; i >= 0; i--) {
      this.v.fromArray(this.pPos, i * 3);
      const d = this.v.distanceTo(tip);
      if (d < r) {
        this.removeParticle(i);
        drawn += 0.08;
      } else if (d < r * 2.6) {
        this.v2.copy(tip).sub(this.v).normalize().multiplyScalar(160 * dt);
        this.pVel[i * 3] += this.v2.x;
        this.pVel[i * 3 + 1] += this.v2.y;
        this.pVel[i * 3 + 2] += this.v2.z;
      }
    }
    drawn += this.rivulets.suction(tip, r * 1.1);
    // Stains near the tip smear along the stroke, then lift off.
    for (const s of this.stains) {
      if (!s.alive) continue;
      s.parent.localToWorld(this.v.copy(s.local));
      if (this.v.distanceTo(tip) < r * 1.3) {
        if (tipVel && tipVel.lengthSq() > 1) {
          const invQ = s.parent.getWorldQuaternion(this.q).invert();
          s.smearDir.copy(tipVel).normalize().applyQuaternion(invQ);
          s.smear = Math.min(1, s.smear + dt * 5);
        }
        s.size -= dt * (0.9 + s.smear * 0.8);
        drawn += 0.02;
        if (s.size <= 0.05) s.alive = false;
      }
    }
    // Pool: full flow when the tip is in the blood, weaker when just above the surface.
    if (this.volume > 0) {
      const above = this.heightOf(tip) - this.level;
      const k = above < 0.8 ? 1 : above < 6 ? 0.35 * (1 - (above - 0.8) / 5.2) : 0;
      if (k > 0) {
        const take = Math.min(this.volume, 3.0 * power * k * dt);
        this.volume -= take;
        drawn += 0.6 * k;
        const onSurface = this.surfacePoint(tip);
        this.surface.suction(onSurface, k, dt);
        // Air-blood mix at the tip throws off a little spatter.
        if (this.rand() < dt * 7 * k) {
          const n = 1 + Math.floor(this.rand() * 2);
          for (let j = 0; j < n; j++) {
            const vel = UP.clone().multiplyScalar(30 + this.rand() * 40).add(this.v2.set(this.rand() - 0.5, this.rand() - 0.5, this.rand() - 0.5).multiplyScalar(50));
            // Spatter comes off the blood around the tip (inside the funnel, not above it).
            this.spawnAt(tip.clone().addScaledVector(UP, 0.8), vel, 0.06 + this.rand() * 0.08);
          }
        }
      }
    }
    drawn = Math.min(1, drawn);
    this.meniscusAmt = Math.max(this.meniscusAmt, drawn);
    return drawn;
  }

  /**
   * Is this pool point inside the clear window held open by suction? (Instruments can then
   * reach the tissue under it.)
   */
  inSuctionWindow(p: THREE.Vector3): boolean {
    return this.surface.inWindow(this.surface.toLocal(p));
  }

  /**
   * Where the instrument meets the blood surface: along the line of sight to the tip (so the
   * funnel is seen exactly where the tip enters the blood), falling back to straight up.
   */
  private surfacePoint(tip: THREE.Vector3): THREE.Vector3 {
    const up = this.level - this.heightOf(tip);
    if (this.camera) {
      const dir = tip.clone().sub(this.camera.position).normalize();
      const denom = dir.dot(UP);
      if (Math.abs(denom) > 0.2) return tip.clone().addScaledVector(dir, up / denom);
    }
    return tip.clone().addScaledVector(UP, up);
  }

  // ------------------------------------------------------------------------------ simulation

  /** Free droplet at `pos` with velocity `vel` (mm/s). */
  private spawnAt(pos: THREE.Vector3, vel: THREE.Vector3, radius: number, childFlow = 0, sourceId = 0) {
    if (this.pCount >= MAX_PARTICLES) return;
    const i = this.pCount++;
    this.pPos.set([pos.x, pos.y, pos.z], i * 3);
    this.pVel.set([vel.x, vel.y, vel.z], i * 3);
    this.pRad[i] = radius;
    this.pFlow[i] = childFlow;
    this.pSrc[i] = sourceId;
  }

  private removeParticle(i: number) {
    const last = --this.pCount;
    if (i === last) return;
    this.pPos.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.pVel.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.pRad[i] = this.pRad[last];
    this.pFlow[i] = this.pFlow[last];
    this.pSrc[i] = this.pSrc[last];
  }

  private addStain(object: THREE.Object3D, point: THREE.Vector3, normal: THREE.Vector3, size: number) {
    let s = this.stains.find((x) => !x.alive);
    if (!s) {
      if (this.stains.length >= MAX_STAINS) s = this.stains.shift()!;
      else s = { parent: object, local: new THREE.Vector3(), normalLocal: new THREE.Vector3(), size: 0, grow: 0, alive: true, smear: 0, smearDir: new THREE.Vector3(1, 0, 0) };
      this.stains.push(s);
    }
    s.parent = object;
    s.local.copy(object.worldToLocal(point.clone()));
    const invQ = object.getWorldQuaternion(new THREE.Quaternion()).invert();
    s.normalLocal.copy(normal).applyQuaternion(invQ);
    s.size = 0.05;
    s.grow = size;
    s.alive = true;
    s.smear = 0;
  }

  private worldNormal(o: Ooze, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(o.normalLocal).applyQuaternion(o.blob.parent!.getWorldQuaternion(this.q)).normalize();
  }

  private updateOoze(o: Ooze, dt: number, beat: number) {
    const at = o.blob.getWorldPosition(new THREE.Vector3());
    const n = this.worldNormal(o, new THREE.Vector3());
    const arterial = o.kind === 'arterial';

    // Welling bead: bigger for heavier bleeding, swelling with each beat.
    const base = Math.min(0.8, arterial ? 0.24 + Math.sqrt(o.rate) * 0.5 : 0.25 + Math.sqrt(o.rate) * 1.4);
    const k = 1 + (arterial ? 0.22 : 0.06) * beat;
    o.blob.scale.set(base * k, base * k, base * 0.75 * k);

    if (this.submerged(at, -0.2)) {
      // Under blood the bleeder shows only as a welling point with froth — a key cue.
      o.jet?.setVisible(false);
      o.wellAcc += dt * (arterial ? 1.2 + 3 * beat : 2);
      if (o.wellAcc > 1) {
        o.wellAcc = 0;
        const surf = at.clone().addScaledVector(UP, this.level - this.heightOf(at));
        this.surface.addRipple(surf, arterial ? 0.18 : 0.08);
        this.surface.froth(surf, arterial ? 3 : 1);
      }
      return;
    }

    // Blood welling out of the hole runs down the surface.
    o.restart -= dt;
    if ((!o.sourceRiv || o.sourceRiv.finished) && o.restart <= 0) {
      o.sourceRiv = this.rivulets.start(o.id, o.blob.parent!, at, n, arterial ? 0.3 : 1);
      o.restart = 0.35;
    }

    if (!arterial || !o.jet) return;
    // Without arterial pressure there is no jet — blood only wells out and runs.
    if (cardiac.pressure < 35 || o.rate < 0.2) {
      o.jet.setVisible(false);
      return;
    }
    o.jet.setVisible(true);
    // The jet leaves roughly along the wall normal.
    const impact = o.jet.update(dt, at.clone().addScaledVector(n, 0.25), n, o.rate, beat, {
      gravity: GRAVITY,
      raycastSegment: (a, b) => this.castSegment(a, b),
      submerged: (p) => this.submerged(p, -0.1),
      suctionTip: () => (this.suctionActive ? this.suctionTip : null),
    });
    if (!impact) return;
    if (impact.kind === 'suction') {
      // Caught by the suction: that blood never reaches the field.
      this.volume = Math.max(0, this.volume - o.rate * dt * 0.9);
      this.meniscusAmt = Math.max(this.meniscusAmt, 0.8);
      return;
    }
    if (impact.kind === 'pool') {
      this.rippleAcc += dt * 10;
      if (this.rippleAcc > 1) {
        this.rippleAcc = 0;
        this.surface.addRipple(impact.point, 0.12 + 0.2 * beat);
        this.surface.froth(impact.point, 2);
      }
      return;
    }
    // Hitting tissue: splash droplets and a stain, and blood runs on from the impact.
    o.sprayAcc += dt * (40 + 260 * o.rate) * (0.3 + beat);
    const vin = impact.velocity;
    const refl = vin.clone().reflect(impact.normal).multiplyScalar(0.07);
    while (o.sprayAcc >= 1) {
      o.sprayAcc -= 1;
      const vel = refl.clone().add(this.v2.set(this.rand() - 0.5, this.rand() - 0.5, this.rand() - 0.5).multiplyScalar(60)).addScaledVector(impact.normal, 20);
      this.spawnAt(impact.point.clone().addScaledVector(impact.normal, 0.3), vel, 0.05 + this.rand() * 0.1);
    }
    if (impact.object) {
      // One rivulet carries the blood on from the impact; only restart it once it has ended
      // (debounced) or if the jet now lands somewhere clearly different.
      o.impactWait = (o.impactWait ?? 0) - dt;
      const moved = !!o.impactAt && o.impactAt.distanceTo(impact.point) > 6;
      const ended = !o.impactRiv || (o.impactRiv.finished && o.impactWait <= 0);
      if (moved || ended) {
        o.impactWait = 1.2;
        o.impactRiv = this.rivulets.start(o.id, impact.object, impact.point, impact.normal, 0.7);
        o.impactAt = impact.point.clone();
        this.addStain(impact.object, impact.point, impact.normal, 0.5 + Math.sqrt(o.rate) * 1.2);
      }
    }
  }

  update(dt: number) {
    // Pulse from the circulation engine: jets and welling follow the real pressure waveform.
    const beat = cardiac.pulse01;

    // --- Parked suction keeps working, following the blood surface down as it clears ---
    if (this.parked) {
      const eff = this.parked.clone();
      const above = this.heightOf(eff) - this.level;
      if (above > 0) eff.addScaledVector(GRAVITY, Math.min(above, 12));
      this.parkedDrawn = this.suction(eff, dt, 1);
      audio.suction(true, this.parkedDrawn);
      this.wasParked = true;
    } else if (this.wasParked) {
      this.wasParked = false;
      audio.suction(false);
    }

    // --- Bleeding points ---
    let rate = 0;
    for (const o of this.oozes) {
      if (!o.active) continue;
      if (o.selfLimiting) o.baseRate *= Math.exp(-dt / 140);
      o.rate = o.baseRate * this.rateModifier(o);
      rate += o.rate;
      this.updateOoze(o, dt, beat);
    }
    state.bleedingRate = rate;
    state.ebl += rate * dt;
    this.volume += rate * dt;

    // --- Blood running over tissue ---
    this.rivulets.update(dt, beat);

    // --- Droplets ---
    for (let i = this.pCount - 1; i >= 0; i--) {
      const o3 = i * 3;
      this.v.fromArray(this.pPos, o3); // previous position
      this.pVel[o3] += GRAVITY.x * DROP_G * dt;
      this.pVel[o3 + 1] += GRAVITY.y * DROP_G * dt;
      this.pVel[o3 + 2] += GRAVITY.z * DROP_G * dt;
      this.v2.set(this.v.x + this.pVel[o3] * dt, this.v.y + this.pVel[o3 + 1] * dt, this.v.z + this.pVel[o3 + 2] * dt);
      if (this.submerged(this.v2)) {
        this.rippleAcc += 0.3;
        if (this.rippleAcc > 1) {
          this.rippleAcc = 0;
          this.surface.addRipple(this.v2, 0.05 + this.pRad[i] * 0.3);
        }
        this.removeParticle(i);
        continue;
      }
      const hit = this.castSegment(this.v, this.v2);
      if (hit && hit.face) {
        const hn = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        if (hn.dot(this.v.clone().sub(hit.point)) < 0) hn.negate();
        if (this.pFlow[i] > 0 && this.rivulets.rivulets.length < 48) {
          this.rivulets.start(this.pSrc[i], hit.object, hit.point, hn, Math.min(1, this.pFlow[i] / Math.max(1e-3, this.oozeById(this.pSrc[i])?.rate ?? 1)));
        } else if (this.rand() < 0.6) {
          this.addStain(hit.object, hit.point, hn, this.pRad[i] * (2 + this.rand() * 2));
        }
        this.removeParticle(i);
        continue;
      }
      if (this.v2.z < -40) {
        this.removeParticle(i);
        continue;
      }
      this.pPos.set([this.v2.x, this.v2.y, this.v2.z], o3);
    }
    for (let i = 0; i < this.pCount; i++) {
      const r = this.pRad[i];
      this.v2.fromArray(this.pVel, i * 3);
      const speed = this.v2.length();
      if (speed > 1e-3) this.q.setFromUnitVectors(this.zAxis, this.v2.multiplyScalar(1 / speed));
      else this.q.identity();
      // Mild motion stretch.
      const stretch = 1 + Math.min(1.5, speed * 0.004);
      this.m.compose(this.v.fromArray(this.pPos, i * 3), this.q, this.s.set(r, r, r * stretch));
      this.particles.setMatrixAt(i, this.m);
    }
    this.particles.count = this.pCount;
    this.particles.instanceMatrix.needsUpdate = true;

    // --- Stains ---
    let n = 0;
    for (const s of this.stains) {
      if (!s.alive) continue;
      if (s.size < s.grow) s.size = Math.min(s.grow, s.size + dt * 2);
      s.parent.localToWorld(this.v.copy(s.local));
      if (this.submerged(this.v, -0.2)) continue;
      const pq = s.parent.getWorldQuaternion(this.q);
      const nz = this.v2.copy(s.normalLocal).applyQuaternion(pq).normalize();
      // Basis: z = surface normal, x = smear direction in the surface plane.
      const sx = s.smearDir.clone().applyQuaternion(pq);
      sx.addScaledVector(nz, -sx.dot(nz));
      if (sx.lengthSq() < 1e-6) sx.set(1, 0, 0).addScaledVector(nz, -nz.x);
      sx.normalize();
      const sy = new THREE.Vector3().crossVectors(nz, sx);
      this.m.makeBasis(sx, sy, nz);
      this.m.scale(this.s.set(s.size * (1 + s.smear * 2.2), s.size * (1 - s.smear * 0.35), 0.03 + s.size * 0.08));
      this.m.setPosition(this.v);
      this.stainMesh.setMatrixAt(n++, this.m);
    }
    this.stainMesh.count = n;
    this.stainMesh.instanceMatrix.needsUpdate = true;

    // --- Pool ---
    const target = Math.min(POOL.fullLevel, POOL.emptyLevel + (this.volume * 1000) / POOL.area);
    this.level += (target - this.level) * (1 - Math.exp(-dt * 3));
    this.pool.visible = this.volume > 0.02 || this.level > POOL.emptyLevel + 0.05;
    this.pool.position.copy(POOL.origin).addScaledVector(UP, this.level);
    this.surface.update(dt, rate);
    state.fieldBlood = this.volume;

    // Meniscus of blood at the suction tip.
    this.meniscus.visible = this.meniscusAmt > 0.04 && this.suctionActive;
    if (this.meniscus.visible) {
      const wob = 1 + 0.12 * Math.sin(performance.now() * 0.03) * this.meniscusAmt;
      const r = 0.55 + this.meniscusAmt * 0.5;
      this.meniscus.position.copy(this.suctionTip);
      this.meniscus.scale.set(r * wob, r / wob, r * 1.3);
    }
    this.suctionActive = false;
    this.meniscusAmt *= Math.exp(-dt * 3);

    // --- Steam ---
    const N = this.sLife.length;
    for (let i = 0; i < N; i++) {
      if (this.sLife[i] <= 0) {
        this.sCol[i * 4 + 3] = 0;
        continue;
      }
      this.sLife[i] -= dt * 0.9;
      this.sPos[i * 3] += this.sVel[i * 3] * dt;
      this.sPos[i * 3 + 1] += this.sVel[i * 3 + 1] * dt;
      this.sPos[i * 3 + 2] += this.sVel[i * 3 + 2] * dt;
      const a = Math.max(0, this.sLife[i]) * 0.45;
      this.sCol.set([1, 0.97, 0.93, a], i * 4);
    }
    this.steam.geometry.attributes.position.needsUpdate = true;
    this.steam.geometry.attributes.color.needsUpdate = true;
  }
}

function isShown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}
