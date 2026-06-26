/**
 * Codex CLI `exec --json` (JSONL) parsing. Schema (observed, codex-cli 0.142):
 *   {"type":"thread.started","thread_id":"<uuid>"}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":..,"type":"agent_message","text":".."}}
 *   {"type":"item.completed","item":{"type":"command_execution"|"file_change"|"error"|..}}
 *   {"type":"turn.completed","usage":{"input_tokens":..,"output_tokens":..,..}}
 *   {"type":"error","message":".."}
 *
 * Items arrive complete (not token deltas), so this parser is stateless EXCEPT it
 * remembers the thread_id (so the transport can resume the exact session next turn).
 * Pure of spawn/IO — unit-testable like the claude/gemini parsers.
 */
import type { CliStreamParser } from './cli-runner.js';
import { looksLikeAuth, looksLikeRateLimit, oneLine, type UsageAcc } from './stream-json.js';
import type { AgentEvent } from './types.js';

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  message?: string;
  command?: string;
  path?: string;
  [k: string]: unknown;
}

export interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
    reasoning_output_tokens?: number;
  };
  message?: string;
}

const MAX = 2000;

export class CodexStreamParser implements CliStreamParser<CodexEvent> {
  /** Captured from thread.started — the session id to resume next turn. */
  threadId: string | undefined;

  parse(line: string): CodexEvent | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
      return JSON.parse(trimmed) as CodexEvent;
    } catch {
      return null;
    }
  }

  activity(event: CodexEvent): AgentEvent[] {
    if (event.type === 'thread.started' && event.thread_id) {
      this.threadId = event.thread_id;
      return [];
    }
    if (event.type === 'item.completed' && event.item) {
      return itemActivity(event.item);
    }
    return [];
  }

  usage(event: CodexEvent, acc: UsageAcc): void {
    if (event.type === 'turn.completed' && event.usage) {
      if (typeof event.usage.input_tokens === 'number') acc.inputTokens += event.usage.input_tokens;
      const out = (event.usage.output_tokens ?? 0) + (event.usage.reasoning_output_tokens ?? 0);
      if (out) acc.outputTokens += out;
      // The CLI JSONL stream does not report a USD cost; leave acc.costUsd at 0.
    }
  }

  isAuthFailure(_event: CodexEvent, rawLine: string): boolean {
    return looksLikeAuth(rawLine);
  }

  isRateLimit(_event: CodexEvent, rawLine: string): boolean {
    return looksLikeRateLimit(rawLine);
  }
}

/** One completed item → timeline event(s). agent_message = text; tool-ish items = tool_use. */
function itemActivity(item: CodexItem): AgentEvent[] {
  switch (item.type) {
    case 'agent_message':
      return item.text?.trim() ? [{ type: 'text', text: oneLine(item.text, MAX) }] : [];
    case 'reasoning':
      return item.text?.trim() ? [{ type: 'text', text: oneLine(item.text, MAX) }] : [];
    case 'command_execution':
      return [{ type: 'tool_use', name: `command${detail(item.command)}` }];
    case 'file_change':
      return [{ type: 'tool_use', name: `edit${detail(item.path ?? summarizeChanges(item))}` }];
    case 'mcp_tool_call':
    case 'web_search':
      return [{ type: 'tool_use', name: `${item.type}${detail(item.query ?? item.command)}` }];
    case 'error':
      return item.message ? [{ type: 'text', text: oneLine(`⚠️ ${item.message}`, MAX) }] : [];
    default:
      return [];
  }
}

function summarizeChanges(item: CodexItem): unknown {
  const changes = item.changes;
  if (Array.isArray(changes)) return changes.map((c) => (c as { path?: string })?.path).filter(Boolean).join(', ');
  return undefined;
}

function detail(v: unknown): string {
  return v ? `: ${oneLine(String(v), MAX)}` : '';
}
