import type { ToolId } from './store';

/**
 * Tiny typed event bus. Systems talk to each other through events rather than direct imports,
 * so tools, procedure logic, physics and UI stay decoupled.
 */
export type ToastLevel = 'info' | 'ok' | 'warn' | 'danger';

export interface EventMap {
  'fissure:changed': { open: number };
  'quality:changed': { quality: 'high' | 'low' };
  'sim:started': Record<string, never>;
  'tool:changed': { tool: ToolId | null };
  'arachnoid:cut': { id: string; group: string; method: 'sharp' | 'blunt' };
  'bleeding:started': { id: number; kind: 'ooze' | 'arterial'; label: string };
  'bleeding:stopped': { id: number };
  'spatula:placed': { lobe: 'frontal' | 'temporal' };
  'spatula:removed': { lobe: 'frontal' | 'temporal' };
  'neck:dissection': { progress: number };
  'risk:dome': { amount: number; reason: string };
  'structure:identified': { id: string; label: string; point: { x: number; y: number; z: number } };
  'stage:changed': { index: number };
  'stage:completed': { index: number; title: string; time: number };
  /** The dome wall has been breached (instrument) — rupture now, at this point if given. */
  'aneurysm:breach': { point?: { x: number; y: number; z: number }; reason: string };
  'aneurysm:ruptured': { time: number; reason: string };
  'tempclip:applied': { time: number };
  'tempclip:removed': { time: number; duration: number };
  'alarm:changed': { active: string[] };
  'clip:applied': { type: 'straight' | 'curved'; id: number };
  'clip:removed': { id: number };
  'icg:started': { time: number };
  'icg:finished': { time: number };
  'doppler:heard': { vessel: string; flow: number };
  /** Anaesthesia / code-team actions and cardiac events from the circulation engine. */
  anaesthesia: { text: string; level: 'info' | 'warn' | 'danger' | 'ok' };
  'patient:died': { cause: string; time: number };
  'case:ended': { reason: 'complete' | 'ended' | 'death' };
  toast: { text: string; level: ToastLevel; key?: string };
}

type Handler<T> = (payload: T) => void;

class EventBus {
  private handlers = new Map<keyof EventMap, Set<Handler<unknown>>>();

  on<K extends keyof EventMap>(type: K, handler: Handler<EventMap[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler as Handler<unknown>);
    return () => set!.delete(handler as Handler<unknown>);
  }

  emit<K extends keyof EventMap>(type: K, payload: EventMap[K]): void {
    this.handlers.get(type)?.forEach((h) => h(payload));
  }
}

export const events = new EventBus();

/** Show a short message. `key` de-duplicates repeated warnings for a few seconds. */
export function toast(text: string, level: ToastLevel = 'info', key?: string) {
  events.emit('toast', { text, level, key });
}
