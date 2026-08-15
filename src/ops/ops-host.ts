/**
 * The operational AI, assembled.
 *
 * Holds the registry, the runner and the history, and exposes the one entry point that
 * exists before any trigger does: **run this pipeline, now, with this body.** That is
 * how a pipeline gets tried out while it's being written, and how a failed one gets
 * reprocessed afterwards.
 */
import { logger } from '../core/logger.js';
import type { CredentialStore } from '../credentials/types.js';
import type { TokenBudget } from '../core/token-budget.js';
import { JsonlOpsHistoryStore } from './history/jsonl-store.js';
import type { OpsHistoryStore } from './history/store.js';
import { NoneInputResolver } from './input/none.js';
import { NoneOutputSink } from './output/none.js';
import { loadPipelines, pipelinesDir, PipelineLoadError } from './pipeline/loader.js';
import type { AnswerValidator, InputResolver, OperationRunner, OutputSink } from './pipeline/ports.js';
import { PipelineRegistry } from './pipeline/registry.js';
import { PipelineRunner, type RunRecord } from './pipeline/run.js';
import { triggerRegistry } from './trigger/index.js';
import type { StopFn } from './trigger/types.js';
import { RuleAnswerValidator } from './validate/rules.js';

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

export interface OpsHostOptions {
  stateDir: string;
  /** Resolves credentials named by a pipeline (vocabulary fetches, input, output). */
  credentials?: CredentialStore;
  /** Daily token ceiling, shared with the development AI. */
  budget?: TokenBudget;
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
  private budget?: TokenBudget;
  private readonly dir: string;
  /** Live subscriptions, by pipeline key. Present only while a pipeline is enabled. */
  private readonly subscriptions = new Map<string, StopFn>();
  /** Why the last load failed, so the UI can show it instead of an empty list. */
  private loadError?: string;

  constructor(private readonly options: OpsHostOptions) {
    this.dir = pipelinesDir(options.stateDir);
    this.history = options.history ?? new JsonlOpsHistoryStore(options.stateDir, { now: options.now });
    this.operation = options.operation ?? new UnwiredOperationRunner();
    this.budget = options.budget;
    this.runner = new PipelineRunner({
      resolvers: new Map((options.resolvers ?? [new NoneInputResolver()]).map((r) => [r.kind, r])),
      sinks: new Map((options.sinks ?? [new NoneOutputSink()]).map((s) => [s.kind, s])),
      // Read through, so a provider swap takes effect without rebuilding the runner.
      operation: { run: (step, fields) => this.operation.run(step, fields) },
      validator: options.validator ?? new RuleAnswerValidator({ credentials: options.credentials, now: options.now }),
      // Read through, like `operation` — the config that carries the limits arrives after
      // the operational AI has started.
      budget: { check: () => this.budget?.check() ?? { ok: true }, record: (u) => this.budget?.record(u) },
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

  /** Point the ceiling check at this counter — same reason as `useOperation`: the limits
   *  live in the config, which arrives after the operational AI has started. */
  useBudget(budget: TokenBudget): void {
    this.budget = budget;
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
      this.syncSubscriptions();
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

  /**
   * Bring the running subscriptions in line with what is enabled.
   *
   * Called after a load and after any toggle, so "disabled" means the trigger actually
   * stops rather than the runs being refused one at a time — a timer that outlives its
   * pipeline is work nobody asked for.
   */
  syncSubscriptions(): void {
    for (const [key, stop] of this.subscriptions) {
      if (this.registry.isEnabled(key)) continue;
      void stop();
      this.subscriptions.delete(key);
      logger.info(`ops: pipeline "${key}" stopped`);
    }

    for (const pipeline of this.registry.active()) {
      if (this.subscriptions.has(pipeline.key)) continue;
      try {
        const adapter = triggerRegistry.create(pipeline.trigger, { now: this.options.now });
        this.subscriptions.set(pipeline.key, adapter.start(pipeline, (event) => this.fire(pipeline.key, event)));
      } catch (err) {
        // An unknown kind must not stop the others from running.
        logger.error(`ops: could not start the trigger for "${pipeline.key}" — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** What a trigger calls. Identical to a manual run — one path into the lifecycle. */
  private async fire(key: string, event: unknown): Promise<RunRecord | undefined> {
    return (await this.runManually(key, event)).run;
  }

  /** Stop every subscription. Called when the core shuts down. */
  async stop(): Promise<void> {
    for (const [key, stopFn] of this.subscriptions) {
      await stopFn();
      this.subscriptions.delete(key);
    }
  }

  /** Pipelines with a live subscription right now. */
  running(): string[] {
    return [...this.subscriptions.keys()];
  }

  /** The day's shared token usage, or undefined when no ceiling is wired yet. Reading it
   *  is how an operator (and, later, the dashboard) sees why work has paused. */
  budgetSnapshot(): ReturnType<TokenBudget['snapshot']> | undefined {
    return this.budget?.snapshot();
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
