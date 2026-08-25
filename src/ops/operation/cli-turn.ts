/**
 * One turn through a provider's CLI, for cores that have no API key.
 *
 * **The turn runs with no tools.** That is the whole shape of this file, and it is not a
 * precaution — it is what measurement left standing.
 *
 * An operational prompt carries a queue message and an external API response: text nobody
 * here controls. Handed to a coding agent with a shell, that is prompt injection with
 * command execution behind it, and the only thing in the way was a sentence asking it not
 * to. Corral says elsewhere, in its own words, that a prompt is a request and not a
 * guarantee; relying on one here was the same mistake in a worse place.
 *
 * Narrowing tools was tried first and is not enough. With `--tools Write` the agent could
 * no longer run commands but could still write **outside** its working directory, in every
 * variant tried — including with the permission check left on and with deny rules. A write
 * that reaches `~/.claude` buys command execution back on the next run. So the setting is
 * none, and the answer comes back as text rather than a file, because a turn with no tools
 * has no way to write one.
 *
 * What that leaves is genuinely the same as the API path: ask once, read the reply, check
 * it. Same `OperationRunner` port, same `checkAnswer`, same `usage` events feeding the
 * shared ceiling (D12). No temp directory, nothing to clean up, nothing to confine.
 *
 * "Same" is the accurate word for the accounting rather than "correct": the shared parser
 * undercounts a CLI turn badly, and that is its own issue (CRL-58) — a CLI run is wrong by
 * exactly as much as a development run is.
 *
 * A provider whose CLI cannot be run without tools does not appear here at all — see
 * `opsCliTransports`.
 */
import { tmpdir } from 'node:os';
import type { AgentEvent, AgentProviderId, AgentTransport } from '../../agent/types.js';
import type { WorkspaceHandle, WorkspaceIO } from '../../core/types.js';
import { logger } from '../../core/logger.js';
import type { Fields, OperationOutcome, OperationResult, OperationSpend, OperationRunner } from '../pipeline/ports.js';
import type { PipelineAgentStep } from '../pipeline/schema.js';
import { checkAnswer, schemaInstruction } from './one-turn.js';
import { SpendTally } from './spend.js';
import { fillTemplate } from '../pipeline/run.js';

export interface CliTurnOptions {
  /** CLI transports in preference order, each already bound to its provider. */
  transports: AgentTransport[];
  /** Model to use for a provider when the pipeline doesn't name one. */
  modelFor?: (provider: AgentProviderId) => string | undefined;
  /** How long one agent turn may take. A pipeline run is seconds, not hours. */
  turnTimeoutMs?: number;
}

/** Five minutes. Long enough for a slow model, short enough to notice a wedged process. */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/**
 * The instruction that turns a coding agent into a one-shot answerer.
 *
 * It has no tools, so "do not explore" is a description rather than a rule it could break.
 * Saying it anyway keeps the agent from spending the turn explaining that it cannot look.
 */
export function textInstruction(schema: PipelineAgentStep['schema']): string {
  return [
    schemaInstruction(schema),
    '',
    'You have no tools in this turn: no shell, no file access, nothing to read.',
    'Answer from the text above alone. The reply itself is the answer.',
  ].join('\n');
}

export class CliTurnOperationRunner implements OperationRunner {
  private readonly timeoutMs: number;

  constructor(private readonly options: CliTurnOptions) {
    if (!options.transports.length) throw new Error('CliTurnOperationRunner needs at least one transport');
    this.timeoutMs = options.turnTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async run(step: PipelineAgentStep, fields: Fields): Promise<OperationOutcome> {
    const wanted = step.provider;
    const transports = wanted ? this.options.transports.filter((t) => t.provider === wanted) : this.options.transports;
    if (!transports.length) {
      throw new Error(`provider "${wanted}" is not configured for the cli transport — the pipeline cannot run on it`);
    }

    const attempts: string[] = [];
    // Everything this turn spends, across providers — a failed attempt was still billed
    // (CRL-45). Each attempt reports its own spend whether it worked or not.
    const spent = new SpendTally();
    for (const [index, transport] of transports.entries()) {
      const model = step.model ?? this.options.modelFor?.(transport.provider);
      const outcome = await this.oneTurn(transport, step, fields, model);
      spent.add(outcome.spend);
      if ('error' in outcome) {
        // A different provider may well answer where this one crashed or timed out — the
        // same reason the API runner moves on rather than giving up.
        attempts.push(`${transport.provider}: ${outcome.error}`);
        logger.warn(`ops: ${transport.provider} cli turn failed (${outcome.error})`);
        continue;
      }
      return { ok: true, ...outcome.result, ...spent.total(), provider: transport.provider, model, failedOver: index > 0 };
    }

    // Every attempt, not just the last: an operator has to be able to tell "one provider
    // was wedged" from "all of them refused the shape".
    return { ok: false, reason: `no provider produced a usable answer — ${attempts.join('; ')}`, ...spent.total() };
  }

  /**
   * Ask once and read the reply.
   *
   * Both endings carry `spend`, and that is the point: the `usage` event arrives before
   * anyone knows whether the reply is usable, so every way out of here has something to
   * report. Four of the five ways out are failures, and each of them used to drop it.
   */
  private async oneTurn(
    transport: AgentTransport,
    step: PipelineAgentStep,
    fields: Fields,
    model: string | undefined,
  ): Promise<({ result: Pick<OperationResult, 'answer'> } | { error: string }) & { spend: OperationSpend }> {
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let failure: string | undefined;
    let text = '';
    // Read on every path out, so a failure reports its bill instead of dropping it.
    const spend = (): OperationSpend => ({ tokens: inputTokens + outputTokens, inputTokens, outputTokens, costUsd });

    const onEvent = (event: AgentEvent): void => {
      if (event.type === 'usage') {
        // Counted whatever the answer turns out to be worth. A turn that produced an
        // unusable reply still cost tokens, and a ceiling that only counted useful calls
        // would not be a ceiling.
        inputTokens = event.inputTokens;
        outputTokens = event.outputTokens;
        costUsd = event.costUsd;
      } else if (event.type === 'error') {
        failure = event.message ? `${event.error} — ${event.message}` : event.error;
      }
    };

    try {
      await transport.run(
        {
          // A CLI still spawns a process, and a process still has a working directory.
          // Nothing is written there — the turn has no tools — but the directory is not
          // inert: a coding CLI reads the project it finds itself in. Measured from the
          // corral checkout it cost 12,032 input tokens against 7,278 from a bare temp
          // directory, and those 4,750 are somebody else's instructions charged to a
          // pipeline, thousands of times a day, against a ceiling shared with the
          // development AI (D12).
          handle: WORKDIR,
          io: NO_IO,
          // Filled on both halves, same as the API path — see the note in one-turn.ts.
          prompt: `${fillTemplate(step.prompt.system, fields)}\n\n${fillTemplate(step.prompt.user_template, fields)}\n\n${textInstruction(step.schema)}`,
          // The development AI's rules for editing a repository. An operational run has
          // no repository, and with no tools it could not read the file anyway.
          workflow: '',
          model,
          continueSession: false,
          noTools: true,
          onAnswerText: (t) => (text = t),
          turnTimeoutMs: this.timeoutMs,
        },
        onEvent,
      );
    } catch (err) {
      // A process that died mid-turn still burned whatever it had streamed by then.
      return { error: err instanceof Error ? err.message : String(err), spend: spend() };
    }
    if (failure) return { error: failure, spend: spend() };
    if (!text.trim()) return { error: 'the agent produced no answer text', spend: spend() };

    // The same check an API answer gets. Two shape checks would mean the rules depended on
    // which transport happened to be configured.
    const checked = checkAnswer(step.schema, text);
    if (!checked.ok) return { error: checked.reason, spend: spend() };

    return { result: { answer: checked.answer }, spend: spend() };
  }
}

/**
 * Where the process runs.
 *
 * Deliberately not the core's own directory: `tmpdir()` holds no project for the CLI to
 * read itself into. Nothing is created or cleaned up, because with no tools nothing is
 * written — which is also why concurrent runs can share it.
 */
const WORKDIR: WorkspaceHandle = { id: 'ops', workdir: tmpdir(), backend: 'local' };

/**
 * A `WorkspaceIO` that is never used.
 *
 * `AgentTurnSpec` requires one, and the only thing that touches it is the workflow-guide
 * write that an empty `workflow` skips. Handing over something that throws is how that
 * stays true: a transport that does reach for it says so instead of quietly succeeding.
 */
const NO_IO = new Proxy({} as WorkspaceIO, {
  get: () => () => Promise.reject(new Error('an operational run gives the agent no workspace')),
});
