/**
 * The operational AI, assembled.
 *
 * Holds the registry, the runner and the history, and exposes the one entry point that
 * exists before any trigger does: **run this pipeline, now, with this body.** That is
 * how a pipeline gets tried out while it's being written, and how a failed one gets
 * reprocessed afterwards.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { logger } from '../core/logger.js';
import type { CredentialStore } from '../credentials/types.js';
import type { TokenBudget } from '../core/token-budget.js';
import { JsonlOpsHistoryStore } from './history/jsonl-store.js';
import type { OpsHistoryStore, OpsPipelineCounts } from './history/store.js';
import { runHttpRequest } from './http.js';
import { HttpInputResolver } from './input/http.js';
import { applySelect, NoneInputResolver } from './input/none.js';
import { HttpOutputSink } from './output/http.js';
import { NoneOutputSink } from './output/none.js';
import { PubSubOutputSink } from './output/pubsub.js';
import { loadPipelines, pipelinesDir, PipelineLoadError } from './pipeline/loader.js';
import { findPipelineFile, savePipeline, type SaveResult } from './pipeline/writer.js';
import type { AnswerValidator, InputResolver, OperationOutcome, OperationRunner, OutputSink } from './pipeline/ports.js';
import { PipelineRegistry } from './pipeline/registry.js';
import { PipelineRunner, type RunRecord } from './pipeline/run.js';
import { FieldSelectorSchema, HttpRequestSchema } from './pipeline/schema.js';
import { triggerRegistry } from './trigger/index.js';
import type { StopFn } from './trigger/types.js';
import { RuleAnswerValidator } from './validate/rules.js';

/** The `select` map on its own — a trial fetch has no pipeline to take it from. */
const SelectSchema = z.record(z.string(), FieldSelectorSchema);

/**
 * Stands in for the real one-turn runner until it lands. It fails loudly rather than
 * pretending: a run that reaches this ends as `agent_failed` with a reason saying so,
 * which is exactly what an operator should see for a step nothing is wired to yet.
 *
 * Reported rather than thrown, because it is a known failure and not a bug — and it spent
 * nothing, which it now has to say out loud (CRL-44).
 */
export class UnwiredOperationRunner implements OperationRunner {
  async run(): Promise<OperationOutcome> {
    return {
      ok: false,
      reason: 'the AI step is not wired up yet — a pipeline cannot run past its prompt',
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
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

/** A provider the operational AI can actually ask, and the models configured for it. */
export interface OpsAgent {
  provider: string;
  /** Distinct models named in the config for this provider. */
  models: string[];
  /** What it uses when a pipeline names none. */
  defaultModel?: string;
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
  /** Providers that can answer, filled in when a config arrives. */
  private agents: OpsAgent[] = [];

  constructor(private readonly options: OpsHostOptions) {
    this.dir = pipelinesDir(options.stateDir);
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
   * Which providers can actually answer, and with which models.
   *
   * Not "what is in the config" — what `opsChatClients` kept. A provider on the `cli`
   * transport or without a resolvable key is dropped there, and offering it in the editor
   * would let someone build a pipeline that can never run its model step.
   */
  useAgents(agents: OpsAgent[]): void {
    this.agents = agents;
  }

  /** For the editor: the choices it may offer. */
  usableAgents(): OpsAgent[] {
    return this.agents;
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
        const adapter = triggerRegistry.create(pipeline.trigger, {
          now: this.options.now,
          credentials: this.options.credentials,
          // Read through rather than captured, for the same reason `operation` and the
          // runner's own budget are: the ceiling arrives with a config, and a trigger may
          // well have started before there was one.
          budget: { check: () => this.budget?.check() ?? { ok: true } },
        });
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
   * Make the fetch a pipeline would make, and hand back what came off the wire.
   *
   * `select` is written blind today — `data.title` is a guess until a run proves it, and a
   * run costs a model turn. This is the cheap half: the request, the response, and what
   * the paths pull out of it, before anything is saved.
   *
   * It goes through `runHttpRequest`, the same function the input resolver uses, so the
   * credential resolves the same way and what is tried is what will run. A failure comes
   * back as a value rather than an exception — "the server said 401" is the answer someone
   * pressed this to get.
   */
  async testFetch(
    request: unknown,
    event: unknown,
    select: unknown,
  ): Promise<{ ok: boolean; error?: string; body?: unknown; fields?: Record<string, unknown> }> {
    const parsed = HttpRequestSchema.safeParse(request);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    }
    const fields = (event && typeof event === 'object' ? event : {}) as Record<string, unknown>;
    let body: unknown;
    try {
      body = await runHttpRequest(parsed.data, fields, this.options.credentials);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const map = SelectSchema.safeParse(select ?? {});
    return { ok: true, body, fields: map.success ? applySelect(body, map.data) : {} };
  }

  /**
   * Delete a pipeline: its file goes, and so does its trigger.
   *
   * **The trigger stops first.** Removing the file and reloading afterwards would leave a
   * window in which a timer or a queue could start one more run of something already on
   * its way out.
   *
   * **A run already going is left to finish.** Killing one mid-flight can leave half of it
   * written into someone's system; deleting a definition is not a reason to do that. It
   * holds its own copy of the definition, so it completes on the pipeline it started with.
   *
   * **History stays.** What ran is a separate fact from what is configured — deleting the
   * record of last night's failures along with the definition would remove the only way to
   * find out why it was deleted.
   */
  async remove(key: string): Promise<{ ok: boolean; file?: string; error?: string }> {
    if (!this.registry.get(key)) return { ok: false, error: `no pipeline named "${key}"` };

    // Whatever the file is actually called. Assuming `<key>.yaml` would silently miss a
    // hand-named file and leave the pipeline behind — the same reason `savePipeline` looks
    // it up rather than guessing.
    const file = await findPipelineFile(this.dir, key);
    if (!file) return { ok: false, error: `no file defines "${key}" — nothing to delete` };

    const stop = this.subscriptions.get(key);
    if (stop) {
      await stop();
      this.subscriptions.delete(key);
      logger.info(`ops: pipeline "${key}" stopped`);
    }

    await rm(join(this.dir, file));
    await this.load();
    return { ok: true, file };
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
