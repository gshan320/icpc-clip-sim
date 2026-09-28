import * as THREE from 'three';

export interface TubeOptions {
  tubular: number;
  radial: number;
  /** Radius as a function of arc-length parameter t ∈ [0,1]. */
  radius: (t: number) => number;
  /** Optional elliptical cross-section: scale along the Frenet normal / binormal. */
  ellipse?: [number, number];
  /** Rotate the cross-section (radians) — orients a flattened nerve. */
  twist?: number;
  /** Close the ends with rounded caps (so you never see into a hollow vessel). */
  capStart?: boolean;
  capEnd?: boolean;
  /**
   * Instead of Frenet frames, orient the cross-section so its first axis follows this reference
   * direction (e.g. +Z = toward the surgeon, so a flattened nerve shows its broad face).
   */
  up?: THREE.Vector3;
}

/**
 * A variable-radius TubeGeometry. Same parametrisation as THREE.TubeGeometry
 * (uv.x = along the vessel, uv.y = around it), which the tissue shader uses to send the pulse
 * wave downstream, plus radius tapering, elliptical sections and rounded end caps.
 */
export function buildTube(curve: THREE.Curve<THREE.Vector3>, o: TubeOptions): THREE.BufferGeometry {
  const { tubular, radial } = o;
  const [ea, eb] = o.ellipse ?? [1, 1];
  const twist = o.twist ?? 0;
  const frames = curve.computeFrenetFrames(tubular, false);
  if (o.up) {
    for (let i = 0; i <= tubular; i++) {
      const t = frames.tangents[i];
      const n = o.up.clone().addScaledVector(t, -o.up.dot(t)).normalize();
      frames.normals[i].copy(n);
      frames.binormals[i].crossVectors(t, n).normalize();
    }
  }
  const capRings = 6;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const P = new THREE.Vector3();
  const T = new THREE.Vector3();
  const N = new THREE.Vector3();
  const B = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const nrm = new THREE.Vector3();

  const pushRing = (center: THREE.Vector3, n: THREE.Vector3, b: THREE.Vector3, t: THREE.Vector3, r: number, u: number, axial: number) => {
    // axial ∈ [-1, 1]: bends the ring normals toward ±tangent on the caps.
    for (let j = 0; j <= radial; j++) {
      const v = (j / radial) * Math.PI * 2 + twist;
      // Same orientation as THREE.TubeGeometry (-cos) so triangle winding faces outward.
      const c = -Math.cos(v), s = Math.sin(v);
      tmp.copy(n).multiplyScalar(c * ea * r).addScaledVector(b, s * eb * r).add(center);
      positions.push(tmp.x, tmp.y, tmp.z);
      nrm.copy(n).multiplyScalar(c / ea).addScaledVector(b, s / eb).normalize();
      if (axial !== 0) {
        const k = Math.sqrt(Math.max(0, 1 - axial * axial));
        nrm.multiplyScalar(k).addScaledVector(t, axial).normalize();
      }
      normals.push(nrm.x, nrm.y, nrm.z);
      uvs.push(u, j / radial);
    }
  };

  let ringCount = 0;
  const r0 = o.radius(0);
  const r1 = o.radius(1);

  if (o.capStart) {
    curve.getPointAt(0, P);
    T.copy(frames.tangents[0]);
    for (let k = 0; k < capRings; k++) {
      const a = (1 - k / capRings) * (Math.PI / 2); // from pole (a=π/2) to equator
      const center = P.clone().addScaledVector(T, -Math.sin(a) * r0 * 0.9);
      pushRing(center, frames.normals[0], frames.binormals[0], T, Math.max(Math.cos(a), 0.02) * r0, 0, -Math.sin(a));
      ringCount++;
    }
  }

  for (let i = 0; i <= tubular; i++) {
    const u = i / tubular;
    curve.getPointAt(u, P);
    N.copy(frames.normals[i]);
    B.copy(frames.binormals[i]);
    T.copy(frames.tangents[i]);
    pushRing(P, N, B, T, o.radius(u), u, 0);
    ringCount++;
  }

  if (o.capEnd) {
    curve.getPointAt(1, P);
    T.copy(frames.tangents[tubular]);
    for (let k = 1; k <= capRings; k++) {
      const a = (k / capRings) * (Math.PI / 2);
      const center = P.clone().addScaledVector(T, Math.sin(a) * r1 * 0.9);
      pushRing(center, frames.normals[tubular], frames.binormals[tubular], T, Math.max(Math.cos(a), 0.02) * r1, 1, Math.sin(a));
      ringCount++;
    }
  }

  for (let i = 0; i < ringCount - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j;
      const b = (i + 1) * (radial + 1) + j;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  return g;
}

/** Catmull-Rom spline through [x,y,z] tuples (centripetal — avoids loops and cusps). */
export function splineFrom(points: [number, number, number][]): THREE.CatmullRomCurve3 {
  return new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, 'centripetal');
}
