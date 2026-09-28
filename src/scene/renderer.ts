import * as THREE from 'three';

export function createRenderer(container: HTMLElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    antialias: false, // MSAA is done by the post-processing composer
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
    alpha: false,
  });
  renderer.setClearColor(0x050607, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Tone mapping happens in the post-processing chain.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);
  renderer.domElement.classList.add('gl');
  return renderer;
}
