/**
 * IPC control-plane host. Replaces the HTTP+SSE server (src/server/dashboard.ts):
 * the desktop forks this core with a Node IPC channel, so there's NO TCP port — the
 * renderer↔main bridge relays requests here over `process.send`/`process.on('message')`.
 *
 * Protocol (parent ⇄ child):
 *   parent → child : { kind:'req', id, method, args }
 *   child  → parent: { kind:'res', id, result }  | { kind:'res', id, error }
 *   child  → parent: { kind:'event', event }      (forwarded bus events)
 *   child  → parent: { kind:'ready' }             (once, on startup)
 *
 * Methods mirror the old HTTP routes 1:1. Setup (config + secrets) is NOT here — the
 * desktop writes config/secrets via its own bridge (keychain) and respawns this child.
 */
import type { WebChannel } from './channel/web.js';
import { bus } from './core/events.js';
import { logger } from './core/logger.js';
import type { Orchestrator } from './orchestrator.js';

/** Config + secrets the setup wizard persists (kept for the headless/browser shape). */
export interface SetupInput {
  config: string;
  secrets: Array<{ service: string; account: string; value: string }>;
}

export interface IpcHostDeps {
  channel: WebChannel;
  /** The orchestrator once configured; undefined in setup mode. */
  orchestrator: () => Orchestrator | undefined;
}

const NOT_CONFIGURED = { ok: false, message: 'Corral is not configured yet — finish setup first.' };

type ReqMessage = { kind: 'req'; id: number; method: string; args?: Record<string, unknown> };

export function startIpcHost(deps: IpcHostDeps): void {
  const send = process.send?.bind(process);
  if (!send) {
    logger.error('startIpcHost: no IPC channel (core was not forked with stdio:ipc)');
    return;
  }

  // Forward every bus event to the parent (replaces the SSE stream).
  bus.subscribe((event) => {
    try {
      send({ kind: 'event', event });
    } catch (err) {
      logger.warn('ipc event send failed', String(err));
    }
  });

  process.on('message', (raw: unknown) => {
    const msg = raw as ReqMessage;
    if (!msg || msg.kind !== 'req') return;
    void dispatch(msg.method, msg.args ?? {}, deps)
      .then((result) => send({ kind: 'res', id: msg.id, result }))
      .catch((err) => send({ kind: 'res', id: msg.id, error: err instanceof Error ? err.message : String(err) }));
  });

  send({ kind: 'ready' });
  logger.info('ipc control plane ready');
}

async function dispatch(method: string, a: Record<string, unknown>, deps: IpcHostDeps): Promise<unknown> {
  const o = deps.orchestrator();
  const id = () => String(a.identifier ?? '');
  switch (method) {
    case 'status':
      return { configured: !!o };
    case 'state':
      return { issues: o ? o.snapshot() : [], pending: deps.channel.getPending(), events: bus.recent() };
    case 'candidates':
      return { candidates: o ? await o.listCandidates() : [] };
    case 'diffs':
      return { diffs: deps.channel.getDiffs(String(a.id ?? '')) };
    case 'start':
      return o ? await o.startIssue(id()) : NOT_CONFIGURED;
    case 'complete':
      return o ? await o.completeByUser(id(), a.force === true) : NOT_CONFIGURED;
    case 'retry':
      return o ? await o.retry(id()) : NOT_CONFIGURED;
    case 'remove':
      return o ? await o.removeIssue(id()) : NOT_CONFIGURED;
    case 'restart':
      return o ? await o.restartIssue(id()) : NOT_CONFIGURED;
    case 'refine':
      return o ? await o.refinePlan(id(), String(a.focus ?? '')) : NOT_CONFIGURED;
    case 'action': {
      const ok =
        a.type === 'approve'
          ? deps.channel.submitApprove(String(a.id), { selection: a.selection as string, notes: a.text as string })
          : deps.channel.submitFeedback(String(a.id), String(a.text ?? ''));
      return { ok };
    }
    case 'history':
      if (a.id) return { record: o ? o.getHistory(String(a.id)) : undefined };
      return {
        records: o
          ? o.listHistory({
              limit: a.limit as number | undefined,
              offset: a.offset as number | undefined,
              outcome: a.outcome as 'completed' | 'removed' | 'failed' | undefined,
            })
          : [],
      };
    default:
      throw new Error(`unknown method: ${method}`);
  }
}
