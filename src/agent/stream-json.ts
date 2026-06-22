/**
 * Claude Code `--output-format stream-json` parsing. Pure functions, unit-tested —
 * the riskiest part of the CLI transport, kept free of spawn/IO so it's verifiable.
 *
 * Lifted/adapted from upstream's inline parser, emitting normalized AgentEvents.
 */
import type { AgentEvent } from './types.js';

export interface StreamEvent {
  type: string;
  subtype?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
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

export interface UsageAcc {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** Fold a stream event's cost/token data into the accumulator.
 *  total_cost_usd is cumulative (replace); token counts are per-event (sum). */
export function applyUsage(event: StreamEvent, acc: UsageAcc): void {
  if (typeof event.total_cost_usd === 'number') acc.costUsd = event.total_cost_usd;
  if (event.usage) {
    if (typeof event.usage.input_tokens === 'number') acc.inputTokens += event.usage.input_tokens;
    if (typeof event.usage.output_tokens === 'number') acc.outputTokens += event.usage.output_tokens;
  }
}

/** Whether the text indicates an auth/credential failure (non-retryable). */
export function looksLikeAuth(text: string): boolean {
  return /\b(unauthorized|authentication|please run .*login|oauth|invalid api key|credit balance|not logged in)\b/i.test(
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
