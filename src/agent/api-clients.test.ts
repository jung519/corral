import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicChatClient } from './claude-api.js';
import { BASH_TOOL, type NeutralMessage } from './api-loop.js';
import { GeminiChatClient } from './google-api.js';
import { OpenAiChatClient } from './openai-api.js';

// A conversation that has reached: system, user, an assistant turn with TWO tool calls,
// then both tool results — the shape that exercises provider-specific coalescing.
const convo: NeutralMessage[] = [
  { role: 'system', content: 'GUIDE' },
  { role: 'user', content: 'do it' },
  {
    role: 'assistant',
    content: 'working',
    toolCalls: [
      { id: 'a', name: 'bash', args: { command: 'ls' } },
      { id: 'b', name: 'bash', args: { command: 'pwd' } },
    ],
  },
  { role: 'tool', content: 'file.txt', toolCallId: 'a' },
  { role: 'tool', content: '/work', toolCallId: 'b' },
];

let lastBody: any;
function mockFetch(response: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      lastBody = JSON.parse(init.body);
      return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  lastBody = undefined;
});

describe('OpenAiChatClient', () => {
  it('sends tool messages and parses tool_calls + usage', async () => {
    mockFetch({
      choices: [{ message: { content: 'next', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"echo hi"}' } }] } }],
      usage: { prompt_tokens: 12, completion_tokens: 7 },
    });
    const turn = await new OpenAiChatClient('k').send(convo, [BASH_TOOL], 'gpt-5-mini');
    // OpenAI keeps one message per tool result.
    expect(lastBody.messages.filter((m: any) => m.role === 'tool')).toHaveLength(2);
    expect(lastBody.tools[0].function.name).toBe('bash');
    expect(turn.toolCalls).toEqual([{ id: 'c1', name: 'bash', args: { command: 'echo hi' } }]);
    expect(turn).toMatchObject({ text: 'next', inputTokens: 12, outputTokens: 7 });
  });
});

describe('AnthropicChatClient', () => {
  it('hoists system, coalesces tool results into one user message, parses blocks', async () => {
    mockFetch({
      content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 'u1', name: 'bash', input: { command: 'ls' } },
      ],
      usage: { input_tokens: 20, output_tokens: 9 },
    });
    const turn = await new AnthropicChatClient('k').send(convo, [BASH_TOOL], 'sonnet');
    expect(lastBody.system[0].text).toBe('GUIDE'); // hoisted into a cached text block
    expect(lastBody.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(lastBody.model).toBe('claude-sonnet-4-5'); // alias resolved
    const toolResultMsgs = lastBody.messages.filter((m: any) => m.content.some((b: any) => b.type === 'tool_result'));
    expect(toolResultMsgs).toHaveLength(1); // both results coalesced
    expect(toolResultMsgs[0].content).toHaveLength(2);
    expect(turn.toolCalls).toEqual([{ id: 'u1', name: 'bash', args: { command: 'ls' } }]);
    expect(turn).toMatchObject({ text: 'ok', inputTokens: 20, outputTokens: 9 });
  });
});

describe('GeminiChatClient', () => {
  it('hoists systemInstruction, coalesces functionResponses, parses functionCall', async () => {
    mockFetch({
      candidates: [{ content: { parts: [{ text: 'done' }, { functionCall: { name: 'bash', args: { command: 'ls' } } }] } }],
      usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 4 },
    });
    const turn = await new GeminiChatClient('k').send(convo, [BASH_TOOL], 'flash');
    expect(lastBody.systemInstruction.parts[0].text).toBe('GUIDE');
    // Both function responses land in one user content entry.
    const fnRespEntries = lastBody.contents.filter((c: any) => c.parts.some((p: any) => p.functionResponse));
    expect(fnRespEntries).toHaveLength(1);
    expect(fnRespEntries[0].parts).toHaveLength(2);
    // additionalProperties stripped from the function schema.
    expect(lastBody.tools[0].functionDeclarations[0].parameters.additionalProperties).toBeUndefined();
    expect(turn.toolCalls[0]).toMatchObject({ name: 'bash', args: { command: 'ls' } });
    expect(turn).toMatchObject({ text: 'done', inputTokens: 15, outputTokens: 4 });
  });
});
