/**
 * Gemini (google) API transport — BYOK calls to the Generative Language API, driven
 * through the shared agentic loop (api-loop.ts). The model gets the single `bash` tool and
 * edits the workspace by issuing shell commands. Uses global fetch — no SDK dependency.
 */
import {
  ApiHttpError,
  type ChatClient,
  type ChatTurn,
  type NeutralMessage,
  runApiAgent,
  type ToolDef,
} from './api-loop.js';
import type { AgentEvent, AgentTransport, AgentTurnSpec, PreflightResult } from './types.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash';

// Wizard offers aliases (pro/flash/flash-lite); the REST API needs a concrete model id.
const MODEL_ALIAS: Record<string, string> = {
  pro: 'gemini-2.5-pro',
  flash: 'gemini-2.5-flash',
  'flash-lite': 'gemini-2.5-flash-lite',
};
function resolveModel(model: string | undefined): string {
  if (!model) return DEFAULT_MODEL;
  return MODEL_ALIAS[model] ?? model;
}

interface Part {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}
interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

/** Map the neutral conversation to Gemini's systemInstruction + contents shape. Function
 *  responses need the call's NAME (Gemini has no call ids), so track id→name. */
function toGemini(messages: NeutralMessage[]): { system: string; contents: Content[] } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const idToName = new Map<string, string>();
  const contents: Content[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (m.role === 'assistant') {
      const parts: Part[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const c of m.toolCalls ?? []) {
        parts.push({ functionCall: { name: c.name, args: c.args } });
        idToName.set(c.id, c.name);
      }
      contents.push({ role: 'model', parts });
    } else {
      const name = (m.toolCallId && idToName.get(m.toolCallId)) || 'bash';
      const part: Part = { functionResponse: { name, response: { output: m.content } } };
      const last = contents[contents.length - 1];
      if (last && last.role === 'user') last.parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
    }
  }
  return { system, contents };
}

/** Gemini's function schema is an OpenAPI subset — drop fields it rejects (additionalProperties). */
function toGeminiSchema(parameters: Record<string, unknown>): Record<string, unknown> {
  const { additionalProperties, ...rest } = parameters;
  void additionalProperties;
  return rest;
}

export class GeminiChatClient implements ChatClient {
  readonly provider = 'gemini' as const;

  constructor(private readonly apiKey: string | null) {}

  async preflight(): Promise<PreflightResult> {
    if (!this.apiKey) return { ok: false, detail: 'missing Google API key (BYOK) for gemini:api transport' };
    return { ok: true };
  }

  async send(messages: NeutralMessage[], tools: ToolDef[], model: string | undefined, signal?: AbortSignal): Promise<ChatTurn> {
    const { system, contents } = toGemini(messages);
    const res = await fetch(`${BASE}/${resolveModel(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey ?? '' },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents,
        tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) })) }],
      }),
      signal,
    });
    if (!res.ok) throw new ApiHttpError(res.status, `Gemini ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const body = (await res.json()) as {
      candidates?: { content?: { parts?: Part[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const parts = body.candidates?.[0]?.content?.parts ?? [];
    return {
      text: parts
        .filter((p) => typeof p.text === 'string')
        .map((p) => p.text)
        .join(''),
      toolCalls: parts
        .filter((p): p is Part & { functionCall: { name: string; args?: Record<string, unknown> } } => !!p.functionCall)
        .map((p, i) => ({ id: `gem_${i}_${p.functionCall.name}`, name: p.functionCall.name, args: p.functionCall.args ?? {} })),
      inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }
}

export class GeminiApiTransport implements AgentTransport {
  readonly provider = 'gemini' as const;
  readonly transport = 'api' as const;
  private readonly client: GeminiChatClient;

  constructor(apiKey: string | null) {
    this.client = new GeminiChatClient(apiKey);
  }

  preflight(): Promise<PreflightResult> {
    return this.client.preflight();
  }

  run(spec: AgentTurnSpec, onEvent: (event: AgentEvent) => void): Promise<void> {
    return runApiAgent(this.client, spec, onEvent);
  }
}
