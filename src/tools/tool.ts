import type * as THREE from 'three';
import type { Anatomy } from '../anatomy';
import type { BloodSystem } from '../physics/blood';
import type { FissureModel } from '../physics/fissure';
import type { ToolId } from '../state/store';
import type { InstrumentModel } from './models';

/** What the instrument is currently pointing at. */
export interface Hover {
  object: THREE.Mesh;
  point: THREE.Vector3;
  /** World-space surface normal (facing the camera). */
  normal: THREE.Vector3;
  kind: string;
  id: string;
  label: string;
}

export type StatusLevel = 'ok' | 'warn' | 'danger' | 'idle';

export interface ToolStatus {
  text: string;
  level: StatusLevel;
}

export interface ToolContext {
  anatomy: Anatomy;
  blood: BloodSystem;
  fissure: FissureModel;
  camera: THREE.PerspectiveCamera;
  /** Let a tool take the mouse wheel away from microscope zoom. */
  setWheelZoom(enabled: boolean): void;
}

/** Kinds that are living tissue (can be pushed / deformed by an instrument tip). */
export const TISSUE_KINDS = new Set(['brain', 'vessel', 'aneurysm', 'nerve', 'vein', 'membrane', 'dura']);
export const MAJOR_VESSELS = new Set(['ica', 'm1', 'm2s', 'm2i', 'a1']);

/**
 * Base class for instruments. The ToolManager does picking, cursor placement, highlighting and
 * input routing; a tool only decides what its tip does.
 */
export abstract class Tool {
  abstract readonly id: ToolId;
  abstract readonly name: string;
  /** Number key shortcut. */
  abstract readonly key: string;
  /** Which hand holds it — decides the side it enters the field from. */
  readonly hand: 'left' | 'right' = 'right';
  /** False = shown in the toolbar but arrives in a later milestone. */
  readonly available: boolean = true;
  readonly milestone?: string;
  /** Picking passes through these kinds (e.g. suction ignores the arachnoid veil). */
  readonly ignoreKinds: ReadonlySet<string> = new Set();
  /** How far (mm) the tip pushes into tissue when pressed. */
  pressDepth = 0.35;
  /** How far (mm) the tip hovers above the surface when not pressed. */
  hoverLift = 0.7;
  model: InstrumentModel | null = null;
  pressed = false;
  /** Can this tool pick instruments in the field (spatula blades, placed clips)? */
  readonly pickInstruments: boolean = false;

  /** Extra objects only this tool can pick (e.g. a clip it placed). */
  extraPickables(): THREE.Object3D[] {
    return [];
  }

  /** Custom cursor orientation; return true if handled (the manager then skips its own). */
  orientModel(_root: THREE.Object3D, _h: Hover | null): boolean {
    return false;
  }

  constructor(protected ctx: ToolContext) {}

  abstract status(h: Hover | null): ToolStatus;

  /** Does pressing here physically push on tissue? */
  deforms(h: Hover | null): boolean {
    return this.pressed && !!h && TISSUE_KINDS.has(h.kind);
  }

  activate(): void {}
  deactivate(): void {}
  onDown(_h: Hover | null): void {}
  onUp(_h: Hover | null): void {}
  onHold(_h: Hover | null, _dt: number, _tipSpeed: number): void {}
  onDrag(_dx: number, _dy: number, _h: Hover | null): void {}
  /** Return true if the wheel was consumed. */
  onWheel(_deltaY: number, _h: Hover | null): boolean {
    return false;
  }
  /** Return true if the key was consumed. */
  onKey(_key: string, _h: Hover | null): boolean {
    return false;
  }
  update(_dt: number, _h: Hover | null): void {}
}
