import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { FISSURE, LOBES, SPATULAS } from '../config/anatomy';
import { tissueGlobals } from './materials';
import { buildAneurysm, type Aneurysm } from './aneurysm';
import { buildArachnoid, updateArachnoidGap, type ArachnoidPatch } from './arachnoid';
import { buildLobes, type Lobe } from './lobes';
import { buildNerves, type Nerve } from './nerves';
import { buildSpatula, type Spatula } from './spatula';
import { buildSurroundings } from './surroundings';
import {
  makeArachnoidTextures,
  makeBoneTextures,
  makeCortexTextures,
  makeMembraneTextures,
  makeNerveTextures,
  makeVesselTextures,
} from './textures';
import { buildVessels, type Vessel } from './vessels';

// Fast BVH raycasting for every mesh (used by autofocus and, later, all tools).
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export interface Anatomy {
  root: THREE.Group;
  frontal: Lobe;
  temporal: Lobe;
  vessels: Map<string, Vessel>;
  aneurysm: Aneurysm;
  nerves: Map<string, Nerve>;
  arachnoid: Map<string, ArachnoidPatch>;
  spatulas: Spatula[];
  /** Opaque meshes that can be picked (and focused on). */
  solids: THREE.Mesh[];
  /** Current fissure gap (mm) and lip flare (mm). */
  gap: number;
  flare: number;
  /** Current opening 0…1. */
  open: number;
  setFissureOpen(open: number): void;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export async function buildAnatomy(onProgress: (fraction: number, label: string) => void): Promise<Anatomy> {
  const step = async (f: number, label: string) => {
    onProgress(f, label);
    await nextFrame();
  };

  await step(0.02, 'Painting cortex and pia');
  const cortex = makeCortexTextures();
  await step(0.22, 'Painting vessel walls');
  const vesselTex = makeVesselTextures();
  const nerveTex = makeNerveTextures();
  await step(0.34, 'Weaving arachnoid');
  const arachTex = makeArachnoidTextures();
  const bone = makeBoneTextures();
  const membrane = makeMembraneTextures();

  await step(0.46, 'Shaping frontal and temporal lobes');
  const root = new THREE.Group();
  root.name = 'anatomy';
  const { frontal, temporal } = buildLobes(cortex, vesselTex);
  root.add(frontal.group, temporal.group);

  await step(0.64, 'Building arteries');
  const { group: vesselGroup, vessels } = buildVessels(vesselTex);
  root.add(vesselGroup);
  const aneurysm = buildAneurysm(vessels.get('ica')!, vesselTex);
  root.add(aneurysm.mesh);

  await step(0.76, 'Cranial nerves and skull base');
  const { group: nerveGroup, nerves } = buildNerves(nerveTex);
  root.add(nerveGroup);
  root.add(buildSurroundings({ bone, membrane, cortex }));

  await step(0.86, 'Arachnoid and spatulas');
  const { group: arachGroup, patches } = buildArachnoid(arachTex);
  root.add(arachGroup);
  const spatulas = [buildSpatula(frontal, SPATULAS.frontalTip), buildSpatula(temporal, SPATULAS.temporalTip)];

  const solids: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const kind = m.userData.kind as string | undefined;
    if (!kind || kind === 'arachnoid') return;
    if (!m.geometry.boundsTree) m.geometry.computeBoundsTree();
    solids.push(m);
  });

  const anatomy: Anatomy = {
    root,
    frontal,
    temporal,
    vessels,
    aneurysm,
    nerves,
    arachnoid: patches,
    spatulas,
    solids,
    gap: FISSURE.closedGap,
    flare: 0,
    open: 0,
    setFissureOpen(open: number) {
      const t = THREE.MathUtils.clamp(open, 0, 1);
      // Ease so the lobes "give" quickly at first, then need more retraction.
      const eased = 1 - Math.pow(1 - t, 1.6);
      const gap = THREE.MathUtils.lerp(FISSURE.closedGap, FISSURE.openGap, eased);
      this.open = t;
      this.gap = gap;
      this.flare = FISSURE.lipFlare * eased;
      frontal.group.position.set(LOBES.frontal.center[0], LOBES.frontal.center[1] + gap / 2, LOBES.frontal.center[2]);
      temporal.group.position.set(LOBES.temporal.center[0], LOBES.temporal.center[1] - gap / 2, LOBES.temporal.center[2]);
      tissueGlobals.uFlare.value = this.flare;
      tissueGlobals.uFlareHalfGap.value = Math.max(0, gap / 2);
      tissueGlobals.uFlareZ0.value = FISSURE.flareZ[0];
      tissueGlobals.uFlareZ1.value = FISSURE.flareZ[1];
      updateArachnoidGap(patches, gap, this.flare);
    },
  };
  anatomy.setFissureOpen(FISSURE.initialOpen);
  // If we start with the fissure open (debug / preview), the superficial arachnoid is already cut.
  if (FISSURE.initialOpen > 0.85) {
    for (const p of patches.values()) {
      if (p.config.group === 'sylvian-superficial') {
        p.cut = true;
        p.mesh.visible = false;
      }
    }
  }
  await step(0.95, 'Compiling shaders');
  return anatomy;
}
