import { describe, expect, it } from 'vitest';
import {
  activityEvents,
  applyUsage,
  looksLikeAuth,
  looksLikeRateLimit,
  parseStreamLine,
  type UsageAcc,
} from './stream-json.js';

describe('stream-json parsing', () => {
  it('parses JSON lines and ignores noise', () => {
    expect(parseStreamLine('{"type":"result"}')).toEqual({ type: 'result' });
    expect(parseStreamLine('plain log line')).toBeNull();
    expect(parseStreamLine('{not json')).toBeNull();
  });

  it('extracts tool_use and text activity', () => {
    const event = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } },
          { type: 'text', text: '  doing the thing  ' },
        ],
      },
    };
    expect(activityEvents(event)).toEqual([
      { type: 'tool_use', name: 'Edit: src/a.ts' },
      { type: 'text', text: 'doing the thing' },
    ]);
  });

  it('accumulates usage: cumulative cost replaced, tokens summed', () => {
    const acc: UsageAcc = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
    applyUsage({ type: 'assistant', usage: { input_tokens: 10, output_tokens: 5 } }, acc);
    applyUsage({ type: 'result', total_cost_usd: 0.42, usage: { input_tokens: 2, output_tokens: 3 } }, acc);
    expect(acc.costUsd).toBeCloseTo(0.42);
    expect(acc.inputTokens).toBe(12);
    expect(acc.outputTokens).toBe(8);
  });

  it('detects auth failures', () => {
    expect(looksLikeAuth('Error: invalid api key')).toBe(true);
    expect(looksLikeAuth('please run /login first')).toBe(true);
    expect(looksLikeAuth('everything is fine')).toBe(false);
  });

  it('detects usage/rate limits (failover trigger)', () => {
    expect(looksLikeRateLimit('You have reached your usage limit')).toBe(true);
    expect(looksLikeRateLimit('rate limit exceeded, resets at 5pm')).toBe(true);
    expect(looksLikeRateLimit('HTTP 429 Too Many Requests')).toBe(true);
    expect(looksLikeRateLimit('quota exceeded for this project')).toBe(true);
    expect(looksLikeRateLimit('wrote the plan successfully')).toBe(false);
  });
});
