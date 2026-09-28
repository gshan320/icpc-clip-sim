import { audio } from '../audio/engine';
import { events, toast } from '../state/events';
import { state } from '../state/store';
import { STAGES, type StageContext, type StageDef } from './stages';

export interface TaskView {
  id: string;
  label: string;
  progress: number;
  done: boolean;
  pending?: string;
}

/**
 * Runs the stage sequence. Every frame it evaluates the current stage's sub-tasks from the
 * simulation state; when all are met the stage completes and the next one unlocks. Sticky tasks
 * completed early (e.g. deep arachnoid opened during stage 1) are remembered, so work done out of
 * order is never lost.
 */
export class ProcedureManager {
  readonly stages = STAGES;
  private stickyDone = new Set<string>();
  private completing = false;

  constructor(private ctx: StageContext) {}

  get index(): number {
    return state.stage;
  }

  get current(): StageDef | null {
    return this.stages[state.stage] ?? null;
  }

  tasks(i: number): TaskView[] {
    const def = this.stages[i];
    if (!def) return [];
    return def.tasks.map((t) => {
      const key = `${def.id}:${t.id}`;
      const p = this.stickyDone.has(key) ? 1 : Math.max(0, Math.min(1, t.progress(this.ctx)));
      return { id: t.id, label: t.label(this.ctx), progress: p, done: p >= 1, pending: t.pending };
    });
  }

  guidelines(i: number) {
    const def = this.stages[i];
    return (def?.guidelines ?? []).map((g) => ({ label: g.label(this.ctx), ok: g.ok(this.ctx) }));
  }

  /** Progress of stage i, 0…1. */
  stageProgress(i: number): number {
    if (i < state.stage) return 1;
    const t = this.tasks(i);
    return t.length ? t.reduce((a, b) => a + b.progress, 0) / t.length : 0;
  }

  /** Whole-procedure progress, 0…1. */
  overallProgress(): number {
    const n = this.stages.length;
    return Math.min(1, (state.stage + (state.stage < n ? this.stageProgress(state.stage) : 0)) / n);
  }

  update() {
    // Remember sticky tasks from every stage (current and future) as soon as they are met.
    for (const def of this.stages) {
      for (const t of def.tasks) {
        if (t.sticky && !t.pending && t.progress(this.ctx) >= 1) this.stickyDone.add(`${def.id}:${t.id}`);
      }
    }
    const def = this.current;
    if (!def || this.completing) return;
    const tasks = this.tasks(state.stage);
    if (tasks.length && tasks.every((t) => t.done)) {
      // Small pause so the last checkbox animates before the stage flips.
      this.completing = true;
      setTimeout(() => {
        this.completing = false;
        this.complete();
      }, 700);
    }
  }

  private complete() {
    const def = this.current;
    if (!def) return;
    const i = state.stage;
    state.stageTimes[i] = state.elapsed;
    state.stage = i + 1;
    audio.tick(990, 0.05);
    setTimeout(() => audio.tick(1320, 0.05), 110);
    setTimeout(() => audio.tick(1760, 0.045), 220);
    events.emit('stage:completed', { index: i, title: def.title, time: state.elapsed });
    events.emit('stage:changed', { index: state.stage });
    const next = this.current;
    toast(next ? `Step ${i + 1} complete — next: ${next.title}` : 'All steps complete', 'ok');
  }
}
