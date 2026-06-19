import { describe, expect, it } from 'vitest';
import type { AgentRunOptions, Issue, WorkspaceHandle, WorkspaceIO } from '../core/types.js';
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
const io = {} as unknown as WorkspaceIO; // the fake transport ignores it

function fakeTransport(events: AgentEvent[], capture?: (spec: AgentTurnSpec) => void): AgentTransport {
  return {
    provider: 'claude',
    transport: 'cli',
    async preflight() {
      return { ok: true };
    },
    async run(spec, onEvent) {
      capture?.(spec);
      for (const e of events) onEvent(e);
    },
  };
}

describe('GenericAgent', () => {
  it('aggregates the final usage and reports success', async () => {
    const agent = new GenericAgent(
      fakeTransport([
        { type: 'usage', costUsd: 0.03, inputTokens: 12, outputTokens: 8 },
        { type: 'done', exitCode: 0 },
      ]),
      { primary: true, models: {}, io },
    );
    const res = await agent.run(workspace, issue, opts);
    expect(res.costUsd).toBeCloseTo(0.03);
    expect(res.inputTokens).toBe(12);
    expect(res.outputTokens).toBe(8);
    expect(res.exitCode).toBe(0);
    expect(res.ok).toBe(true);
  });

  it('reports failure when an error event arrives', async () => {
    const agent = new GenericAgent(
      fakeTransport([
        { type: 'error', error: 'crashed', message: 'boom' },
        { type: 'done', exitCode: 1 },
      ]),
      { primary: true, models: {}, io },
    );
    const res = await agent.run(workspace, issue, opts);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('crashed');
  });

  it('resolves the per-stage model and passes the workspace handle', async () => {
    let seen: AgentTurnSpec | undefined;
    const agent = new GenericAgent(
      fakeTransport([{ type: 'done', exitCode: 0 }], (spec) => {
        seen = spec;
      }),
      { primary: true, models: { implementation: 'sonnet' }, io },
    );
    await agent.run(workspace, issue, opts);
    expect(seen?.model).toBe('sonnet');
    expect(seen?.handle.workdir).toBe('/tmp/ws');
  });
});
