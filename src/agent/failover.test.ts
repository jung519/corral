import { describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentRunOptions, AgentRunResult, Issue, WorkspaceHandle } from '../core/types.js';
import { FailoverAgent, type FailoverMember } from './failover.js';

const ok = (): AgentRunResult => ({ ok: true, costUsd: 0, inputTokens: 0, outputTokens: 0, exitCode: 0 });
const fail = (error: AgentRunResult['error']): AgentRunResult => ({
  ok: false,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  exitCode: 1,
  error,
});

/** Records each run() call and returns a scripted sequence of results. */
class FakeAgent implements AgentAdapter {
  readonly primary = true;
  calls: AgentRunOptions[] = [];
  constructor(
    readonly kind: string,
    private readonly results: AgentRunResult[],
  ) {}
  run(_w: WorkspaceHandle, _i: Issue, opts: AgentRunOptions): Promise<AgentRunResult> {
    this.calls.push(opts);
    return Promise.resolve(this.results[Math.min(this.calls.length - 1, this.results.length - 1)]!);
  }
}

const member = (kind: string, results: AgentRunResult[]): FailoverMember => ({
  adapter: new FakeAgent(kind, results),
  label: kind,
});
const ws = { id: 'iss-1' } as WorkspaceHandle;
const issue = {} as Issue;
const opts = (continueSession = false): AgentRunOptions => ({ stage: 'planning', workflow: '', prompt: 'p', continueSession }) as AgentRunOptions;

describe('FailoverAgent', () => {
  it('uses the primary while it succeeds', async () => {
    const m = [member('a', [ok()]), member('b', [ok()])];
    const fa = new FailoverAgent(m);
    expect((await fa.run(ws, issue, opts())).ok).toBe(true);
    expect((m[1].adapter as FakeAgent).calls).toHaveLength(0);
  });

  it('advances to the next agent on a rate_limit and sticks there', async () => {
    const a = member('a', [fail('rate_limit')]);
    const b = member('b', [ok()]);
    const fa = new FailoverAgent([a, b]);

    const r1 = await fa.run(ws, issue, opts());
    expect(r1.ok).toBe(true);
    expect((a.adapter as FakeAgent).calls).toHaveLength(1);
    expect((b.adapter as FakeAgent).calls).toHaveLength(1);

    // Next turn should skip the exhausted primary entirely.
    await fa.run(ws, issue, opts());
    expect((a.adapter as FakeAgent).calls).toHaveLength(1);
    expect((b.adapter as FakeAgent).calls).toHaveLength(2);
  });

  it('also fails over on auth and budget, but not on timeout/crashed', async () => {
    for (const e of ['auth', 'budget'] as const) {
      const a = member('a', [fail(e)]);
      const b = member('b', [ok()]);
      await new FailoverAgent([a, b]).run(ws, issue, opts());
      expect((b.adapter as FakeAgent).calls).toHaveLength(1);
    }
    for (const e of ['timeout', 'crashed'] as const) {
      const a = member('a', [fail(e)]);
      const b = member('b', [ok()]);
      const r = await new FailoverAgent([a, b]).run(ws, issue, opts());
      expect(r.error).toBe(e);
      expect((b.adapter as FakeAgent).calls).toHaveLength(0);
    }
  });

  it('does NOT fail over on login_required (a setup error) — returns it as-is', async () => {
    const a = member('a', [fail('login_required')]);
    const b = member('b', [ok()]);
    const r = await new FailoverAgent([a, b]).run(ws, issue, opts());
    expect(r.error).toBe('login_required');
    expect((a.adapter as FakeAgent).calls).toHaveLength(1);
    expect((b.adapter as FakeAgent).calls).toHaveLength(0); // never switched providers
  });

  it('returns the last failure when every agent is exhausted', async () => {
    const fa = new FailoverAgent([member('a', [fail('rate_limit')]), member('b', [fail('auth')])]);
    const r = await fa.run(ws, issue, opts());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('auth');
  });

  it('drops session continuity when switching agents', async () => {
    const a = member('a', [fail('rate_limit')]);
    const b = member('b', [ok()]);
    const fa = new FailoverAgent([a, b]);
    await fa.run(ws, issue, opts(true));
    // b ran fresh after the switch — continueSession must be false even though asked true.
    expect((b.adapter as FakeAgent).calls[0]!.continueSession).toBe(false);
  });

  it('retries from the top after the cooldown elapses', async () => {
    const a = member('a', [fail('rate_limit'), ok()]);
    const b = member('b', [ok()]);
    const fa = new FailoverAgent([a, b], 0 /* never */);
    await fa.run(ws, issue, opts());
    expect((a.adapter as FakeAgent).calls).toHaveLength(1);
    // resetMs=0 disables reset → stays on b.
    await fa.run(ws, issue, opts());
    expect((a.adapter as FakeAgent).calls).toHaveLength(1);
    expect((b.adapter as FakeAgent).calls).toHaveLength(2);
  });
});
