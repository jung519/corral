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
 * Setup (config, secrets, draft, host probes) IS here, because a remote core owns its
 * own config and there is no other way to reach that disk. One rule holds throughout:
 * secrets go in and existence comes back — no method ever returns a secret value.
 */
import type { WebChannel } from '../channel/web.js';
import type { DirectionCheckStore, DirectionStore } from '../core/direction.js';
import { bus } from '../core/events.js';
import type { Orchestrator } from '../orchestrator.js';
import type { OpsHost } from '../ops/ops-host.js';
import { detectCli, detectDocker } from './host-probe.js';
import type { SetupHost } from './setup-host.js';

export interface ControlPlaneDeps {
  channel: WebChannel;
  /** The orchestrator once configured; undefined in setup mode. */
  orchestrator: () => Orchestrator | undefined;
  /** Global Direction reader — available even in setup mode (plain file read). */
  directionStore: DirectionStore;
  /** Direction validation state — consent flag read/written from the settings UI. */
  directionCheck: DirectionCheckStore;
  /** This core's own config/secrets/draft. Absent in tests that only exercise runtime
   *  methods; the setup methods then answer `NO_SETUP` instead of throwing. */
  setup?: SetupHost;
  /** The operational AI. Absent when nothing has been assembled (tests, and any build
   *  that leaves it out); its methods then answer `NO_OPS`. */
  ops?: OpsHost;
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
const NO_SETUP = { ok: false, error: 'this core does not expose setup' };
const NO_OPS = { ok: false, error: 'the operational AI is not running on this core' };

/** A credential ref off the wire. Both halves are required — a blank service or account
 *  would collide with other entries in the store's flat "service:account" keyspace. */
function ref(a: Record<string, unknown>): { service: string; account: string } | null {
  const service = String(a.service ?? '').trim();
  const account = String(a.account ?? '').trim();
  return service && account ? { service, account } : null;
}

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
    case 'directionWrite':
      deps.directionStore.write(String(a.text ?? ''));
      return { ok: true };

    // ── Setup: this core's own config, secrets, draft, and host probes ──────────────
    case 'configGet':
      if (!deps.setup) return NO_SETUP;
      return { exists: deps.setup.configExists(), yaml: deps.setup.configRead() };
    case 'configSet':
      if (!deps.setup) return NO_SETUP;
      // Writes, then rebuilds the orchestrator in place — a remote core has no parent
      // process to respawn it. `configured` is what the wizard checks to call it done.
      return { ...(await deps.setup.configWrite(String(a.yaml ?? ''))), configured: !!deps.orchestrator() };
    case 'secretSet': {
      if (!deps.setup) return NO_SETUP;
      const r = ref(a);
      if (!r) return { ok: false, error: 'service and account are required' };
      await deps.setup.credentials.set(r, String(a.value ?? ''));
      return { ok: true };
    }
    case 'secretHas': {
      if (!deps.setup) return NO_SETUP;
      const r = ref(a);
      return { has: r ? await deps.setup.credentials.has(r) : false };
    }
    case 'secretDelete': {
      if (!deps.setup) return NO_SETUP;
      const r = ref(a);
      if (!r) return { ok: false, error: 'service and account are required' };
      await deps.setup.credentials.delete(r);
      return { ok: true };
    }
    case 'draftGet':
      if (!deps.setup) return NO_SETUP;
      return { json: deps.setup.draftRead() };
    case 'draftSet':
      if (!deps.setup) return NO_SETUP;
      deps.setup.draftWrite(String(a.json ?? ''));
      return { ok: true };
    case 'draftClear':
      if (!deps.setup) return NO_SETUP;
      deps.setup.draftClear();
      return { ok: true };
    case 'detectDocker':
      return await detectDocker();
    case 'detectCli':
      return await detectCli(String(a.provider ?? ''));

    // ── Operational AI: pipelines, manual runs, run history ────────────────────────
    case 'opsPipelines':
      if (!deps.ops) return NO_OPS;
      // The load error rides along so an empty list can say why it is empty.
      return { pipelines: deps.ops.list(), error: deps.ops.error };
    case 'opsReload':
      if (!deps.ops) return NO_OPS;
      return await deps.ops.load();
    case 'opsSetEnabled': {
      if (!deps.ops) return NO_OPS;
      const key = String(a.key ?? '');
      if (!deps.ops.registry.get(key)) return { ok: false, error: `no pipeline named "${key}"` };
      return { ok: true, enabled: deps.ops.registry.setEnabled(key, a.enabled === true) };
    }
    case 'opsRun':
      if (!deps.ops) return NO_OPS;
      // The one entry point that works before any trigger exists — how a pipeline gets
      // tried out while it is being written, and how a failed one is reprocessed.
      return await deps.ops.runManually(String(a.key ?? ''), a.input);
    case 'opsHistory':
      if (!deps.ops) return NO_OPS;
      return {
        runs: await deps.ops.history.list({
          days: a.days as number | undefined,
          pipeline: a.pipeline as string | undefined,
          outcome: a.outcome as never,
          limit: a.limit as number | undefined,
        }),
      };
    case 'opsTotals':
      if (!deps.ops) return NO_OPS;
      return { totals: await deps.ops.history.totals(a.days as number | undefined) };
    case 'opsBudget':
      if (!deps.ops) return NO_OPS;
      // The ceiling is shared with the development AI, so this is the day's total for
      // BOTH — it is what explains a core that has stopped calling models.
      return { budget: deps.ops.budgetSnapshot() };
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
