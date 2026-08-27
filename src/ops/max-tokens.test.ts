/**
 * `agent.max_tokens` reaching the wire.
 *
 * The schema accepted the field, validated it, and nothing ever read it — so a person who
 * wrote a measured number had every reason to think it applied (CRL-93). The limit matters
 * in both directions: too low and the JSON is cut mid-answer and the whole paid turn is
 * discarded by the shape check; too high and reasoning tokens spend what they are given.
 * Gemini counts its thinking against the same allowance, which is why one constant cannot
 * serve every pipeline.
 *
 * The schema tests already cover "the field is accepted". What was missing, and what these
 * check, is that it is *used*.
 */
import { describe, expect, it, vi } from 'vitest';
import { AnthropicChatClient } from '../agent/claude-api.js';
import { GeminiChatClient } from '../agent/google-api.js';
import { OpenAiChatClient } from '../agent/openai-api.js';
import { PipelineSchema } from './pipeline/schema.js';

/** An empty SSE stream — enough to get past the request and read what was sent. */
function stubFetch(): { body: () => Record<string, unknown> } {
  const calls: RequestInit[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    calls.push(init);
    return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
  });
  return { body: () => JSON.parse(String(calls[0]!.body)) as Record<string, unknown> };
}

const step = (over: Record<string, unknown> = {}) =>
  PipelineSchema.parse({
    key: 'p',
    trigger: { kind: 'manual' },
    input: { kind: 'none' },
    agent: {
      prompt: { system: 's', user_template: 'u' },
      schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      ...over,
    },
    output: { kind: 'none' },
  }).agent;

describe('what the definition says reaches the request', () => {
  it('Claude sends the declared limit instead of the built-in constant', async () => {
    const seen = stubFetch();
    await new AnthropicChatClient('k').send([{ role: 'user', content: 'x' }], [], undefined, { maxOutputTokens: 4096 });
    expect(seen.body().max_tokens).toBe(4096);
  });

  it('Gemini sends it, where thinking tokens share the allowance', async () => {
    const seen = stubFetch();
    await new GeminiChatClient('k').send([{ role: 'user', content: 'x' }], [], undefined, { maxOutputTokens: 4096 });
    expect(seen.body().generationConfig).toEqual({ maxOutputTokens: 4096 });
  });

  it('GPT sends it under the name the reasoning models accept', async () => {
    // `max_tokens` is rejected by the o-series; `max_completion_tokens` is the current name.
    const seen = stubFetch();
    await new OpenAiChatClient('k').send([{ role: 'user', content: 'x' }], [], undefined, { maxOutputTokens: 4096 });
    expect(seen.body().max_completion_tokens).toBe(4096);
    expect(seen.body().max_tokens).toBeUndefined();
  });
});

describe('a definition that says nothing', () => {
  /**
   * The acceptance criterion is "omitting it behaves as it does today". Today Claude runs at
   * the built-in 8192 and the other two run at whatever the provider decides — so a default
   * applied here would silently narrow every pipeline already running.
   */
  it('leaves the field out of the schema rather than defaulting it', () => {
    expect(step().max_tokens).toBeUndefined();
  });

  it('Claude keeps its built-in constant', async () => {
    const seen = stubFetch();
    await new AnthropicChatClient('k').send([{ role: 'user', content: 'x' }], [], undefined, {});
    expect(seen.body().max_tokens).toBe(8192);
  });

  it.each([
    ['Gemini', () => new GeminiChatClient('k'), 'generationConfig'],
    ['GPT', () => new OpenAiChatClient('k'), 'max_completion_tokens'],
  ])('%s says nothing, as before', async (_name, make, key) => {
    const seen = stubFetch();
    await make().send([{ role: 'user', content: 'x' }], [], undefined, {});
    expect(seen.body()[key]).toBeUndefined();
  });
});

describe('the value a pipeline declares', () => {
  it('survives parsing', () => {
    expect(step({ max_tokens: 2048 }).max_tokens).toBe(2048);
  });

  it('is still refused when it is not a positive integer', () => {
    expect(() => step({ max_tokens: 0 })).toThrow();
    expect(() => step({ max_tokens: -1 })).toThrow();
  });
});
