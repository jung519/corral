import { describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentRunOptions, AgentRunResult, AgentStage, Issue, WorkspaceHandle } from '../core/types.js';
import { StageRoutingAgent } from './stage-router.js';

const ok = (): AgentRunResult => ({ ok: true, costUsd: 0, inputTokens: 0, outputTokens: 0, exitCode: 0 });

class FakeAgent implements AgentAdapter {
  readonly primary = true;
  calls: AgentRunOptions[] = [];
  constructor(readonly kind: string) {}
  run(_w: WorkspaceHandle, _i: Issue, opts: AgentRunOptions): Promise<AgentRunResult> {
    this.calls.push(opts);
    return Promise.resolve(ok());
  }
}

const ws = { id: 'iss-1' } as WorkspaceHandle;
const issue = {} as Issue;
const opt = (stage: AgentStage, continueSession: boolean): AgentRunOptions =>
  ({ stage, workflow: '', prompt: 'p', continueSession }) as AgentRunOptions;

describe('StageRoutingAgent', () => {
  it('routes each stage to its configured agent', async () => {
    const plan = new FakeAgent('gemini');
    const build = new FakeAgent('claude');
    const review = new FakeAgent('gpt');
    const r = new StageRoutingAgent({ planning: plan, implementation: build, review });
    await r.run(ws, issue, opt('planning', false));
    await r.run(ws, issue, opt('implementation', false));
    await r.run(ws, issue, opt('review', false));
    expect(plan.calls).toHaveLength(1);
    expect(build.calls).toHaveLength(1);
    expect(review.calls).toHaveLength(1);
    expect(r.kind).toBe('gemini / claude / gpt');
  });

  it('forces a fresh session when the stage agent changes (provider switch)', async () => {
    const plan = new FakeAgent('gemini');
    const build = new FakeAgent('claude');
    const r = new StageRoutingAgent({ planning: plan, implementation: build, review: plan });
    await r.run(ws, issue, opt('planning', false)); // first turn, fresh
    await r.run(ws, issue, opt('implementation', true)); // wants continue, but agent switched
    expect(build.calls[0]!.continueSession).toBe(false); // forced fresh — can't resume gemini's session
  });

  it('keeps continueSession within the same agent', async () => {
    const a = new FakeAgent('claude');
    const r = new StageRoutingAgent({ planning: a, implementation: a, review: a });
    await r.run(ws, issue, opt('planning', false));
    await r.run(ws, issue, opt('implementation', true)); // same agent → continue honored
    expect(a.calls[1]!.continueSession).toBe(true);
  });
});
