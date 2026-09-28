import * as THREE from 'three';

/**
 * Endoscope picture-in-picture. A 2.7 mm 30° endoscope slipped beside the aneurysm looks at the
 * back of the neck — where the PCom, perforators and the clip tips hide from the microscope.
 *
 * Rendered to its own HDR target with its own light, then tone-mapped (ACES) and masked to the
 * round endoscopic image in a small overlay pass, so it never disturbs the microscope pipeline.
 */
export class EndoscopeView {
  readonly camera = new THREE.PerspectiveCamera(78, 4 / 3, 0.25, 120);
  readonly light = new THREE.PointLight(0xfff4ea, 0, 25, 2);
  active = false;
  private rt = new THREE.WebGLRenderTarget(480, 360, { type: THREE.HalfFloatType, samples: 4 });
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private fade = 0;
  private mat: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene) {
    // Layers: 0 = scene, 1 = endoscope shaft (only the microscope sees it),
    // 2 = endoscope light (only the endoscope uses it).
    this.camera.layers.set(0);
    this.camera.layers.enable(2);
    this.light.layers.set(2);
    this.camera.add(this.light);
    scene.add(this.camera);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { tex: { value: this.rt.texture }, fade: { value: 0 }, aspect: { value: 4 / 3 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        uniform sampler2D tex; uniform float fade; uniform float aspect; varying vec2 vUv;
        vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
        void main(){
          vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
          float r = length(p);
          // Slight barrel distortion of a wide-angle rod lens.
          vec2 uv = 0.5 + (vUv - 0.5) * (1.0 - 0.12 * r * r);
          vec3 c = aces(texture2D(tex, uv).rgb * 1.25);
          c = pow(c, vec3(1.0 / 2.2));
          float mask = 1.0 - smoothstep(0.44, 0.47, r);
          float vig = 1.0 - 0.55 * smoothstep(0.1, 0.47, r);
          gl_FragColor = vec4(c * vig * mask * fade, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat));
  }

  /** Place the tip at `tip`, looking at `target`. */
  insert(tip: THREE.Vector3, target: THREE.Vector3) {
    this.camera.position.copy(tip);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld();
    this.active = true;
  }

  withdraw() {
    this.active = false;
  }

  /** Render into `rect` (CSS px, origin top-left) after the main frame. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, rect: { x: number; y: number; w: number; h: number }, dt: number) {
    this.fade += ((this.active ? 1 : 0) - this.fade) * (1 - Math.exp(-dt * 6));
    this.light.intensity = this.active ? 7 : 0;
    if (this.fade < 0.01) return;
    const prevTarget = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    const autoShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    const fog = scene.fog;
    scene.fog = null;
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x050303, 1);
    renderer.clear();
    renderer.render(scene, this.camera);
    scene.fog = fog;
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.autoUpdate = autoShadow;
    // Overlay into the PiP rectangle.
    const size = renderer.getSize(new THREE.Vector2());
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    const y = size.y - rect.y - rect.h;
    renderer.setViewport(rect.x, y, rect.w, rect.h);
    renderer.setScissor(rect.x, y, rect.w, rect.h);
    this.mat.uniforms.fade.value = this.fade;
    this.mat.uniforms.aspect.value = rect.w / rect.h;
    renderer.render(this.quadScene, this.quadCam);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, size.x, size.y);
    renderer.autoClear = autoClear;
    renderer.setClearColor(0x050607, 1);
  }
}
