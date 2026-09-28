import * as THREE from 'three';
import { MICROSCOPE } from '../config/sim';

/**
 * Operating-microscope illumination: a bright, warm, nearly coaxial light that travels with the
 * optics (so there are almost no shadows — you see into deep, narrow corridors), plus a dim room
 * environment that gives the wet tissue and steel something to reflect.
 */
export interface MicroscopeLights {
  key: THREE.SpotLight;
  fill: THREE.HemisphereLight;
  update(camera: THREE.PerspectiveCamera, target: THREE.Vector3): void;
  setIntensity(scale: number): void;
}

export function createLights(scene: THREE.Scene, renderer: THREE.WebGLRenderer): MicroscopeLights {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = createMicroscopeEnvironment();
  const env = pmrem.fromScene(envScene, 0.02).texture;
  scene.environment = env;
  scene.environmentIntensity = 0.5;
  pmrem.dispose();

  const key = new THREE.SpotLight(MICROSCOPE.lightColor, MICROSCOPE.lightIntensity, 0, THREE.MathUtils.degToRad(MICROSCOPE.lightAngleDeg), 0.55, 2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.06;
  key.shadow.camera.near = 60;
  key.shadow.camera.far = 320;
  key.shadow.radius = 4;
  scene.add(key, key.target);

  // Very dim warm/cool fill so nothing is pitch black.
  const fill = new THREE.HemisphereLight(0xffe2cc, 0x1a0f0c, 0.06);
  scene.add(fill);

  const offset = new THREE.Vector3(...MICROSCOPE.lightOffset);
  const tmp = new THREE.Vector3();
  const baseIntensity = MICROSCOPE.lightIntensity;

  return {
    key,
    fill,
    update(camera, target) {
      // Light rides with the microscope head, slightly off the optical axis.
      tmp.copy(offset).applyQuaternion(camera.quaternion);
      key.position.copy(camera.position).add(tmp);
      key.target.position.copy(target);
      key.target.updateMatrixWorld();
    },
    setIntensity(scale) {
      key.intensity = baseIntensity * scale;
    },
  };
}

/**
 * Reflection environment: darkness all around with one large, soft, warm glow on the
 * microscope side (+Z) — so wet tissue shows broad soft sheens instead of hard window-shaped
 * reflections.
 */
function createMicroscopeEnvironment(): THREE.Scene {
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 64, 32);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {},
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vDir;
      void main(){
        float front = max(dot(vDir, vec3(0.0, 0.15, 1.0)), 0.0);
        vec3 glow = vec3(1.0, 0.86, 0.72) * (pow(front, 6.0) * 2.2 + pow(front, 1.5) * 0.25);
        vec3 base = vec3(0.035, 0.025, 0.022);
        gl_FragColor = vec4(base + glow, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(geo, mat));
  return scene;
}
