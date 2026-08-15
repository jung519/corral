/**
 * The operational AI, assembled.
 *
 * Holds the registry, the runner and the history, and exposes the one entry point that
 * exists before any trigger does: **run this pipeline, now, with this body.** That is
 * how a pipeline gets tried out while it's being written, and how a failed one gets
 * reprocessed afterwards.
 */
import { logger } from '../core/logger.js';
import { JsonlOpsHistoryStore } from './history/jsonl-store.js';
import type { OpsHistoryStore } from './history/store.js';
import { NoneInputResolver } from './input/none.js';
import { NoneOutputSink } from './output/none.js';
import { loadPipelines, pipelinesDir, PipelineLoadError } from './pipeline/loader.js';
import type { AnswerValidator, InputResolver, OperationRunner, OutputSink } from './pipeline/ports.js';
import { PipelineRegistry } from './pipeline/registry.js';
import { PipelineRunner, type RunRecord } from './pipeline/run.js';

/**
 * Stands in for the real one-turn runner until it lands. It fails loudly rather than
 * pretending: a run that reaches this ends as `agent_failed` with a reason saying so,
 * which is exactly what an operator should see for a step nothing is wired to yet.
 */
export class UnwiredOperationRunner implements OperationRunner {
  async run(): Promise<never> {
    throw new Error('the AI step is not wired up yet — a pipeline cannot run past its prompt');
  }
}

/**
 * Stands in for the rule engine. Passes an answer through only when the pipeline asked
 * for no checks; a pipeline that declares rules is refused instead.
 *
 * The alternative — passing everything — would mean that whenever the model step is wired
 * before the rules are, every declared rule silently does nothing. "Don't trust the AI" is
 * the point of having them, so failing closed is the only safe placeholder.
 */
export class UnwiredAnswerValidator implements AnswerValidator {
  async check(step: { validate?: Record<string, unknown> }, answer: Record<string, unknown>) {
    const rules = Object.keys(step.validate ?? {});
    if (!rules.length) return { ok: true as const, answer };
    return { ok: false as const, reasons: [`validation rules are not implemented yet (${rules.join(', ')})`] };
  }
}

export interface OpsHostOptions {
  stateDir: string;
  /** Swap in real steps as they land. */
  operation?: OperationRunner;
  validator?: AnswerValidator;
  resolvers?: InputResolver[];
  sinks?: OutputSink[];
  history?: OpsHistoryStore;
  now?: () => number;
}

export interface ManualRunResult {
  ok: boolean;
  /** Absent only when the pipeline key was unknown. */
  run?: RunRecord;
  error?: string;
}

export class OpsHost {
  readonly registry = new PipelineRegistry();
  readonly history: OpsHistoryStore;
  private readonly runner: PipelineRunner;
  /** Swapped in when a config arrives — see `useOperation`. */
  private operation: OperationRunner;
  private readonly dir: string;
  /** Why the last load failed, so the UI can show it instead of an empty list. */
  private loadError?: string;

  constructor(private readonly options: OpsHostOptions) {
    this.dir = pipelinesDir(options.stateDir);
    this.history = options.history ?? new JsonlOpsHistoryStore(options.stateDir, { now: options.now });
    this.operation = options.operation ?? new UnwiredOperationRunner();
    this.runner = new PipelineRunner({
      resolvers: new Map((options.resolvers ?? [new NoneInputResolver()]).map((r) => [r.kind, r])),
      sinks: new Map((options.sinks ?? [new NoneOutputSink()]).map((s) => [s.kind, s])),
      // Read through, so a provider swap takes effect without rebuilding the runner.
      operation: { run: (step, fields) => this.operation.run(step, fields) },
      validator: options.validator ?? new UnwiredAnswerValidator(),
      now: options.now,
    });
  }

  /**
   * Point the model step at these providers. Called when a config is loaded — the
   * operational AI starts before there is one (it needs no config of its own), and the
   * providers only become known once the development side has read theirs.
   */
  useOperation(operation: OperationRunner): void {
    this.operation = operation;
  }

  /**
   * Re-read the definitions. A broken set is reported, not thrown: the core has to keep
   * serving so the operator can see *why* and fix it — and the pipelines that were
   * already loaded keep running meanwhile.
   */
  async load(): Promise<{ loaded: number; error?: string }> {
    try {
      const pipelines = await loadPipelines(this.dir);
      this.registry.replaceAll(pipelines);
      this.loadError = undefined;
      return { loaded: pipelines.length };
    } catch (err) {
      this.loadError = err instanceof PipelineLoadError ? err.message : String(err);
      logger.error(`ops: ${this.loadError}`);
      return { loaded: this.registry.size, error: this.loadError };
    }
  }

  get error(): string | undefined {
    return this.loadError;
  }

  /** What the operational dashboard lists. */
  list(): Array<{ key: string; description?: string; enabled: boolean; trigger: string; activeRuns: number }> {
    return this.registry.all().map((p) => ({
      key: p.key,
      description: p.description,
      enabled: this.registry.isEnabled(p.key),
      trigger: p.trigger.kind,
      activeRuns: this.runner.activeCount(p.key),
    }));
  }

  /**
   * Run one pipeline against a body supplied by the caller.
   *
   * A disabled pipeline still runs here. Disabling stops the *trigger* — a person asking
   * for this run by hand has already decided, and refusing them would make it impossible
   * to test a pipeline before switching it on.
   */
  async runManually(key: string, input: unknown): Promise<ManualRunResult> {
    const pipeline = this.registry.get(key);
    if (!pipeline) return { ok: false, error: `no pipeline named "${key}"` };

    const run = await this.runner.run(pipeline, input ?? {});
    // Recorded whatever happened. A history with only the successes in it would be
    // useless for the thing history is for.
    await this.history.append(run).catch((err: unknown) => {
      logger.warn(`ops: could not record run ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
    });
    return { ok: run.outcome === 'completed', run };
  }
}

/** Build the operational AI and load whatever definitions are on disk. */
export async function startOpsHost(options: OpsHostOptions): Promise<OpsHost> {
  const host = new OpsHost(options);
  await host.load();
  await host.history.prune().catch(() => 0);
  return host;
}
