import { afterEach, describe, expect, it } from 'vitest';
import { WebChannel } from '../channel/web.js';
import type { Orchestrator } from '../orchestrator.js';
import { DashboardServer, type SetupInput } from './dashboard.js';

let server: DashboardServer | undefined;
afterEach(() => server?.stop());

const fakeOrchestrator = {
  snapshot: () => [],
  listCandidates: async () => [{ identifier: 'ISS-1', title: 't', state: 'planning', inFlight: false }],
  startIssue: async (id: string) => ({ ok: true, message: id }),
  completeByUser: async () => ({ ok: true }),
  retry: async () => ({ ok: true }),
  refinePlan: async () => ({ ok: true }),
} as unknown as Orchestrator;

function makeServer(opts: {
  channel: WebChannel;
  orchestrator?: Orchestrator;
  setup?: (input: SetupInput) => Promise<{ ok: boolean; message?: string }>;
}) {
  return new DashboardServer(0, {
    channel: opts.channel,
    orchestrator: () => opts.orchestrator,
    setup: opts.setup ?? (async () => ({ ok: true })),
  });
}

describe('DashboardServer', () => {
  it('reports configured=false in setup mode and configured=true once an orchestrator exists', async () => {
    server = makeServer({ channel: new WebChannel() });
    await server.start();
    expect((await (await fetch(`http://localhost:${server.boundPort}/api/status`)).json()) as { configured: boolean }).toEqual({
      configured: false,
    });
    server.stop();

    server = makeServer({ channel: new WebChannel(), orchestrator: fakeOrchestrator });
    await server.start();
    expect((await (await fetch(`http://localhost:${server.boundPort}/api/status`)).json()) as { configured: boolean }).toEqual({
      configured: true,
    });
  });

  it('serves /api/state with rendered pending actions', async () => {
    const channel = new WebChannel();
    await channel.sendApproval({ identifier: 'ISS-1', kind: 'plan', title: 't', body: '**hi**' });
    server = makeServer({ channel, orchestrator: fakeOrchestrator });
    await server.start();

    const body = (await (await fetch(`http://localhost:${server.boundPort}/api/state`)).json()) as {
      pending: Array<{ bodyHtml: string }>;
    };
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0]?.bodyHtml).toContain('<strong>hi</strong>');
  });

  it('POST /api/start returns not-configured in setup mode, delegates once configured', async () => {
    server = makeServer({ channel: new WebChannel() }); // no orchestrator
    await server.start();
    const setupRes = (await (
      await fetch(`http://localhost:${server.boundPort}/api/start`, {
        method: 'POST',
        body: JSON.stringify({ identifier: 'ISS-9' }),
      })
    ).json()) as { ok: boolean };
    expect(setupRes.ok).toBe(false);
    server.stop();

    server = makeServer({ channel: new WebChannel(), orchestrator: fakeOrchestrator });
    await server.start();
    const res = (await (
      await fetch(`http://localhost:${server.boundPort}/api/start`, {
        method: 'POST',
        body: JSON.stringify({ identifier: 'ISS-9' }),
      })
    ).json()) as { ok: boolean; message?: string };
    expect(res).toEqual({ ok: true, message: 'ISS-9' });
  });

  it('POST /api/setup invokes the setup callback', async () => {
    let received: SetupInput | undefined;
    server = makeServer({
      channel: new WebChannel(),
      setup: async (input) => {
        received = input;
        return { ok: true };
      },
    });
    await server.start();
    await fetch(`http://localhost:${server.boundPort}/api/setup`, {
      method: 'POST',
      body: JSON.stringify({ config: 'yaml', secrets: [{ service: 'github', account: 'default', value: 'x' }] }),
    });
    expect(received?.config).toBe('yaml');
    expect(received?.secrets).toHaveLength(1);
  });
});
