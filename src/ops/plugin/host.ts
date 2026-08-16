/**
 * Loading a step someone wrote in code.
 *
 * Some pipelines cannot be declared. A vocabulary that needs a lookup table, an input
 * that has to join two systems, a check that encodes a rule no schema will ever express —
 * those exist, and a tool that has no answer for them gets abandoned at exactly the moment
 * it was starting to be useful. So the escape hatch was designed in from the start (D9)
 * rather than bolted on after someone hit the wall.
 *
 * **A plugin is not a new kind of thing.** It implements the same four ports the built-in
 * steps do (`pipeline/ports.ts`), which is why it costs nothing in the rest of the system:
 * the budget check, `skip_if`, `require`, the history record and the failure outcomes all
 * live in the lifecycle, not in the adapters. Replacing one step changes that step and
 * nothing else.
 *
 * **Modules live under the plugins folder and are addressed by file name.** Not an
 * arbitrary path: a definition should mean the same thing on another machine, and a
 * pipeline file that reaches into `/etc` is a definition you cannot move or review.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from '../../core/logger.js';
import type { PluginRef } from '../pipeline/schema.js';

export const PLUGINS_DIR = 'plugins';

/** The plugins directory for a given state directory. */
export function pluginsDir(stateDir: string): string {
  return join(stateDir, PLUGINS_DIR);
}

/**
 * What a plugin module looks like: a default export that takes the definition's `options`
 * and returns the adapter.
 *
 * A factory rather than the adapter itself, so one module can serve several pipelines
 * with different settings — and so a plugin that needs to set something up does it once,
 * when it is built, not on every run.
 */
export type PluginFactory<T> = (options: Record<string, unknown>) => T | Promise<T>;

export class PluginHost {
  /** By `module:options` — a plugin is built once and reused across runs. */
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string) {}

  /**
   * Build the adapter a reference names.
   *
   * `expect` is the shape check: a module that exports something else fails here, with
   * its file name, rather than at 3am as an undefined function call inside a run.
   */
  async build<T>(ref: PluginRef, expect: (value: unknown) => value is T, what: string): Promise<T> {
    const key = `${ref.module}:${JSON.stringify(ref.options)}`;
    let pending = this.cache.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = this.load(ref, expect, what);
      this.cache.set(key, pending);
      // A failed build must not be remembered as a failure forever — the operator will
      // fix the file and press reload.
      pending.catch(() => this.cache.delete(key));
    }
    return pending;
  }

  private async load<T>(ref: PluginRef, expect: (value: unknown) => value is T, what: string): Promise<T> {
    if (isAbsolute(ref.module) || ref.module.includes('..')) {
      throw new Error(`plugin "${ref.module}" must be a file name inside the plugins folder`);
    }
    const path = resolve(this.dir, ref.module);
    if (!existsSync(path)) throw new Error(`no plugin file at ${path}`);

    const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
    const factory = mod.default;
    if (typeof factory !== 'function') {
      throw new Error(`plugin "${ref.module}" must default-export a function taking options`);
    }

    const built: unknown = await (factory as PluginFactory<unknown>)(ref.options);
    if (!expect(built)) throw new Error(`plugin "${ref.module}" did not return a usable ${what}`);

    logger.info(`ops: loaded ${what} plugin "${ref.module}"`);
    return built;
  }

  /** Forget everything, so edited files are picked up on the next run. */
  clear(): void {
    this.cache.clear();
  }
}

// ── shape checks ──────────────────────────────────────────────────────────────────
// Structural, not `instanceof`: a plugin is a separate module and may not share a class
// identity with anything here.

const hasMethod = (value: unknown, name: string): boolean =>
  typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)[name] === 'function';

export const isInputResolver = (v: unknown): v is import('../pipeline/ports.js').InputResolver => hasMethod(v, 'resolve');
export const isOperationRunner = (v: unknown): v is import('../pipeline/ports.js').OperationRunner => hasMethod(v, 'run');
export const isAnswerValidator = (v: unknown): v is import('../pipeline/ports.js').AnswerValidator => hasMethod(v, 'check');
export const isOutputSink = (v: unknown): v is import('../pipeline/ports.js').OutputSink => hasMethod(v, 'send');
