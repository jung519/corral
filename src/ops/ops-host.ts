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
import type { OpsHistoryStore, OpsPipelineCounts } from './history/store.js';
import { HttpInputResolver } from './input/http.js';
import { NoneInputResolver } from './input/none.js';
import { HttpOutputSink } from './output/http.js';
import { NoneOutputSink } from './output/none.js';
import { PubSubOutputSink } from './output/pubsub.js';
import { loadPipelines, pipelinesDir, PipelineLoadError } from './pipeline/loader.js';
import { savePipeline, type SaveResult } from './pipeline/writer.js';
import type { AnswerValidator, InputResolver, OperationRunner, OutputSink } from './pipeline/ports.js';
import { PipelineRegistry } from './pipeline/registry.js';
import { PipelineRunner, type RunRecord } from './pipeline/run.js';
import { PluginHost, pluginsDir } from './plugin/host.js';
import { PluginStepProvider } from './plugin/steps.js';
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
  /** Code-written steps, built once and reused. */
  private readonly pluginHost: PluginHost;
  /** Live subscriptions, by pipeline key. Present only while a pipeline is enabled. */
  private readonly subscriptions = new Map<string, StopFn>();
  /** Why the last load failed, so the UI can show it instead of an empty list. */
  private loadError?: string;

  constructor(private readonly options: OpsHostOptions) {
    this.dir = pipelinesDir(options.stateDir);
    this.pluginHost = new PluginHost(pluginsDir(options.stateDir));
    this.history = options.history ?? new JsonlOpsHistoryStore(options.stateDir, { now: options.now });
    this.operation = options.operation ?? new UnwiredOperationRunner();
    this.budget = options.budget;
    this.runner = new PipelineRunner({
      resolvers: new Map(
        (options.resolvers ?? [new NoneInputResolver(), new HttpInputResolver(options.credentials)]).map((r) => [r.kind, r]),
      ),
      sinks: new Map(
        (
          options.sinks ?? [
            new NoneOutputSink(),
            new HttpOutputSink(options.credentials),
            new PubSubOutputSink(options.credentials, options.now),
          ]
        ).map((s) => [s.kind, s]),
      ),
      // Read through, so a provider swap takes effect without rebuilding the runner.
      operation: { run: (step, fields) => this.operation.run(step, fields) },
      validator: options.validator ?? new RuleAnswerValidator({ credentials: options.credentials, now: options.now }),
      // Read through, like `operation` — the config that carries the limits arrives after
      // the operational AI has started.
      budget: { check: () => this.budget?.check() ?? { ok: true }, record: (u) => this.budget?.record(u) },
      plugins: new PluginStepProvider(this.pluginHost),
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
      // Reloading definitions also forgets built plugins: an operator who edited a
      // definition may well have edited the code beside it.
      this.pluginHost.clear();
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
        const adapter = triggerRegistry.create(pipeline.trigger, { now: this.options.now, credentials: this.options.credentials });
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
  list(): Array<{
    key: string;
    description?: string;
    enabled: boolean;
    trigger: string;
    /** The provider the pipeline names, or undefined to follow the app's setting. */
    provider?: string;
    activeRuns: number;
  }> {
    return this.registry.all().map((p) => ({
      key: p.key,
      description: p.description,
      enabled: this.registry.isEnabled(p.key),
      trigger: p.trigger.kind,
      provider: p.agent.provider,
      activeRuns: this.runner.activeCount(p.key),
    }));
  }

  /**
   * Everything the operations dashboard shows, in one answer.
   *
   * One call rather than three: the screen polls, and a dashboard that made a round trip
   * per panel would triple its own cost to show numbers that all describe the same
   * moment. The budget rides along because the ceiling is shared with the development AI
   * — usage can climb while every pipeline here sits idle, so it has to be on screen even
   * when nothing on this screen caused it.
   */
  async overview(): Promise<{
    pipelines: ReturnType<OpsHost['list']>;
    counts: Record<string, OpsPipelineCounts>;
    budget?: ReturnType<TokenBudget['snapshot']>;
    error?: string;
  }> {
    const counts = await this.history.countsByPipeline(1).catch(() => ({}));
    return { pipelines: this.list(), counts, budget: this.budgetSnapshot(), error: this.loadError };
  }

  /**
   * Validate a definition and write it as a file, then pick it up.
   *
   * The reload is part of saving: an operator who just pressed save expects the pipeline
   * to be there, and a definition that needs a restart to appear would make the app feel
   * like it had not really saved.
   */
  async save(definition: unknown, options: { overwrite?: boolean } = {}): Promise<SaveResult> {
    const result = await savePipeline(this.dir, definition, options);
    if (result.ok) await this.load();
    return result;
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
