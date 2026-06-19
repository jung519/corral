import { afterEach, describe, expect, it } from 'vitest';
import { WebChannel } from '../channel/web.js';
import { DashboardServer } from './dashboard.js';

let server: DashboardServer | undefined;
afterEach(() => server?.stop());

function makeServer(channel: WebChannel): DashboardServer {
  return new DashboardServer(0, {
    snapshot: () => [],
    channel,
    listCandidates: async () => [{ identifier: 'ISS-1', title: 't', state: 'planning', inFlight: false }],
    startIssue: async (id) => ({ ok: true, message: id }),
    completeIssue: async () => ({ ok: true }),
    retryIssue: async () => ({ ok: true }),
    refineIssue: async () => ({ ok: true }),
  });
}

describe('DashboardServer', () => {
  it('serves /api/state with rendered pending actions', async () => {
    const channel = new WebChannel();
    await channel.sendApproval({ identifier: 'ISS-1', kind: 'plan', title: 't', body: '**hi**' });
    server = makeServer(channel);
    await server.start();

    const res = await fetch(`http://localhost:${server.boundPort}/api/state`);
    const body = (await res.json()) as { pending: Array<{ bodyHtml: string }> };
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0]?.bodyHtml).toContain('<strong>hi</strong>');
  });

  it('POST /api/action approve fires the channel callback and clears the pending action', async () => {
    const channel = new WebChannel();
    let approvedId: string | undefined;
    channel.onApprove((id) => {
      approvedId = id;
    });
    const actId = await channel.sendApproval({ identifier: 'ISS-1', kind: 'plan', title: 't', body: 'x' });
    server = makeServer(channel);
    await server.start();

    const res = await fetch(`http://localhost:${server.boundPort}/api/action`, {
      method: 'POST',
      body: JSON.stringify({ id: actId, type: 'approve' }),
    });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(approvedId).toBe(actId);
    expect(channel.getPending()).toHaveLength(0);
  });

  it('POST /api/start delegates to the orchestrator command', async () => {
    server = makeServer(new WebChannel());
    await server.start();
    const res = await fetch(`http://localhost:${server.boundPort}/api/start`, {
      method: 'POST',
      body: JSON.stringify({ identifier: 'ISS-9' }),
    });
    expect((await res.json()) as { ok: boolean; message?: string }).toEqual({ ok: true, message: 'ISS-9' });
  });
});
