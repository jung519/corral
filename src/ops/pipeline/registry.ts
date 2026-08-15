/**
 * The set of pipelines this core knows about.
 *
 * Deliberately thin. It holds definitions and answers "which ones should be running" —
 * it does not run anything (run.ts) and does not decide when (the trigger adapters).
 *
 * `enabled` toggles live in memory only. The persisted value is the one in the pipeline's
 * own file, and the file is the operator's; a toggle written back would mean this class
 * rewriting YAML someone hand-edited. Persisting a disable belongs with the editor that
 * owns those files.
 */
import { logger } from '../../core/logger.js';
import type { Pipeline } from './schema.js';

export class PipelineRegistry {
  private readonly byKey = new Map<string, Pipeline>();
  /** Keys turned off at runtime, separate from what the file says. */
  private readonly disabled = new Set<string>();

  /** Add or replace one definition. */
  register(pipeline: Pipeline): void {
    this.byKey.set(pipeline.key, pipeline);
  }

  /**
   * Swap in a freshly loaded set. Runtime toggles for pipelines that are still here
   * survive — reloading definitions off disk shouldn't quietly restart something an
   * operator turned off ten minutes ago.
   */
  replaceAll(pipelines: Pipeline[]): void {
    const keys = new Set(pipelines.map((p) => p.key));
    for (const key of [...this.disabled]) if (!keys.has(key)) this.disabled.delete(key);
    this.byKey.clear();
    for (const p of pipelines) this.byKey.set(p.key, p);
    logger.info(`pipelines loaded: ${pipelines.length} (${this.active().length} active)`);
  }

  get(key: string): Pipeline | undefined {
    return this.byKey.get(key);
  }

  /** Everything registered, enabled or not — what the UI lists. */
  all(): Pipeline[] {
    return [...this.byKey.values()];
  }

  /** Only those that should actually run. */
  active(): Pipeline[] {
    return this.all().filter((p) => this.isEnabled(p.key));
  }

  isEnabled(key: string): boolean {
    return !!this.byKey.get(key)?.enabled && !this.disabled.has(key);
  }

  /** Turn a pipeline on or off for this process. Unknown keys return false. */
  setEnabled(key: string, enabled: boolean): boolean {
    const pipeline = this.byKey.get(key);
    if (!pipeline) return false;
    if (enabled) this.disabled.delete(key);
    else this.disabled.add(key);
    // A pipeline disabled in its own file stays off — the runtime toggle can suppress,
    // never override.
    return this.isEnabled(key);
  }

  get size(): number {
    return this.byKey.size;
  }
}
