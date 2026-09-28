import * as THREE from 'three';

/**
 * Arterial jet: the pulsatile stream from a hole in an artery.
 *
 * The stream leaves the wall at arterial speed (hundreds of mm/s at systole) under real gravity,
 * so at microscope scale it is almost straight and arcs only slightly. Each frame its ballistic
 * path is traced in short segments against the anatomy (BVH raycasts) until it hits tissue, the
 * pool or the suction tip. The visible stream is a tapered tube along that path whose length and
 * thickness pulse with the arterial waveform, with varicose ripples toward its end where a real
 * jet starts to break into drops.
 */

const RINGS = 36;
const RADIAL = 10;
const G_MM = 9800; // mm/s²

export interface JetImpact {
  object: THREE.Object3D | null;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  /** Velocity of the stream on arrival (mm/s). */
  velocity: THREE.Vector3;
  kind: 'tissue' | 'pool' | 'suction';
}

export interface JetHooks {
  gravity: THREE.Vector3;
  raycastSegment(a: THREE.Vector3, b: THREE.Vector3): THREE.Intersection | null;
  submerged(p: THREE.Vector3): boolean;
  /** Suction tip position if suction is active this frame. */
  suctionTip(): THREE.Vector3 | null;
}

export class ArterialJet {
  readonly mesh: THREE.Mesh;
  private geom: THREE.BufferGeometry;
  private pos: Float32Array;
  private nrm: Float32Array;
  private path: THREE.Vector3[] = Array.from({ length: RINGS }, () => new THREE.Vector3());
  private time = Math.random() * 10;
  private t = new THREE.Vector3();
  private a = new THREE.Vector3();
  private p = new THREE.Vector3();
  private vel = new THREE.Vector3();

  constructor(material: THREE.Material) {
    this.geom = new THREE.BufferGeometry();
    this.pos = new Float32Array(RINGS * (RADIAL + 1) * 3);
    this.nrm = new Float32Array(RINGS * (RADIAL + 1) * 3);
    this.geom.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    const idx: number[] = [];
    for (let i = 0; i < RINGS - 1; i++) {
      for (let j = 0; j < RADIAL; j++) {
        const a = i * (RADIAL + 1) + j;
        const b = (i + 1) * (RADIAL + 1) + j;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    this.geom.setIndex(idx);
    this.mesh = new THREE.Mesh(this.geom, material);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.userData = { kind: 'blood-jet' };
  }

  /**
   * Trace and rebuild the stream. `origin` is the hole, `dir` the exit direction, `rate` the
   * bleed rate (mL/s), `beat` the arterial waveform (0…1). Returns where it lands, or null.
   */
  update(dt: number, origin: THREE.Vector3, dir: THREE.Vector3, rate: number, beat: number, hooks: JetHooks): JetImpact | null {
    this.time += dt;
    // Exit speed follows the pressure wave; diastole keeps a weaker stream going.
    const speed = Math.min(1600, 200 + 1100 * rate) * (0.28 + 0.72 * beat);
    const radius = Math.min(1.1, 0.14 + 0.55 * Math.sqrt(rate)) * (0.75 + 0.25 * beat);
    this.vel.copy(dir).normalize().multiplyScalar(speed);
    // Slight flutter of the exit direction.
    this.vel.x += Math.sin(this.time * 23) * speed * 0.02;
    this.vel.y += Math.cos(this.time * 19) * speed * 0.02;
    const seg = 1.1; // mm per segment
    const stepT = seg / Math.max(speed, 1);
    const g = hooks.gravity;
    const tip = hooks.suctionTip();
    let impact: JetImpact | null = null;
    let count = RINGS;
    this.p.copy(origin);
    this.path[0].copy(origin);
    for (let i = 1; i < RINGS; i++) {
      this.a.copy(this.p);
      this.vel.addScaledVector(g, G_MM * stepT);
      this.p.addScaledVector(this.vel, stepT);
      this.path[i].copy(this.p);
      if (tip && this.p.distanceTo(tip) < 1.8) {
        impact = { object: null, point: this.p.clone(), normal: this.vel.clone().negate().normalize(), velocity: this.vel.clone(), kind: 'suction' };
        count = i + 1;
        break;
      }
      if (hooks.submerged(this.p)) {
        impact = { object: null, point: this.p.clone(), normal: g.clone().negate(), velocity: this.vel.clone(), kind: 'pool' };
        count = i + 1;
        break;
      }
      const hit = i > 1 ? hooks.raycastSegment(this.a, this.p) : null;
      if (hit && hit.face) {
        this.path[i].copy(hit.point);
        const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        if (n.dot(this.vel) > 0) n.negate();
        impact = { object: hit.object, point: hit.point.clone(), normal: n, velocity: this.vel.clone(), kind: 'tissue' };
        count = i + 1;
        break;
      }
    }
    // Unused rings collapse onto the end point.
    for (let i = count; i < RINGS; i++) this.path[i].copy(this.path[count - 1]);
    this.build(count, radius);
    return impact;
  }

  setVisible(v: boolean) {
    this.mesh.visible = v;
  }

  private build(count: number, r0: number) {
    const up = new THREE.Vector3(0, 0, 1);
    const nA = new THREE.Vector3();
    const nB = new THREE.Vector3();
    let k = 0;
    for (let i = 0; i < RINGS; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(count - 1, i + 1);
      this.t.subVectors(this.path[Math.min(i1, RINGS - 1)], this.path[Math.min(i0, count - 1)]);
      if (this.t.lengthSq() < 1e-10) this.t.set(0, 0, -1);
      this.t.normalize();
      nA.crossVectors(this.t, Math.abs(this.t.z) > 0.9 ? new THREE.Vector3(1, 0, 0) : up).normalize();
      nB.crossVectors(this.t, nA).normalize();
      const s = i / Math.max(1, count - 1); // 0 at the hole → 1 at the end
      // Swells slightly as it leaves the wall, thins toward the end, varicose ripples near the tip.
      let r = r0 * (0.8 + 0.35 * Math.sin(Math.min(1, s * 3) * Math.PI * 0.5)) * (1 - 0.35 * s);
      r *= 1 + 0.28 * s * s * Math.sin(i * 1.9 - this.time * 42);
      if (i >= count) r = 0;
      for (let j = 0; j <= RADIAL; j++) {
        const ang = (j / RADIAL) * Math.PI * 2;
        const c = Math.cos(ang), sn = Math.sin(ang);
        const nx = nA.x * c + nB.x * sn, ny = nA.y * c + nB.y * sn, nz = nA.z * c + nB.z * sn;
        const P = this.path[Math.min(i, count - 1)];
        this.pos[k] = P.x + nx * r;
        this.pos[k + 1] = P.y + ny * r;
        this.pos[k + 2] = P.z + nz * r;
        this.nrm[k] = nx;
        this.nrm[k + 1] = ny;
        this.nrm[k + 2] = nz;
        k += 3;
      }
    }
    (this.geom.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.attributes.normal as THREE.BufferAttribute).needsUpdate = true;
  }
}
