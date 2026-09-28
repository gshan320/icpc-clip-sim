import * as THREE from 'three';

/**
 * Rivulets: blood running over tissue.
 *
 * A rivulet is a "walker" that starts at a bleeding point (or where a jet or drip lands) and
 * steps downhill along the real surface: at each step it moves along gravity projected onto the
 * surface, then re-finds the surface with a short BVH raycast. The path it leaves is drawn as a
 * chain of overlapping, flow-aligned films, so it reads as one continuous streak that follows
 * the curve of the vessel or gyrus, widens as bleeding continues and shimmers while it flows.
 *
 * When the surface falls away (an overhang or the edge of a vessel) the rivulet drips; the drop
 * starts a new rivulet where it lands. When the source stops, the streak stops moving, darkens
 * as it clots, and stays until suctioned.
 */

const STEP = 0.38; // mm per walker step
const MAX_POINTS = 2800;
const MAX_PER_RIVULET = 140;

export interface RivuletHooks {
  gravity: THREE.Vector3;
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, far: number): THREE.Intersection | null;
  submerged(p: THREE.Vector3): boolean;
  /** Blood running off an edge. */
  drip(pos: THREE.Vector3, vel: THREE.Vector3, sourceId: number, flow: number): void;
  /** Is the bleeding source still active? And its current rate (mL/s). */
  sourceRate(sourceId: number): number;
}

interface RPoint {
  parent: THREE.Object3D;
  local: THREE.Vector3;
  nLocal: THREE.Vector3;
  dLocal: THREE.Vector3;
  w: number;
  seq: number;
  riv: Rivulet;
  alive: boolean;
}

export interface Rivulet {
  id: number;
  sourceId: number;
  /** Share of the source's rate that runs down this path. */
  share: number;
  headParent: THREE.Object3D;
  headLocal: THREE.Vector3;
  headNLocal: THREE.Vector3;
  acc: number;
  seq: number;
  points: RPoint[];
  finished: boolean;
  /** Seconds since its source stopped (clotting). */
  age: number;
  width: number;
  /** Time spent pooling on a flat spot. */
  pooled: number;
}

const FRESH = new THREE.Color(0x9c0d14);
const CLOTTED = new THREE.Color(0x3c0507);

export class RivuletSystem {
  readonly mesh: THREE.InstancedMesh;
  readonly rivulets: Rivulet[] = [];
  private points: RPoint[] = [];
  private nextId = 1;
  private time = 0;
  private m = new THREE.Matrix4();
  private v = new THREE.Vector3();
  private n = new THREE.Vector3();
  private d = new THREE.Vector3();
  private c = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private col = new THREE.Color();
  private bx = new THREE.Vector3();
  private by = new THREE.Vector3();
  private sc = new THREE.Vector3();

  constructor(private hooks: RivuletHooks) {
    // Film element: a flattened sphere, long axis along +X (flow), thin along +Z (normal).
    const geom = new THREE.SphereGeometry(1, 16, 10);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.14,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      sheen: 0.5,
      sheenColor: new THREE.Color(0xff2a20),
      envMapIntensity: 1.2,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    // Shade every film element with (mostly) the surface normal, so overlapping elements read
    // as one smooth wet sheet instead of a pile of bumps; keep a little curvature at the rims.
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        objectNormal = normalize(mix(vec3(0.0, 0.0, 1.0), objectNormal, 0.22 + 0.5 * smoothstep(0.6, 1.0, length(position.xy))));`,
      );
    };
    this.mesh = new THREE.InstancedMesh(geom, mat, MAX_POINTS);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.setColorAt(0, FRESH);
    this.mesh.userData = { kind: 'blood-film' };
  }

  start(sourceId: number, parent: THREE.Object3D, point: THREE.Vector3, normal: THREE.Vector3, share: number): Rivulet {
    const invQ = parent.getWorldQuaternion(this.q).invert();
    const r: Rivulet = {
      id: this.nextId++,
      sourceId,
      share,
      headParent: parent,
      headLocal: parent.worldToLocal(point.clone()),
      headNLocal: normal.clone().applyQuaternion(invQ).normalize(),
      acc: STEP,
      seq: 0,
      points: [],
      finished: false,
      age: 0,
      width: 0.3,
      pooled: 0,
    };
    this.rivulets.push(r);
    return r;
  }

  private addPoint(r: Rivulet, parent: THREE.Object3D, world: THREE.Vector3, n: THREE.Vector3, d: THREE.Vector3) {
    if (this.points.length >= MAX_POINTS) this.evictOldest();
    const invQ = parent.getWorldQuaternion(this.q).invert();
    const p: RPoint = {
      parent,
      local: parent.worldToLocal(world.clone()),
      nLocal: n.clone().applyQuaternion(invQ).normalize(),
      dLocal: d.clone().applyQuaternion(invQ).normalize(),
      w: r.width * 0.35,
      seq: r.seq++,
      riv: r,
      alive: true,
    };
    r.points.push(p);
    this.points.push(p);
  }

  private evictOldest() {
    // Drop the oldest clotted rivulet's points first; otherwise the oldest points overall.
    const victim = this.rivulets.find((r) => r.age > 0) ?? this.rivulets[0];
    if (!victim) return;
    for (const p of victim.points) p.alive = false;
    victim.points.length = 0;
    victim.finished = true;
    this.compact();
  }

  private compact() {
    this.points = this.points.filter((p) => p.alive);
    for (let i = this.rivulets.length - 1; i >= 0; i--) {
      const r = this.rivulets[i];
      r.points = r.points.filter((p) => p.alive);
      if (r.finished && r.points.length === 0) this.rivulets.splice(i, 1);
    }
  }

  /** Walk one rivulet head downhill. */
  private advance(r: Rivulet, dt: number, flow: number) {
    const g = this.hooks.gravity;
    r.headParent.localToWorld(this.v.copy(r.headLocal));
    this.n.copy(r.headNLocal).applyQuaternion(r.headParent.getWorldQuaternion(this.q)).normalize();
    this.d.copy(g).addScaledVector(this.n, -g.dot(this.n));
    const slope = this.d.length();
    // Heavier bleeding runs faster; steeper surfaces run faster.
    const speed = (2.2 + 32 * flow) * Math.max(0.2, slope);
    if (slope < 0.14) {
      // Nearly level: blood gathers into a little puddle before spilling over.
      r.pooled += dt;
      r.width = Math.min(1.25, r.width + dt * 0.25);
      if (r.pooled < 1.5) return;
    }
    r.acc += speed * dt;
    let guard = 0;
    while (r.acc >= STEP && guard++ < 8) {
      r.acc -= STEP;
      if (slope > 1e-4) this.d.multiplyScalar(1 / slope);
      else this.d.set(1, 0, 0).addScaledVector(this.n, -this.n.x).normalize();
      // Gentle meander.
      const wig = Math.sin(r.seq * 0.55 + r.id * 1.7) * 0.28;
      this.d.applyAxisAngle(this.n, wig).normalize();
      this.c.copy(this.v).addScaledVector(this.d, STEP).addScaledVector(this.n, 0.55);
      let hit = this.hooks.raycast(this.c, this.n.clone().negate(), 1.7);
      if (!hit) hit = this.hooks.raycast(this.c, g, 3);
      if (!hit || !hit.face) {
        // Surface falls away — the blood drips off the edge.
        this.hooks.drip(this.v.clone().addScaledVector(this.d, 0.3), this.d.clone().multiplyScalar(8), r.sourceId, flow);
        r.finished = true;
        return;
      }
      const hn = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      if (hn.dot(this.c.clone().sub(hit.point)) < 0) hn.negate();
      this.v.copy(hit.point).addScaledVector(hn, 0.02);
      this.n.copy(hn);
      if (this.hooks.submerged(this.v)) {
        r.finished = true; // merged into the pool
        return;
      }
      this.addPoint(r, hit.object, this.v, this.n, this.d);
      r.headParent = hit.object;
      r.headLocal.copy(hit.object.worldToLocal(this.v.clone()));
      r.headNLocal.copy(this.n).applyQuaternion(hit.object.getWorldQuaternion(this.q).invert()).normalize();
      if (r.points.length >= MAX_PER_RIVULET) {
        r.finished = true;
        return;
      }
      this.d.copy(g).addScaledVector(this.n, -g.dot(this.n));
    }
  }

  /** Suction lifts films near the tip. Returns an intensity for the gurgle. */
  suction(tip: THREE.Vector3, radius: number): number {
    let drawn = 0;
    let removed = false;
    for (const p of this.points) {
      if (!p.alive) continue;
      p.parent.localToWorld(this.v.copy(p.local));
      if (this.v.distanceTo(tip) < radius) {
        p.alive = false;
        removed = true;
        drawn += 0.01;
        // An active rivulet cut by suction restarts from its source.
        p.riv.finished = true;
      }
    }
    if (removed) this.compact();
    return Math.min(1, drawn);
  }

  /** Does a source currently have a rivulet still running? */
  hasRunning(sourceId: number, minShare = 0): boolean {
    return this.rivulets.some((r) => r.sourceId === sourceId && !r.finished && r.share >= minShare);
  }

  update(dt: number, beat: number) {
    this.time += dt;
    for (const r of this.rivulets) {
      const rate = this.hooks.sourceRate(r.sourceId);
      const flow = rate * r.share;
      if (rate > 0) {
        r.age = 0;
        // Streak widens toward its flow-determined width.
        const target = 0.26 + 1.1 * Math.sqrt(flow);
        r.width += (Math.max(target, r.width * 0.999) - r.width) * (1 - Math.exp(-dt * 0.8));
        if (!r.finished) this.advance(r, dt, flow);
      } else {
        r.age += dt;
        r.finished = true;
      }
    }

    // Render.
    let k = 0;
    const tq = this.q;
    for (const p of this.points) {
      if (!p.alive) continue;
      const r = p.riv;
      const flowing = r.age === 0;
      // Films near the head are thinner (the leading edge of the stream).
      const fromHead = r.seq - p.seq;
      const taper = flowing && !r.finished ? Math.min(1, 0.35 + fromHead * 0.12) : 1;
      p.w += (r.width * taper - p.w) * (1 - Math.exp(-dt * 2.5));
      p.parent.localToWorld(this.v.copy(p.local));
      if (this.hooks.submerged(this.v)) continue;
      p.parent.getWorldQuaternion(tq);
      this.n.copy(p.nLocal).applyQuaternion(tq);
      this.bx.copy(p.dLocal).applyQuaternion(tq);
      this.bx.addScaledVector(this.n, -this.bx.dot(this.n)).normalize();
      this.by.crossVectors(this.n, this.bx);
      // Travelling bulges while blood is running (with the pulse for arterial sources).
      const wave = flowing ? 1 + (0.1 + 0.12 * beat) * Math.sin(this.time * 9 - p.seq * 0.75) : 1;
      const w = p.w * wave;
      this.m.makeBasis(this.bx, this.by, this.n);
      this.m.scale(this.sc.set(w * 1.35, w, 0.03 + w * 0.07));
      this.m.setPosition(p.parent.localToWorld(this.c.copy(p.local)));
      this.mesh.setMatrixAt(k, this.m);
      this.col.copy(FRESH).lerp(CLOTTED, Math.min(1, r.age / 12));
      this.mesh.setColorAt(k, this.col);
      k++;
    }
    this.mesh.count = k;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
