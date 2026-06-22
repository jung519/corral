import { describe, expect, it } from 'vitest';
import { GeminiStreamParser } from './gemini-stream.js';
import type { UsageAcc } from './stream-json.js';

describe('GeminiStreamParser', () => {
  it('parses JSON lines and ignores noise', () => {
    const p = new GeminiStreamParser();
    expect(p.parse('{"type":"init","model":"gemini-2.5-pro"}')).toEqual({ type: 'init', model: 'gemini-2.5-pro' });
    expect(p.parse('plain log line')).toBeNull();
    expect(p.parse('{not json')).toBeNull();
  });

  it('coalesces assistant text deltas into lines, flushing on newline', () => {
    const p = new GeminiStreamParser();
    expect(p.activity({ type: 'message', role: 'assistant', content: 'hello ', delta: true })).toEqual([]);
    expect(p.activity({ type: 'message', role: 'assistant', content: 'world\n', delta: true })).toEqual([
      { type: 'text', text: 'hello world' },
    ]);
    // Trailing text without a newline waits for flush().
    expect(p.activity({ type: 'message', role: 'assistant', content: 'tail', delta: true })).toEqual([]);
    expect(p.flush()).toEqual([{ type: 'text', text: 'tail' }]);
  });

  it('ignores the user echo and emits tool_use with a hint', () => {
    const p = new GeminiStreamParser();
    expect(p.activity({ type: 'message', role: 'user', content: 'the prompt' })).toEqual([]);
    expect(p.activity({ type: 'tool_use', tool_name: 'WriteFile', parameters: { file_path: 'src/a.ts' } })).toEqual([
      { type: 'tool_use', name: 'WriteFile: src/a.ts' },
    ]);
  });

  it('reads token usage from the result stats (no cost in the stream)', () => {
    const p = new GeminiStreamParser();
    const acc: UsageAcc = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
    p.usage({ type: 'result', status: 'success', stats: { input_tokens: 100, output_tokens: 40 } }, acc);
    expect(acc.inputTokens).toBe(100);
    expect(acc.outputTokens).toBe(40);
    expect(acc.costUsd).toBe(0);
  });

  it('flags auth failures only on error events', () => {
    const p = new GeminiStreamParser();
    const line = '{"type":"error","message":"request had invalid API key"}';
    expect(p.isAuthFailure({ type: 'error', message: 'request had invalid API key' }, line)).toBe(true);
    expect(p.isAuthFailure({ type: 'message', role: 'assistant' }, 'invalid api key')).toBe(false);
  });
});
