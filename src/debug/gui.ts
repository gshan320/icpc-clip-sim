import GUI from 'lil-gui';
import * as THREE from 'three';
import type { Anatomy } from '../anatomy';
import { cutPatch } from '../anatomy/arachnoid';
import { tissueGlobals } from '../anatomy/materials';
import type { BloodSystem } from '../physics/blood';
import type { FissureModel } from '../physics/fissure';
import type { MicroscopeLights } from '../scene/lights';
import type { PostFX } from '../scene/postfx';
import { state } from '../state/store';

/** Live tuning panel, enabled with `?debug` in the URL. */
export function createDebugGui(opts: {
  anatomy: Anatomy;
  fissure: FissureModel;
  blood: BloodSystem;
  fx: () => PostFX;
  lights: MicroscopeLights;
  setQuality: (q: 'high' | 'low') => void;
}) {
  const { anatomy, fissure, blood, fx, lights, setQuality } = opts;
  const gui = new GUI({ title: 'Debug / tuning' });
  const params = {
    overrideFissure: false,
    fissureOpen: state.fissureOpen,
    heartRate: state.heartRate,
    pulseGain: tissueGlobals.uPulseGain.value,
    quality: state.quality,
    showArachnoid: true,
    light: 1,
    focusRange: fx().dof.cocMaterial.focusRange,
    bokeh: fx().dof.bokehScale,
    bloom: fx().bloom.intensity,
    field: fx().microscope.fieldRadius,
    ao: fx().ao?.enabled ?? false,
    cutSuperficial: () => {
      for (const p of anatomy.arachnoid.values()) {
        if (p.config.group === 'sylvian-superficial' || p.config.group === 'sylvian-deep') cutPatch(p, p.mesh.getWorldPosition(new THREE.Vector3()));
      }
    },
    spawnOoze: () => {
      // A bleeding point on the frontal lip, near the centre of the field.
      const lobe = anatomy.frontal;
      const ray = new THREE.Raycaster(new THREE.Vector3(6, -2, 60), new THREE.Vector3(0, 0.25, -1).normalize());
      const hit = ray.intersectObject(lobe.mesh, false)[0];
      if (hit && hit.face) {
        const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        blood.addOoze({ object: hit.object, point: hit.point, normal: n, kind: 'arterial', rate: 0.12, label: 'Debug bleeder' });
      }
    },
    addBlood: () => {
      blood.volume += 3;
    },
  };
  const a = gui.addFolder('Anatomy');
  a.add(params, 'overrideFissure').name('Override fissure').onChange((v: boolean) => (fissure.override = v ? params.fissureOpen : null));
  a.add(params, 'fissureOpen', 0, 1, 0.01).name('Fissure open').onChange((v: number) => {
    if (params.overrideFissure) fissure.override = v;
  });
  a.add(params, 'showArachnoid').name('Arachnoid').onChange((v: boolean) => {
    for (const p of anatomy.arachnoid.values()) p.mesh.visible = v && !p.cut;
  });
  a.add(params, 'cutSuperficial').name('Cut sylvian arachnoid');
  const b = gui.addFolder('Bleeding');
  b.add(params, 'spawnOoze').name('Spawn bleeding point');
  b.add(params, 'addBlood').name('Add 3 mL to field');
  const p = gui.addFolder('Physiology');
  p.add(params, 'heartRate', 40, 160, 1).name('Heart rate').onChange((v: number) => (state.heartRate = v));
  p.add(params, 'pulseGain', 0, 4, 0.1).name('Pulsation ×').onChange((v: number) => (tissueGlobals.uPulseGain.value = v));
  const o = gui.addFolder('Optics');
  o.add(params, 'quality', ['high', 'low']).name('Quality').onChange((v: 'high' | 'low') => setQuality(v));
  o.add(params, 'light', 0.2, 3, 0.05).name('Light').onChange((v: number) => lights.setIntensity(v));
  o.add(params, 'focusRange', 1, 40, 0.5).name('Focus range mm').onChange((v: number) => (fx().dof.cocMaterial.focusRange = v));
  o.add(params, 'bokeh', 0, 8, 0.1).name('Bokeh').onChange((v: number) => (fx().dof.bokehScale = v));
  o.add(params, 'bloom', 0, 3, 0.05).name('Bloom').onChange((v: number) => (fx().bloom.intensity = v));
  o.add(params, 'field', 0.3, 0.8, 0.005).name('Field stop').onChange((v: number) => (fx().microscope.fieldRadius = v));
  o.add(params, 'ao').name('Ambient occlusion').onChange((v: boolean) => fx().setAO(v));
  gui.close();
  return gui;
}
