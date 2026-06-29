/**
 * Claude (anthropic) API transport — BYOK calls to the Messages API, driven through the
 * shared agentic loop (api-loop.ts). The model gets the single `bash` tool and edits the
 * workspace by issuing shell commands. Uses global fetch — no SDK dependency.
 */
import {
  ApiHttpError,
  type ChatClient,
  type ChatTurn,
  type NeutralMessage,
  parseJsonObject,
  parseRetryAfter,
  runApiAgent,
  type SendOptions,
  sseData,
  type ToolDef,
} from './api-loop.js';
import type { AgentEvent, AgentTransport, AgentTurnSpec, PreflightResult } from './types.js';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';
const MAX_TOKENS = 8192;
const DEFAULT_MODEL = 'claude-sonnet-4-5';

// Wizard offers version-agnostic aliases (opus/sonnet/haiku); the Messages API needs a
// concrete id. Map the aliases; pass through anything that already looks like an id.
const MODEL_ALIAS: Record<string, string> = {
  opus: 'claude-opus-4-1',
  sonnet: 'claude-sonnet-4-5',
  haiku: 'claude-haiku-4-5',
};
function resolveModel(model: string | undefined): string {
  if (!model) return DEFAULT_MODEL;
  return MODEL_ALIAS[model] ?? model;
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string | undefined; content: string };
interface AntMessage {
  role: 'user' | 'assistant';
  content: Block[];
}

/** Map the neutral conversation to Anthropic's system + messages shape. Consecutive tool
 *  results coalesce into one user message (the API requires it). */
function toAnthropic(messages: NeutralMessage[]): { system: string; msgs: AntMessage[] } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const msgs: AntMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      msgs.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
    } else if (m.role === 'assistant') {
      const content: Block[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      msgs.push({ role: 'assistant', content });
    } else {
      const block: Block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'user') last.content.push(block);
      else msgs.push({ role: 'user', content: [block] });
    }
  }
  return { system, msgs };
}

export class AnthropicChatClient implements ChatClient {
  readonly provider = 'claude' as const;

  constructor(private readonly apiKey: string | null) {}

  async preflight(): Promise<PreflightResult> {
    if (!this.apiKey) return { ok: false, detail: 'missing Anthropic API key (BYOK) for claude:api transport' };
    return { ok: true };
  }

  async send(messages: NeutralMessage[], tools: ToolDef[], model: string | undefined, opts?: SendOptions): Promise<ChatTurn> {
    const { system, msgs } = toAnthropic(messages);
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey ?? '', 'anthropic-version': VERSION },
      body: JSON.stringify({
        model: resolveModel(model),
        max_tokens: MAX_TOKENS,
        stream: true,
        // Cache the (large, stable) system prompt so repeated turns only pay to read it once.
        system: system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined,
        messages: msgs,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      }),
      signal: opts?.signal,
    });
    if (!res.ok) throw new ApiHttpError(res.status, `Anthropic ${res.status}: ${(await res.text()).slice(0, 500)}`, parseRetryAfter(res.headers.get('retry-after')));
    // Blocks stream as start/delta/stop events keyed by index; text_delta → text,
    // input_json_delta → a tool_use block's accumulating JSON args.
    const blocks = new Map<number, { type: string; id: string; name: string; json: string }>();
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      for await (const data of sseData(res, opts?.signal)) {
        const ev = JSON.parse(data) as {
          type: string;
          index?: number;
          message?: { usage?: { input_tokens?: number } };
          content_block?: { type: string; id?: string; name?: string };
          delta?: { type?: string; text?: string; partial_json?: string };
          usage?: { output_tokens?: number };
        };
        if (ev.type === 'message_start') {
          inputTokens = ev.message?.usage?.input_tokens ?? 0;
        } else if (ev.type === 'content_block_start' && ev.index != null && ev.content_block) {
          blocks.set(ev.index, { type: ev.content_block.type, id: ev.content_block.id ?? '', name: ev.content_block.name ?? '', json: '' });
        } else if (ev.type === 'content_block_delta' && ev.index != null) {
          if (ev.delta?.type === 'text_delta' && ev.delta.text) {
            text += ev.delta.text;
            opts?.onText?.(ev.delta.text);
          } else if (ev.delta?.type === 'input_json_delta') {
            const b = blocks.get(ev.index);
            if (b) b.json += ev.delta.partial_json ?? '';
          }
        } else if (ev.type === 'message_delta' && ev.usage?.output_tokens != null) {
          outputTokens = ev.usage.output_tokens;
        }
      }
    } catch (e) {
      if (e instanceof ApiHttpError) throw e;
      throw new ApiHttpError(0, `Anthropic stream error: ${e instanceof Error ? e.message : String(e)}`);
    }
    const toolCalls = [...blocks.values()]
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, args: parseJsonObject(b.json) }));
    return { text, toolCalls, inputTokens, outputTokens };
  }
}

export class ClaudeApiTransport implements AgentTransport {
  readonly provider = 'claude' as const;
  readonly transport = 'api' as const;
  private readonly client: AnthropicChatClient;

  constructor(apiKey: string | null) {
    this.client = new AnthropicChatClient(apiKey);
  }

  preflight(): Promise<PreflightResult> {
    return this.client.preflight();
  }

  run(spec: AgentTurnSpec, onEvent: (event: AgentEvent) => void): Promise<void> {
    return runApiAgent(this.client, spec, onEvent);
  }
}
