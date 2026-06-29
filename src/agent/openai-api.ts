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
  parseJsonObject,
  parseRetryAfter,
  runApiAgent,
  type SendOptions,
  sseData,
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

  async send(messages: NeutralMessage[], tools: ToolDef[], model: string | undefined, opts?: SendOptions): Promise<ChatTurn> {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        messages: toOpenAiMessages(messages),
        tools: toOpenAiTools(tools),
        tool_choice: 'auto',
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: opts?.signal,
    });
    if (!res.ok) {
      throw new ApiHttpError(res.status, `OpenAI ${res.status}: ${(await res.text()).slice(0, 500)}`, parseRetryAfter(res.headers.get('retry-after')));
    }
    // tool_calls stream as fragments keyed by index — accumulate name + arguments string.
    const acc = new Map<number, { id: string; name: string; args: string }>();
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      for await (const data of sseData(res, opts?.signal)) {
        const chunk = JSON.parse(data) as {
          choices?: { delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          text += delta.content;
          opts?.onText?.(delta.content);
        }
        for (const tc of delta?.tool_calls ?? []) {
          const slot = acc.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          acc.set(tc.index, slot);
        }
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
          outputTokens = chunk.usage.completion_tokens ?? outputTokens;
        }
      }
    } catch (e) {
      if (e instanceof ApiHttpError) throw e;
      throw new ApiHttpError(0, `OpenAI stream error: ${e instanceof Error ? e.message : String(e)}`);
    }
    const toolCalls = [...acc.values()]
      .filter((s) => s.name)
      .map((s) => ({ id: s.id || `call_${s.name}`, name: s.name, args: parseJsonObject(s.args) }));
    return { text, toolCalls, inputTokens, outputTokens };
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
