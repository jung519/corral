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

let lastUrl: string;
let lastBody: any;
/** Mock fetch to capture the request and return the given lines as an SSE stream body. */
function mockSse(lines: string[]) {
  const payload = lines.map((l) => `data: ${l}`).join('\n\n') + '\n\ndata: [DONE]\n\n';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      lastUrl = url;
      lastBody = JSON.parse(init.body);
      return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }),
  );
}
const collectText = () => {
  const chunks: string[] = [];
  return { chunks, onText: (d: string) => chunks.push(d) };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAiChatClient (streaming)', () => {
  it('streams text, accumulates fragmented tool_calls, reads usage', async () => {
    mockSse([
      '{"choices":[{"delta":{"content":"ne"}}]}',
      '{"choices":[{"delta":{"content":"xt"}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"bash","arguments":"{\\"command\\":"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"echo hi\\"}"}}]}}]}',
      '{"choices":[{"delta":{}}],"usage":{"prompt_tokens":12,"completion_tokens":7}}',
    ]);
    const { chunks, onText } = collectText();
    const turn = await new OpenAiChatClient('k').send(convo, [BASH_TOOL], 'gpt-5-mini', { onText });

    expect(lastBody.stream).toBe(true);
    expect(lastBody.messages.filter((m: any) => m.role === 'tool')).toHaveLength(2);
    expect(chunks).toEqual(['ne', 'xt']); // streamed live
    expect(turn.toolCalls).toEqual([{ id: 'c1', name: 'bash', args: { command: 'echo hi' } }]);
    expect(turn).toMatchObject({ text: 'next', inputTokens: 12, outputTokens: 7 });
  });
});

describe('AnthropicChatClient (streaming)', () => {
  it('hoists a cached system, coalesces tool results, streams text + tool_use blocks', async () => {
    mockSse([
      '{"type":"message_start","message":{"usage":{"input_tokens":20}}}',
      '{"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
      '{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"u1","name":"bash"}}',
      '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}',
      '{"type":"message_delta","usage":{"output_tokens":9}}',
    ]);
    const { chunks, onText } = collectText();
    const turn = await new AnthropicChatClient('k').send(convo, [BASH_TOOL], 'sonnet', { onText });

    expect(lastBody.stream).toBe(true);
    expect(lastBody.system[0].text).toBe('GUIDE');
    expect(lastBody.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(lastBody.model).toBe('claude-sonnet-4-5'); // alias resolved
    const toolResultMsgs = lastBody.messages.filter((m: any) => m.content.some((b: any) => b.type === 'tool_result'));
    expect(toolResultMsgs).toHaveLength(1); // both results coalesced
    expect(chunks).toEqual(['ok']);
    expect(turn.toolCalls).toEqual([{ id: 'u1', name: 'bash', args: { command: 'ls' } }]);
    expect(turn).toMatchObject({ text: 'ok', inputTokens: 20, outputTokens: 9 });
  });
});

describe('GeminiChatClient (streaming)', () => {
  it('uses the SSE endpoint, streams text, parses functionCall + usage', async () => {
    mockSse([
      '{"candidates":[{"content":{"parts":[{"text":"do"}]}}]}',
      '{"candidates":[{"content":{"parts":[{"text":"ne"},{"functionCall":{"name":"bash","args":{"command":"ls"}}}]}}],"usageMetadata":{"promptTokenCount":15,"candidatesTokenCount":4}}',
    ]);
    const { chunks, onText } = collectText();
    const turn = await new GeminiChatClient('k').send(convo, [BASH_TOOL], 'flash', { onText });

    expect(lastUrl).toContain('streamGenerateContent?alt=sse');
    expect(lastBody.systemInstruction.parts[0].text).toBe('GUIDE');
    const fnRespEntries = lastBody.contents.filter((c: any) => c.parts.some((p: any) => p.functionResponse));
    expect(fnRespEntries).toHaveLength(1);
    expect(lastBody.tools[0].functionDeclarations[0].parameters.additionalProperties).toBeUndefined();
    expect(chunks).toEqual(['do', 'ne']);
    expect(turn.toolCalls[0]).toMatchObject({ name: 'bash', args: { command: 'ls' } });
    expect(turn).toMatchObject({ text: 'done', inputTokens: 15, outputTokens: 4 });
  });
});
