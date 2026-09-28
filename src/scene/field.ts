import type * as THREE from 'three';
import { MICROSCOPE } from '../config/sim';

/**
 * Is a pointer position (NDC) inside the circular microscope field? Anything outside the field
 * stop is black in the eyepiece, so it must not be pickable either. Mirrors MicroscopeEffect.
 */
export function insideField(ndc: THREE.Vector2, aspect: number, radius = MICROSCOPE.fieldRadius): boolean {
  const x = (ndc.x / 2) * aspect;
  const y = ndc.y / 2;
  return x * x + y * y < radius * radius * 0.96;
}
