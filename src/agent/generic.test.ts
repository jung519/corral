import { describe, expect, it } from 'vitest';
import type { AgentRunOptions, Issue, WorkspaceHandle } from '../core/types.js';
import { GenericAgent } from './generic.js';
import type { AgentEvent, AgentTransport, AgentTurnSpec } from './types.js';

const issue: Issue = {
  identifier: 'ISS-1',
  internalId: 'x',
  title: 't',
  description: '',
  state: 'in_progress',
  labels: [],
  blockedBy: [],
  attachments: [],
};
const workspace: WorkspaceHandle = { id: 'ISS-1', workdir: '/tmp/ws', backend: 'local' };
const opts: AgentRunOptions = { stage: 'implementation', workflow: '', prompt: 'go', continueSession: false };

function transportYielding(events: AgentEvent[], capture?: (spec: AgentTurnSpec) => void): AgentTransport {
  return {
    provider: 'claude',
    transport: 'api',
    async preflight() {
      return { ok: true };
    },
    async *run(spec: AgentTurnSpec) {
      capture?.(spec);
      for (const ev of events) yield ev;
    },
  };
}

describe('GenericAgent', () => {
  it('aggregates usage events and reports success', async () => {
    const agent = new GenericAgent(
      transportYielding([
        { type: 'usage', inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
        { type: 'usage', inputTokens: 2, outputTokens: 3, costUsd: 0.02 },
        { type: 'done', exitCode: 0 },
      ]),
      { primary: true, models: {} },
    );
    const res = await agent.run(workspace, issue, opts);
    expect(res.inputTokens).toBe(12);
    expect(res.outputTokens).toBe(8);
    expect(res.costUsd).toBeCloseTo(0.03);
    expect(res.exitCode).toBe(0);
    expect(res.ok).toBe(true);
  });

  it('reports failure when an error event arrives', async () => {
    const agent = new GenericAgent(
      transportYielding([
        { type: 'error', error: 'crashed', message: 'boom' },
        { type: 'done', exitCode: 1 },
      ]),
      { primary: true, models: {} },
    );
    const res = await agent.run(workspace, issue, opts);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('crashed');
  });

  it('resolves the per-stage model from config', async () => {
    let seen: AgentTurnSpec | undefined;
    const agent = new GenericAgent(
      transportYielding([{ type: 'done', exitCode: 0 }], (spec) => {
        seen = spec;
      }),
      { primary: true, models: { implementation: 'sonnet' } },
    );
    await agent.run(workspace, issue, opts);
    expect(seen?.model).toBe('sonnet');
    expect(seen?.cwd).toBe('/tmp/ws');
  });
});
