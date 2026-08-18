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

  /**
   * The numbers below are copied from a real `claude -p` stream, not invented. Reading
   * `input_tokens` alone counted 2 of the 4,037 tokens the turn was billed for, and that
   * count is what the shared daily ceiling is made of (CRL-58).
   */
  it('counts every input token the turn was billed for', () => {
    const acc: UsageAcc = { costUsd: 0, inputTokens: 0, outputTokens: 0 };

    applyUsage(
      {
        type: 'result',
        total_cost_usd: 0.08092,
        usage: { input_tokens: 2, cache_creation_input_tokens: 4035, cache_read_input_tokens: 0, output_tokens: 4 },
      },
      acc,
    );

    expect(acc).toEqual({ costUsd: 0.08092, inputTokens: 4037, outputTokens: 4 });
  });

  it('counts a cache read too — cheaper than the rest, not free', () => {
    const acc: UsageAcc = { costUsd: 0, inputTokens: 0, outputTokens: 0 };

    applyUsage(
      { type: 'result', usage: { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 4035, output_tokens: 7 } },
      acc,
    );

    expect(acc.inputTokens).toBe(4047);
  });

  it('takes the turn tally rather than adding up whatever carried numbers', () => {
    // Both events report the same totals for the turn. Summing them counted it twice —
    // which happened not to bite only because the assistant event keeps its usage under
    // `message`, where this never looked.
    const acc: UsageAcc = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
    const usage = { input_tokens: 2, cache_creation_input_tokens: 4035, output_tokens: 4 };

    applyUsage({ type: 'assistant', usage }, acc);
    applyUsage({ type: 'result', total_cost_usd: 0.42, usage }, acc);

    expect(acc).toEqual({ costUsd: 0.42, inputTokens: 4037, outputTokens: 4 });
  });

  it('leaves the tally alone for an event that carries no usage', () => {
    const acc: UsageAcc = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
    applyUsage({ type: 'result', usage: { input_tokens: 9, output_tokens: 3 } }, acc);

    applyUsage({ type: 'assistant' }, acc);

    expect(acc).toMatchObject({ inputTokens: 9, outputTokens: 3 });
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
