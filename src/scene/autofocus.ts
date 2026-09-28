import * as THREE from 'three';
import { MICROSCOPE } from '../config/sim';

/**
 * Microscope autofocus: casts a ray through the centre of the field and smoothly drives the
 * focal plane to whatever tissue is there. Out-of-plane structures blur with the shallow depth
 * of field — just like the real optics, where you constantly refocus as you work deeper.
 */
export class Autofocus {
  private raycaster = new THREE.Raycaster();
  private center = new THREE.Vector2(0, 0);
  /** Current (smoothed) focus distance from the camera, mm. */
  distance: number;
  private targetDistance: number;
  private frame = 0;

  constructor(private camera: THREE.PerspectiveCamera, private targets: () => THREE.Object3D[], initial: number) {
    this.distance = this.targetDistance = initial;
    (this.raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
  }

  update(dt: number): number {
    if (this.frame++ % 2 === 0) {
      this.raycaster.setFromCamera(this.center, this.camera);
      const hits = this.raycaster.intersectObjects(this.targets(), false);
      // Focus on tissue, not on instruments passing through the field.
      const hit = hits.find((h) => h.object.userData.kind !== 'instrument' && isVisible(h.object));
      if (hit) this.targetDistance = hit.distance;
    }
    const k = 1 - Math.exp(-dt * MICROSCOPE.autofocusSpeed);
    this.distance += (this.targetDistance - this.distance) * k;
    return this.distance;
  }
}

function isVisible(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}
