/**
 * Gemini CLI `--output-format stream-json` parsing. The schema differs from Claude's
 * (see @google/gemini-cli-core output/types): JSONL events of type init / message /
 * tool_use / tool_result / error / result, where assistant text streams as many small
 * `message` deltas. This parser coalesces those deltas into line-level timeline
 * entries, so it is STATEFUL — instantiate one per turn (never share across turns).
 *
 * Pure of spawn/IO so it's unit-testable, like stream-json.ts (Claude).
 */
import type { CliStreamParser } from './cli-runner.js';
import { looksLikeAuth, looksLikeRateLimit, oneLine, type UsageAcc } from './stream-json.js';
import type { AgentEvent } from './types.js';

export interface GeminiEvent {
  type: string;
  role?: string;
  content?: string;
  delta?: boolean;
  tool_name?: string;
  tool_id?: string;
  parameters?: unknown;
  severity?: string;
  message?: string;
  status?: string;
  stats?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}

const MAX = 2000;

export class GeminiStreamParser implements CliStreamParser<GeminiEvent> {
  /** Accumulates assistant text deltas until a newline (or overflow) flushes a line. */
  private buf = '';

  parse(line: string): GeminiEvent | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
      return JSON.parse(trimmed) as GeminiEvent;
    } catch {
      return null;
    }
  }

  activity(event: GeminiEvent): AgentEvent[] {
    if (event.type === 'message' && event.role === 'assistant' && event.content) {
      this.buf += event.content;
      const out: AgentEvent[] = [];
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const segment = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (segment.trim()) out.push({ type: 'text', text: oneLine(segment, MAX) });
      }
      // Flush a runaway buffer (a single long line with no newline yet).
      if (this.buf.length > MAX) {
        out.push({ type: 'text', text: oneLine(this.buf, MAX) });
        this.buf = '';
      }
      return out;
    }
    if (event.type === 'tool_use' && event.tool_name) {
      return [{ type: 'tool_use', name: event.tool_name + toolHint(event.parameters) }];
    }
    return [];
  }

  usage(event: GeminiEvent, acc: UsageAcc): void {
    if (event.type === 'result' && event.stats) {
      if (typeof event.stats.input_tokens === 'number') acc.inputTokens += event.stats.input_tokens;
      if (typeof event.stats.output_tokens === 'number') acc.outputTokens += event.stats.output_tokens;
      // The CLI stream-json format does not report a USD cost; leave acc.costUsd at 0.
    }
  }

  isAuthFailure(event: GeminiEvent, rawLine: string): boolean {
    return event.type === 'error' && looksLikeAuth(rawLine);
  }

  isRateLimit(event: GeminiEvent, rawLine: string): boolean {
    return event.type === 'error' && looksLikeRateLimit(rawLine);
  }

  /** Emit any buffered trailing text (a final line with no trailing newline). */
  flush(): AgentEvent[] {
    const t = this.buf.trim();
    this.buf = '';
    return t ? [{ type: 'text', text: oneLine(t, MAX) }] : [];
  }
}

function toolHint(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const v = i.file_path ?? i.path ?? i.command ?? i.pattern ?? i.url ?? i.description;
  return v ? `: ${oneLine(String(v), MAX)}` : '';
}
