/**
 * OpenAI (gpt) API transport — BYOK calls to the Chat Completions API, driven through the
 * shared agentic loop (api-loop.ts). The model gets the single `bash` tool and edits the
 * workspace by issuing shell commands. Uses global fetch — no SDK dependency.
 */
import {
  ApiHttpError,
  type ChatClient,
  type ChatTurn,
  type NeutralMessage,
  parseRetryAfter,
  runApiAgent,
  type ToolDef,
} from './api-loop.js';
import type { AgentEvent, AgentTransport, AgentTurnSpec, PreflightResult } from './types.js';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-5-mini';

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Map the neutral conversation to OpenAI's `messages` shape. */
function toOpenAiMessages(messages: NeutralMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      const tool_calls = m.toolCalls?.map(
        (c): OpenAiToolCall => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }),
      );
      return { role: 'assistant', content: m.content || null, ...(tool_calls?.length ? { tool_calls } : {}) };
    }
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    return { role: m.role, content: m.content };
  });
}

function toOpenAiTools(tools: ToolDef[]): unknown[] {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export class OpenAiChatClient implements ChatClient {
  readonly provider = 'gpt' as const;

  constructor(private readonly apiKey: string | null) {}

  async preflight(): Promise<PreflightResult> {
    if (!this.apiKey) return { ok: false, detail: 'missing OpenAI API key (BYOK) for gpt:api transport' };
    return { ok: true };
  }

  async send(messages: NeutralMessage[], tools: ToolDef[], model: string | undefined, signal?: AbortSignal): Promise<ChatTurn> {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        messages: toOpenAiMessages(messages),
        tools: toOpenAiTools(tools),
        tool_choice: 'auto',
      }),
      signal,
    });
    if (!res.ok) {
      throw new ApiHttpError(res.status, `OpenAI ${res.status}: ${(await res.text()).slice(0, 500)}`, parseRetryAfter(res.headers.get('retry-after')));
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: OpenAiToolCall[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const msg = body.choices?.[0]?.message;
    const toolCalls = (msg?.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) }));
    return {
      text: msg?.content ?? '',
      toolCalls,
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
    };
  }
}

/** Tool-call arguments arrive as a JSON string; tolerate malformed output. */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class OpenAiApiTransport implements AgentTransport {
  readonly provider = 'gpt' as const;
  readonly transport = 'api' as const;
  private readonly client: OpenAiChatClient;

  constructor(apiKey: string | null) {
    this.client = new OpenAiChatClient(apiKey);
  }

  preflight(): Promise<PreflightResult> {
    return this.client.preflight();
  }

  run(spec: AgentTurnSpec, onEvent: (event: AgentEvent) => void): Promise<void> {
    return runApiAgent(this.client, spec, onEvent);
  }
}
