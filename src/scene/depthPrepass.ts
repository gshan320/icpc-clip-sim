import * as THREE from 'three';

/**
 * Depth-only render of the opaque anatomy at reduced resolution. The blood pool samples it to
 * know how deep the blood is over each pixel of tissue (Beer–Lambert style shading: a thin film
 * is translucent crimson, a deep pool is dark and opaque, and edges fade softly into the tissue
 * instead of cutting a hard line).
 */
export class DepthPrepass {
  readonly target: THREE.WebGLRenderTarget;
  private material = new THREE.MeshBasicMaterial({ colorWrite: false });
  private size = new THREE.Vector2();

  constructor(private scale = 0.5) {
    this.target = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: true, stencilBuffer: false });
    this.target.depthTexture = new THREE.DepthTexture(4, 4, THREE.UnsignedIntType);
    this.target.depthTexture.minFilter = this.target.depthTexture.magFilter = THREE.NearestFilter;
  }

  get texture(): THREE.DepthTexture {
    return this.target.depthTexture!;
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, hide: THREE.Object3D[]) {
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(4, Math.floor(this.size.x * this.scale));
    const h = Math.max(4, Math.floor(this.size.y * this.scale));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);

    const vis = hide.map((o) => o.visible);
    hide.forEach((o) => (o.visible = false));
    const override = scene.overrideMaterial;
    const background = scene.background;
    const autoShadow = renderer.shadowMap.autoUpdate;
    scene.overrideMaterial = this.material;
    scene.background = null;
    renderer.shadowMap.autoUpdate = false;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.clear(false, true, false);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prev);
    renderer.shadowMap.autoUpdate = autoShadow;
    scene.background = background;
    scene.overrideMaterial = override;
    hide.forEach((o, i) => (o.visible = vis[i]));
  }
}
