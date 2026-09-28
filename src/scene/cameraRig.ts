import CameraControls from 'camera-controls';
import * as THREE from 'three';
import { VIEW } from '../config/anatomy';

CameraControls.install({ THREE });

/**
 * The microscope head. It pivots around a focal point (orbit), pans (the surgeon moves the
 * scope in XY) and zooms optically (changing magnification without moving). Everything is
 * damped so motion feels like a counter-balanced microscope arm.
 *
 *  Right-drag or Option/Alt-drag : tilt the scope around the focal point
 *  Middle-drag or Shift-drag     : pan
 *  Wheel / pinch                 : magnification
 *  Double-click                  : re-centre on the clicked point
 *  F                             : back to the default view
 *  Arrow keys, + / -             : tilt and zoom from the keyboard
 */
export interface CameraRig {
  camera: THREE.PerspectiveCamera;
  controls: CameraControls;
  update(dt: number): boolean;
  resetView(animate?: boolean): void;
  focusOn(point: THREE.Vector3): void;
  /** Smoothly swing the scope to a recommended working view. */
  goTo(view: { target: [number, number, number]; azimuthDeg: number; polarDeg: number; zoom: number }): void;
  magnification(): number;
  /** Let tools take the left mouse button / wheel. */
  setLeftButtonFree(free: boolean): void;
  setWheelZoom(enabled: boolean): void;
  target(out: THREE.Vector3): THREE.Vector3;
}

const deg = THREE.MathUtils.degToRad;

export function createCameraRig(dom: HTMLElement): CameraRig {
  const camera = new THREE.PerspectiveCamera(VIEW.fov, dom.clientWidth / dom.clientHeight, 20, 600);
  const controls = new CameraControls(camera, dom);
  const A = CameraControls.ACTION;

  controls.mouseButtons.left = A.NONE;
  controls.mouseButtons.right = A.ROTATE;
  controls.mouseButtons.middle = A.TRUCK;
  controls.mouseButtons.wheel = A.ZOOM;
  controls.touches.one = A.TOUCH_ROTATE;
  controls.touches.two = A.TOUCH_ZOOM_TRUCK;
  controls.touches.three = A.TOUCH_TRUCK;

  controls.smoothTime = 0.32;
  controls.draggingSmoothTime = 0.14;
  controls.azimuthRotateSpeed = 0.32;
  controls.polarRotateSpeed = 0.32;
  controls.truckSpeed = 1.2;
  controls.dollySpeed = 0.5;
  controls.minZoom = VIEW.zoomRange[0];
  controls.maxZoom = VIEW.zoomRange[1];
  controls.minDistance = controls.maxDistance = VIEW.distance;
  controls.minAzimuthAngle = deg(VIEW.azimuthRange[0]);
  controls.maxAzimuthAngle = deg(VIEW.azimuthRange[1]);
  controls.minPolarAngle = deg(VIEW.polarRange[0]);
  controls.maxPolarAngle = deg(VIEW.polarRange[1]);
  controls.restThreshold = 0.0005;

  const home = new THREE.Vector3(...VIEW.target);
  const [px, py, pz] = VIEW.panLimit;
  controls.setBoundary(new THREE.Box3(home.clone().sub(new THREE.Vector3(px, py, pz)), home.clone().add(new THREE.Vector3(px, py, pz))));
  controls.boundaryFriction = 0.15;

  const homePosition = (out: THREE.Vector3) =>
    out.setFromSphericalCoords(VIEW.distance, deg(VIEW.polarDeg), deg(VIEW.azimuthDeg)).add(home);

  const p = homePosition(new THREE.Vector3());
  controls.setLookAt(p.x, p.y, p.z, home.x, home.y, home.z, false);

  // Modifier keys let trackpad users tilt / pan with the primary button.
  let leftFree = true;
  const applyLeft = (e?: KeyboardEvent) => {
    if (e?.altKey) controls.mouseButtons.left = A.ROTATE;
    else if (e?.shiftKey) controls.mouseButtons.left = A.TRUCK;
    else controls.mouseButtons.left = leftFree ? A.NONE : A.NONE;
  };
  window.addEventListener('keydown', (e) => applyLeft(e));
  window.addEventListener('keyup', (e) => applyLeft(e));
  window.addEventListener('blur', () => applyLeft());

  const rig: CameraRig = {
    camera,
    controls,
    update(dt) {
      return controls.update(dt);
    },
    resetView(animate = true) {
      const pos = homePosition(new THREE.Vector3());
      void controls.setLookAt(pos.x, pos.y, pos.z, home.x, home.y, home.z, animate);
      void controls.zoomTo(1, animate);
    },
    focusOn(point) {
      void controls.moveTo(point.x, point.y, point.z, true);
    },
    goTo(v) {
      const t = new THREE.Vector3(...v.target);
      const pos = new THREE.Vector3().setFromSphericalCoords(VIEW.distance, deg(v.polarDeg), deg(v.azimuthDeg)).add(t);
      void controls.setLookAt(pos.x, pos.y, pos.z, t.x, t.y, t.z, true);
      void controls.zoomTo(v.zoom, true);
    },
    magnification() {
      return camera.zoom * VIEW.baseMagnification;
    },
    setLeftButtonFree(free) {
      leftFree = free;
      applyLeft();
    },
    setWheelZoom(enabled) {
      controls.mouseButtons.wheel = enabled ? A.ZOOM : A.NONE;
    },
    target(out) {
      return controls.getTarget(out);
    },
  };

  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement)?.closest?.('input, textarea')) return;
    const step = deg(4);
    switch (e.key) {
      case 'ArrowLeft': void controls.rotate(-step, 0, true); break;
      case 'ArrowRight': void controls.rotate(step, 0, true); break;
      case 'ArrowUp': void controls.rotate(0, -step, true); break;
      case 'ArrowDown': void controls.rotate(0, step, true); break;
      case '+': case '=': void controls.zoom(camera.zoom * 0.18, true); break;
      case '-': case '_': void controls.zoom(-camera.zoom * 0.15, true); break;
      case 'f': case 'F': rig.resetView(true); break;
      default: return;
    }
    e.preventDefault();
  });

  return rig;
}
