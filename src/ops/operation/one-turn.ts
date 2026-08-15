/**
 * One turn in, one structured answer out.
 *
 * The development AI is a multi-turn tool loop: it reads files, runs commands, and keeps
 * going until the work is done. An operational pipeline is the opposite shape — a single
 * question with a known answer format, asked thousands of times. Nothing here loops.
 *
 * **What is reused.** The provider layer, at its `ChatClient` seam (`agent/api-loop.ts`):
 * one turn, neutral messages in, text plus token counts out. Not `FailoverAgent` — that
 * is an `AgentAdapter` and needs a workspace and an issue, neither of which exists here.
 * So failover is re-expressed over the same client list rather than a new provider layer
 * being written.
 *
 * **How the shape is requested.** By instruction in the prompt, then parsed strictly. The
 * `ChatClient` contract has no structured-output parameter, and adding one would mean
 * changing all three providers' wire code — the opposite of reusing them. Models do wrap
 * JSON in prose; recovering those answers is its own issue, deliberately layered on top of
 * a strict parse rather than smeared through it.
 */
import { priceFor } from '../../agent/pricing.js';
import type { ChatClient, NeutralMessage } from '../../agent/api-loop.js';
import type { AgentProviderId } from '../../agent/types.js';
import { logger } from '../../core/logger.js';
import type { OperationResult, OperationRunner, Fields } from '../pipeline/ports.js';
import { fillTemplate } from '../pipeline/run.js';
import type { PipelineAgentStep } from '../pipeline/schema.js';

export interface OneTurnOptions {
  /** Providers in preference order. The first that answers usably wins. */
  clients: ChatClient[];
  /** Model to use for a provider when the pipeline doesn't name one. */
  modelFor?: (provider: AgentProviderId) => string | undefined;
}

/** A parsed, shape-checked answer, or why it wasn't one. */
export type AnswerCheck =
  | { ok: true; answer: Record<string, unknown> }
  | { ok: false; reason: string };

/** JSON Schema types we can actually check, mapped to a runtime test. */
const TYPE_TESTS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
};

/**
 * Check a reply against the step's declared shape.
 *
 * Only the declared properties come back. An answer is about to be poured into output
 * templates and someone else's API, and whatever else the model felt like adding has no
 * business travelling that far.
 */
export function checkAnswer(schema: PipelineAgentStep['schema'], text: string): AnswerCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'the reply was not JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'the reply was not a JSON object' };
  }

  const source = parsed as Record<string, unknown>;
  const missing = (schema.required ?? []).filter((name) => source[name] === undefined);
  if (missing.length) return { ok: false, reason: `missing required field(s): ${missing.join(', ')}` };

  const answer: Record<string, unknown> = {};
  const wrongType: string[] = [];
  for (const [name, spec] of Object.entries(schema.properties)) {
    if (source[name] === undefined) continue;
    const declared = (spec as { type?: string } | null)?.type;
    const test = declared ? TYPE_TESTS[declared] : undefined;
    if (test && !test(source[name])) wrongType.push(`${name} should be ${declared}`);
    answer[name] = source[name];
  }
  if (wrongType.length) return { ok: false, reason: wrongType.join(', ') };

  return { ok: true, answer };
}

/** The instruction that turns a chat model into a structured-output one. */
export function schemaInstruction(schema: PipelineAgentStep['schema']): string {
  return [
    'Reply with a single JSON object and nothing else — no prose, no code fences.',
    'It must match this JSON Schema:',
    JSON.stringify(schema),
  ].join('\n');
}

export class OneTurnOperationRunner implements OperationRunner {
  constructor(private readonly options: OneTurnOptions) {
    if (!options.clients.length) throw new Error('OneTurnOperationRunner needs at least one provider');
  }

  async run(step: PipelineAgentStep, fields: Fields): Promise<OperationResult> {
    const messages: NeutralMessage[] = [
      { role: 'system', content: `${step.prompt.system}\n\n${schemaInstruction(step.schema)}` },
      { role: 'user', content: fillTemplate(step.prompt.user_template, fields) },
    ];

    // A pipeline may name its provider; otherwise every configured one is fair game, in
    // the order they were configured.
    const clients = step.provider
      ? this.options.clients.filter((c) => c.provider === step.provider)
      : this.options.clients;
    if (!clients.length) {
      throw new Error(`provider "${step.provider}" is not configured — the pipeline cannot run on it`);
    }

    const attempts: string[] = [];
    for (const [index, client] of clients.entries()) {
      const model = step.model ?? this.options.modelFor?.(client.provider);
      try {
        const turn = await client.send(messages, [], model);
        const checked = checkAnswer(step.schema, turn.text);
        if (!checked.ok) {
          // A different model may well obey the shape this one ignored, so an unusable
          // answer moves on exactly like a refused request does.
          attempts.push(`${client.provider}: ${checked.reason}`);
          logger.warn(`ops: ${client.provider} answered off-schema (${checked.reason})`);
          continue;
        }
        return {
          answer: checked.answer,
          tokens: turn.inputTokens + turn.outputTokens,
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
          costUsd: priceFor(client.provider, model, turn.inputTokens, turn.outputTokens),
          provider: client.provider,
          model,
          failedOver: index > 0,
        };
      } catch (err) {
        attempts.push(`${client.provider}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Every attempt, not just the last. When a pipeline stops overnight the operator has
    // to be able to see whether one provider was down or all of them refused the shape.
    throw new Error(`no provider produced a usable answer — ${attempts.join('; ')}`);
  }
}
