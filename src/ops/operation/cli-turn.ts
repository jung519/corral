/**
 * One turn through a provider's CLI, for cores that have no API key.
 *
 * The API runner asks a question and reads the answer off the wire. A CLI agent has no
 * wire — it is a process with a working directory. So the answer comes back the way the
 * development AI already passes things: **the agent writes a file and we read it.**
 *
 * That is the whole difference. Everything around it is deliberately the same:
 *
 *   - the same `OperationRunner` port, so the lifecycle in `run.ts` is untouched
 *   - the same `checkAnswer`, so a pipeline built on CLI is held to the shape its schema
 *     declares exactly as an API one is. Two shape checks would mean the rules depended
 *     on which transport happened to be configured
 *   - the same token accounting, from the `usage` events the CLI runner already emits,
 *     so a CLI run counts against the shared daily ceiling like any other (D12)
 *
 * **No workflow guide is written.** `AgentTurnSpec.workflow` stays empty: that file is the
 * development AI's rules for editing a repository, and an operational run has none. It
 * also means `io.writeFile` is never called, which keeps the run directory to what it is —
 * a place for the answer to land.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentEvent, AgentProviderId, AgentTransport } from '../../agent/types.js';
import { logger } from '../../core/logger.js';
import type { Fields, OperationResult, OperationRunner } from '../pipeline/ports.js';
import type { PipelineAgentStep } from '../pipeline/schema.js';
import { checkAnswer, schemaInstruction } from './one-turn.js';
import { fillTemplate } from '../pipeline/run.js';
import { makeRunDir } from './run-dir.js';

/** Where the agent is told to leave its answer. Relative to the run directory. */
export const ANSWER_FILE = 'answer.json';

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
 * A CLI agent is built to work in a repository, so it has to be told plainly that there
 * is nothing to explore and exactly one thing to produce.
 */
export function fileInstruction(schema: PipelineAgentStep['schema']): string {
  return [
    schemaInstruction(schema),
    '',
    `Write that JSON object to a file named ${ANSWER_FILE} in your working directory.`,
    'Do not create any other file, do not read anything else, and do not run any command.',
    'The file is the answer; nothing you print is read.',
  ].join('\n');
}

export class CliTurnOperationRunner implements OperationRunner {
  private readonly timeoutMs: number;

  constructor(private readonly options: CliTurnOptions) {
    if (!options.transports.length) throw new Error('CliTurnOperationRunner needs at least one transport');
    this.timeoutMs = options.turnTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async run(step: PipelineAgentStep, fields: Fields): Promise<OperationResult> {
    const wanted = step.provider;
    const transports = wanted ? this.options.transports.filter((t) => t.provider === wanted) : this.options.transports;
    if (!transports.length) {
      throw new Error(`provider "${wanted}" is not configured for the cli transport — the pipeline cannot run on it`);
    }

    const attempts: string[] = [];
    for (const [index, transport] of transports.entries()) {
      const model = step.model ?? this.options.modelFor?.(transport.provider);
      const dir = await makeRunDir(`ops-${transport.provider}`);
      try {
        const outcome = await this.oneTurn(transport, step, fields, model, dir.path);
        if ('error' in outcome) {
          // A different provider may well answer where this one crashed or timed out —
          // the same reason the API runner moves on rather than giving up.
          attempts.push(`${transport.provider}: ${outcome.error}`);
          logger.warn(`ops: ${transport.provider} cli turn failed (${outcome.error})`);
          continue;
        }
        return { ...outcome.result, provider: transport.provider, model, failedOver: index > 0 };
      } finally {
        await dir.dispose();
      }
    }

    // Every attempt, not just the last: an operator has to be able to tell "one provider
    // was wedged" from "all of them refused the shape".
    throw new Error(`no provider produced a usable answer — ${attempts.join('; ')}`);
  }

  /** Run the agent once and read what it left behind. */
  private async oneTurn(
    transport: AgentTransport,
    step: PipelineAgentStep,
    fields: Fields,
    model: string | undefined,
    path: string,
  ): Promise<{ result: OperationResult } | { error: string }> {
    const dir = { handle: { id: 'ops', workdir: path, backend: 'local' as const } };
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let failure: string | undefined;

    const onEvent = (event: AgentEvent): void => {
      if (event.type === 'usage') {
        // Counted whatever the answer turns out to be worth. A turn that produced an
        // unusable file still cost tokens, and a ceiling that only counted useful calls
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
          handle: dir.handle,
          // Never called: `workflow` is empty, and that is the only thing that writes.
          io: NO_IO,
          prompt: `${step.prompt.system}\n\n${fillTemplate(step.prompt.user_template, fields)}\n\n${fileInstruction(step.schema)}`,
          workflow: '',
          model,
          continueSession: false,
          turnTimeoutMs: this.timeoutMs,
        },
        onEvent,
      );
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    if (failure) return { error: failure };

    const text = await readFile(join(path, ANSWER_FILE), 'utf8').catch(() => null);
    if (text === null) {
      // The agent ran and wrote nothing. Naming the file is the only useful thing to say.
      return { error: `the agent did not write ${ANSWER_FILE}` };
    }
    const checked = checkAnswer(step.schema, text);
    if (!checked.ok) return { error: checked.reason };

    return {
      result: {
        answer: checked.answer,
        tokens: inputTokens + outputTokens,
        inputTokens,
        outputTokens,
        costUsd,
      },
    };
  }
}

/**
 * A `WorkspaceIO` that is never used.
 *
 * `AgentTurnSpec` requires one, and the only caller is the workflow-guide write that an
 * empty `workflow` skips. Handing over something that throws is how that stays true: if a
 * transport ever does reach for it, it says so instead of silently writing into a temp
 * folder nobody reads.
 */
const NO_IO = {
  readFile: () => Promise.reject(new Error('an operational run gives the agent no workspace')),
  writeFile: () => Promise.reject(new Error('an operational run gives the agent no workspace')),
  exists: () => Promise.reject(new Error('an operational run gives the agent no workspace')),
  list: () => Promise.reject(new Error('an operational run gives the agent no workspace')),
  getDiff: () => Promise.reject(new Error('an operational run gives the agent no workspace')),
  exec: () => Promise.reject(new Error('an operational run gives the agent no workspace')),
} as unknown as import('../../core/types.js').WorkspaceIO;
