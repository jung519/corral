/**
 * Claude Code `--output-format stream-json` parsing. Pure functions, unit-tested —
 * the riskiest part of the CLI transport, kept free of spawn/IO so it's verifiable.
 *
 * Carried over and adapted from the pre-rename implementation's inline parser, emitting normalized AgentEvents.
 */
import type { AgentEvent } from './types.js';

export interface StreamEvent {
  type: string;
  subtype?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  /**
   * What the turn actually cost, as claude reports it. All four numbers, because the
   * first one alone is not the input — a real turn came back like this:
   *
   *     {"input_tokens":2,"cache_creation_input_tokens":4035,
   *      "cache_read_input_tokens":0,"output_tokens":4}
   *
   * The prompt was 4,037 tokens. Reading only `input_tokens` counted 2 of them (CRL-58).
   */
  usage?: {
    input_tokens?: number;
    /** Written to the cache this turn. Billed, and usually the bulk of a short turn. */
    cache_creation_input_tokens?: number;
    /** Served from the cache. Cheaper than the rest, but not free. */
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
  message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> };
}

/** Parse one stdout line into a stream event, or null for non-JSON noise. */
export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed) as StreamEvent;
  } catch {
    return null;
  }
}

/** Normalized activity events (text / tool_use) for the live timeline. */
export function activityEvents(event: StreamEvent): AgentEvent[] {
  const out: AgentEvent[] = [];
  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'tool_use' && block.name) {
        out.push({ type: 'tool_use', name: block.name + toolHint(block.input) });
      } else if (block.type === 'text' && block.text?.trim()) {
        // Send (near-)full text; the UI truncates visually so widening reveals more.
        out.push({ type: 'text', text: oneLine(block.text, 2000) });
      }
    }
  }
  return out;
}

/**
 * The assistant's text, uncapped.
 *
 * `activityEvents` caps the same text for the live timeline. An answer that has to parse
 * as JSON cannot be capped, so this is the same walk without `oneLine`.
 */
export function answerText(event: StreamEvent): string | null {
  if (event.type !== 'assistant' || !event.message?.content) return null;
  let out = '';
  for (const block of event.message.content) {
    if (block.type === 'text' && block.text) out += block.text;
  }
  return out || null;
}

export interface UsageAcc {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Fold a stream event's cost/token data into the accumulator.
 *
 * Both numbers are the turn's running total, so both replace rather than add. The cost
 * always worked that way; the tokens used to be summed, on the belief that each event
 * carried its own slice. They do not — `result` carries the tally for the whole turn.
 *
 * It happened not to double anything, because the only other event with a usage block
 * keeps it under `message`, where this never looked. That is a thin thing to rely on:
 * the day an `assistant` event gains a top-level `usage`, summing would count the turn
 * twice. Reading the final tally says what is meant and cannot drift (CRL-58).
 *
 * **The input is all three input numbers.** See `StreamEvent.usage` for the measurement.
 */
export function applyUsage(event: StreamEvent, acc: UsageAcc): void {
  if (typeof event.total_cost_usd === 'number') acc.costUsd = event.total_cost_usd;
  const usage = event.usage;
  if (!usage) return;
  acc.inputTokens =
    (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  acc.outputTokens = usage.output_tokens ?? 0;
}

/** Whether the text indicates an auth/credential failure (non-retryable). */
export function looksLikeAuth(text: string): boolean {
  return /\b(unauthorized|authentication|please run .*login|oauth|invalid api key|credit balance|not logged in)\b/i.test(
    text,
  );
}

/** Whether the text indicates a usage/rate limit was hit (the agent's quota for this
 *  window is spent) — the trigger to fail over to the next agent. Distinct from auth:
 *  the credential is valid, it's just temporarily/permanently out of capacity. */
export function looksLikeRateLimit(text: string): boolean {
  return /(rate.?limit|usage limit|quota|too many requests|429|resets? at|reached your .*limit|limit reached|overloaded|capacity)/i.test(
    text,
  );
}

function toolHint(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const v = i.file_path ?? i.path ?? i.command ?? i.pattern ?? i.url ?? i.description;
  return v ? `: ${oneLine(String(v), 2000)}` : '';
}

/** Collapse whitespace to a single line and cap length (UI widens to reveal more). */
export function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max) + '…';
}
