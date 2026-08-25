/**
 * What a CLI turn costs, when the CLI does not say.
 *
 * `claude` reports `total_cost_usd` and is believed — it knows the account's terms, which
 * may include a plan no price table can express. `codex` and `gemini` report tokens and no
 * money at all, and that was recorded as $0.00: a pipeline could run all day against a
 * ceiling that read nothing (CRL-86).
 *
 * Run against real spawned processes rather than a mock, because the thing being checked is
 * where the estimate lands in the turn's lifecycle — after the stream ends, before the
 * `usage` event goes out.
 */
import { describe, expect, it } from 'vitest';
import { runCliTurn } from './cli-runner.js';
import { CodexStreamParser } from './codex-stream.js';
import { GeminiStreamParser } from './gemini-stream.js';
import { logger } from '../core/logger.js';
import { applyUsage, parseStreamLine, type StreamEvent } from './stream-json.js';
import type { CliStreamParser as Parser } from './cli-runner.js';
import type { AgentEvent, AgentTurnSpec } from './types.js';

const claudeParser: Parser<StreamEvent> = {
  provider: 'claude',
  parse: parseStreamLine,
  activity: () => [],
  usage: applyUsage,
  isAuthFailure: () => false,
};

/** Spawn `node -e` printing the given JSONL lines, and collect the usage event. */
async function usageOf<T>(parser: Parser<T>, lines: string[], model?: string) {
  const script = lines.map((l) => `console.log(${JSON.stringify(l)})`).join(';');
  const events: AgentEvent[] = [];
  await runCliTurn(
    { model, continueSession: false } as AgentTurnSpec,
    { command: process.execPath, args: ['-e', script], env: process.env },
    parser,
    (e) => events.push(e),
    logger.child('cli-cost-test'),
  );
  return events.find((e) => e.type === 'usage') as Extract<AgentEvent, { type: 'usage' }>;
}

describe('a CLI that reports its own cost', () => {
  it('is believed, and the table does not second-guess it', async () => {
    // The table would price this turn far higher; the CLI knows what the account was
    // actually charged, including a subscription this file cannot model.
    const usage = await usageOf(
      claudeParser,
      ['{"type":"result","total_cost_usd":1.9683,"usage":{"input_tokens":2,"cache_read_input_tokens":1603497,"output_tokens":21324}}'],
      'opus',
    );

    expect(usage.costUsd).toBe(1.9683);
    expect(usage.inputTokens).toBe(1_603_499);
  });
});

describe('a CLI that reports none', () => {
  it('codex: is estimated instead of counted as free', async () => {
    const usage = await usageOf(
      new CodexStreamParser(),
      ['{"type":"turn.completed","usage":{"input_tokens":1000000,"cached_input_tokens":0,"output_tokens":0}}'],
      'gpt-5',
    );

    expect(usage.costUsd).toBeCloseTo(1.25);
  });

  it('codex: the cached part is priced as cache, not as fresh input', async () => {
    // Measured on codex-cli: `cached_input_tokens` is a subset of `input_tokens`, not an
    // addition to it — one turn reported 14,293 input, and the same session with ~7.5k
    // tokens of extra text reported 21,813, a delta that matches the text added.
    const usage = await usageOf(
      new CodexStreamParser(),
      ['{"type":"turn.completed","usage":{"input_tokens":1000000,"cached_input_tokens":1000000,"output_tokens":0}}'],
      'gpt-5',
    );

    expect(usage.inputTokens).toBe(1_000_000);
    expect(usage.costUsd).toBeCloseTo(0.625); // half price, not full
  });

  it('gemini: is estimated too', async () => {
    const usage = await usageOf(
      new GeminiStreamParser(),
      ['{"type":"result","stats":{"input_tokens":1000000,"output_tokens":0}}'],
      'flash',
    );

    expect(usage.costUsd).toBeCloseTo(0.3);
  });
});

describe('a turn that spent nothing', () => {
  it('stays free rather than picking up a floor price', async () => {
    // A crash before the first token is not a cost, and an estimate applied to zero tokens
    // would put one on the day's total.
    const usage = await usageOf(new CodexStreamParser(), ['{"type":"turn.started"}'], 'gpt-5');

    expect(usage).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });
});
