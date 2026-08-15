/**
 * Control-plane protocol — the method table, independent of how the message arrived.
 *
 * The wire protocol is four message kinds, shared by every transport:
 *   client → core : { kind:'req',   id, method, args }
 *   core → client : { kind:'res',   id, result } | { kind:'res', id, error }
 *   core → client : { kind:'event', event }        (forwarded bus events)
 *   core → client : { kind:'ready' }               (once per connection)
 *
 * Transports (`ipc.ts`, `ws.ts`) only move these messages; this file decides what a
 * method does. Adding a transport must never require touching the method table.
 *
 * Setup (config + secrets) is NOT here — the desktop writes those through its own
 * bridge and respawns the core.
 */
import type { WebChannel } from '../channel/web.js';
import type { DirectionCheckStore, DirectionStore } from '../core/direction.js';
import { bus } from '../core/events.js';
import type { Orchestrator } from '../orchestrator.js';

/** Config + secrets the setup wizard persists (kept for the headless/browser shape). */
export interface SetupInput {
  config: string;
  secrets: Array<{ service: string; account: string; value: string }>;
}

export interface ControlPlaneDeps {
  channel: WebChannel;
  /** The orchestrator once configured; undefined in setup mode. */
  orchestrator: () => Orchestrator | undefined;
  /** Global Direction reader — available even in setup mode (plain file read). */
  directionStore: DirectionStore;
  /** Direction validation state — consent flag read/written from the settings UI. */
  directionCheck: DirectionCheckStore;
}

/** Wire message shapes. Exported so transports type their payloads identically. */
export type ReqMessage = { kind: 'req'; id: number; method: string; args?: Record<string, unknown> };

/** Handshake, used by remote transports only — the process-IPC parent is already trusted.
 *  `pair` exchanges a one-time code for a token; `auth` presents that token. */
export type AuthMessage =
  | { kind: 'pair'; code?: string; label?: string }
  | { kind: 'auth'; token?: string };

export type OutMessage =
  | { kind: 'res'; id: number; result?: unknown; error?: string }
  | { kind: 'event'; event: unknown }
  | { kind: 'ready' }
  | { kind: 'paired'; token: string }
  | { kind: 'denied'; reason: string };

const NOT_CONFIGURED = { ok: false, message: 'Corral is not configured yet — finish setup first.' };

/** Run one control-plane method. Throws on an unknown method or an orchestrator error;
 *  transports turn that into `{ kind:'res', id, error }`. */
export async function dispatch(
  method: string,
  a: Record<string, unknown>,
  deps: ControlPlaneDeps,
): Promise<unknown> {
  const o = deps.orchestrator();
  const id = () => String(a.identifier ?? '');
  switch (method) {
    case 'status':
      return { configured: !!o };
    case 'direction':
      // What the core actually reads from the injected path — lets the renderer confirm
      // the global Direction reached the core. Injection happens in the orchestrator.
      return { text: deps.directionStore.read(), path: deps.directionStore.path };
    case 'directionConsentGet':
      return { consent: deps.directionCheck.getConsent() };
    case 'directionConsentSet':
      deps.directionCheck.setConsent(a.value === true);
      return { ok: true, consent: deps.directionCheck.getConsent() };
    case 'state':
      return { issues: o ? o.snapshot() : [], pending: deps.channel.getPending(), events: bus.recent() };
    case 'candidates':
      return o
        ? await o.listCandidates({ cursor: a.cursor as string | undefined, limit: a.limit as number | undefined })
        : { candidates: [] };
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
    case 'ask':
      return o ? await o.answerQuestion(String(a.identifier ?? ''), String(a.question ?? '')) : NOT_CONFIGURED;
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
