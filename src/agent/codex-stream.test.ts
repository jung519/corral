import { describe, expect, it } from 'vitest';
import { CodexStreamParser } from './codex-stream.js';
import type { UsageAcc } from './stream-json.js';

const lines = (p: CodexStreamParser, raw: string[]) => raw.map((l) => p.parse(l));

describe('CodexStreamParser', () => {
  it('parses JSONL and ignores non-JSON noise', () => {
    const p = new CodexStreamParser();
    expect(p.parse('Reading additional input from stdin...')).toBeNull();
    expect(p.parse('')).toBeNull();
    expect(p.parse('{"type":"turn.started"}')).toEqual({ type: 'turn.started' });
  });

  it('captures thread_id (for session resume) from thread.started', () => {
    const p = new CodexStreamParser();
    p.activity({ type: 'thread.started', thread_id: 'abc-123' });
    expect(p.threadId).toBe('abc-123');
  });

  it('emits assistant text from item.completed agent_message', () => {
    const p = new CodexStreamParser();
    const ev = p.parse('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hi."}}')!;
    expect(p.activity(ev)).toEqual([{ type: 'text', text: 'Hi.' }]);
  });

  it('maps command/file items to tool_use', () => {
    const p = new CodexStreamParser();
    expect(p.activity({ type: 'item.completed', item: { type: 'command_execution', command: 'ls -la' } })).toEqual([
      { type: 'tool_use', name: 'command: ls -la' },
    ]);
    expect(p.activity({ type: 'item.completed', item: { type: 'file_change', path: 'src/a.ts' } })).toEqual([
      { type: 'tool_use', name: 'edit: src/a.ts' },
    ]);
  });

  it('accumulates usage from turn.completed', () => {
    const p = new CodexStreamParser();
    const acc: UsageAcc = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
    p.usage(
      { type: 'turn.completed', usage: { input_tokens: 1000, output_tokens: 50, reasoning_output_tokens: 20 } },
      acc,
    );
    expect(acc.inputTokens).toBe(1000);
    expect(acc.outputTokens).toBe(70); // output + reasoning
    expect(acc.costUsd).toBe(0); // CLI JSONL has no USD cost
  });

  it('detects auth failure / rate limit from the raw line', () => {
    const p = new CodexStreamParser();
    const auth = '{"type":"error","message":"401 Unauthorized"}';
    expect(p.isAuthFailure(p.parse(auth)!, auth)).toBe(true);
    const rate = '{"type":"error","message":"429 rate limit reached"}';
    expect(p.isRateLimit(p.parse(rate)!, rate)).toBe(true);
  });

  it('does NOT flag auth from agent-message text that merely reviews auth code', () => {
    const p = new CodexStreamParser();
    // A successful review whose text discusses authentication — must not read as a failure.
    const msg = '{"type":"item.completed","item":{"type":"agent_message","text":"The authentication and oauth flow in login.ts looks fine; no unauthorized access."}}';
    expect(p.isAuthFailure(p.parse(msg)!, msg)).toBe(false);
    expect(p.isRateLimit(p.parse(msg)!, msg)).toBe(false);
  });

  it('handles a full realistic turn', () => {
    const p = new CodexStreamParser();
    const raw = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"Done."}}',
      '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":6}}',
    ];
    const acc: UsageAcc = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
    const texts: string[] = [];
    for (const ev of lines(p, raw)) {
      if (!ev) continue;
      for (const a of p.activity(ev)) if (a.type === 'text') texts.push(a.text);
      p.usage(ev, acc);
    }
    expect(p.threadId).toBe('t1');
    expect(texts).toEqual(['Done.']);
    expect(acc.inputTokens).toBe(12);
    expect(acc.outputTokens).toBe(6);
  });
});
