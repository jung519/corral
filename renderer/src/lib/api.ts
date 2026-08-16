/**
 * Control-plane client. Talks to the core over the Electron IPC bridge
 * (`window.corral.core`) — there is NO HTTP server / port. Each function maps to one
 * core method; `subscribeEvents` is the live bus-event stream.
 */
import type { Candidate, CommandResult, CorralEvent, HistoryRecord, StateResponse } from './types';

function bridge() {
  const c = typeof window !== 'undefined' ? window.corral : undefined;
  if (!c) throw new Error('Corral desktop bridge unavailable');
  return c;
}

/** Request/response over the core IPC channel. */
async function call<T>(method: string, args?: Record<string, unknown>): Promise<T> {
  return (await bridge().core.call(method, args)) as T;
}

/** Whether Corral is configured — a bridge file check (works before the core is up). */
export async function isConfigured(): Promise<boolean> {
  try {
    if (typeof window !== 'undefined' && window.corral?.config) return await window.corral.config.exists();
    return false;
  } catch {
    return false;
  }
}

export async function getState(): Promise<StateResponse> {
  return call<StateResponse>('state');
}

export async function getHistory(outcome?: string): Promise<HistoryRecord[]> {
  const data = await call<{ records: HistoryRecord[] }>('history', outcome ? { outcome } : undefined);
  return data.records ?? [];
}

/** One page of candidates (ID-ascending). `nextCursor` absent = last page. */
export async function getCandidates(cursor?: string): Promise<{ candidates: Candidate[]; nextCursor?: string }> {
  return call<{ candidates: Candidate[]; nextCursor?: string }>('candidates', cursor ? { cursor } : undefined);
}

export const startIssue = (identifier: string): Promise<CommandResult> => call('start', { identifier });
export const completeIssue = (identifier: string, force = false): Promise<CommandResult> =>
  call('complete', { identifier, force });
export const retryIssue = (identifier: string): Promise<CommandResult> => call('retry', { identifier });
export const removeIssue = (identifier: string): Promise<CommandResult> => call('remove', { identifier });
export const restartIssue = (identifier: string): Promise<CommandResult> => call('restart', { identifier });
export const refineIssue = (identifier: string, focus: string): Promise<CommandResult> =>
  call('refine', { identifier, focus });
export const approve = (id: string, selection?: string, text?: string): Promise<CommandResult> =>
  call('action', { id, type: 'approve', selection, text });
export const feedback = (id: string, text: string): Promise<CommandResult> =>
  call('action', { id, type: 'feedback', text });

/** Read-only Q&A about a pending plan/review — does NOT modify the result. `answerHtml` is
 *  the answer rendered from markdown (line breaks + sections preserved). */
export const ask = (
  identifier: string,
  question: string,
): Promise<{ ok: boolean; answer?: string; answerHtml?: string; message?: string }> => call('ask', { identifier, question });

/** One-time consent to spend AI on validating Direction text (§15). Owned by the core. */
export const getDirectionConsent = (): Promise<{ consent: boolean }> => call('directionConsentGet');
export const setDirectionConsent = (value: boolean): Promise<{ ok: boolean; consent: boolean }> =>
  call('directionConsentSet', { value });

// ── Operational AI ───────────────────────────────────────────────────────────────
// The same control plane the development screens use — one connection, both pillars.

export interface OpsPipeline {
  key: string;
  description?: string;
  enabled: boolean;
  trigger: string;
  /** Undefined = follows the app's configured provider. */
  provider?: string;
  activeRuns: number;
}

export interface OpsCounts {
  runs: number;
  failed: number;
  lowConfidence: number;
  tokens: number;
}

export interface OpsBudget {
  date: string;
  inputTokens: number;
  outputTokens: number;
  limits: { dailyInputTokens?: number; dailyOutputTokens?: number };
  /** 0–1 of the tightest configured ceiling; 0 when none is set. */
  used: number;
}

export interface OpsOverview {
  pipelines: OpsPipeline[];
  /** Today's numbers, by pipeline key. Absent key = nothing ran today. */
  counts: Record<string, OpsCounts>;
  /** Shared with the development AI, so it can move without anything here running. */
  budget?: OpsBudget;
  /** Why the list is empty (a broken definition file). */
  error?: string;
}

/** Everything the operations dashboard shows, in one call. */
export const getOverview = (): Promise<OpsOverview> => call('opsPipelines');

/** Re-read the definition files without restarting the core. */
export const reloadPipelines = (): Promise<{ loaded: number; error?: string }> => call('opsReload');

/** Run one pipeline now, with a body the caller supplies. */
export const runPipeline = (key: string, input?: unknown): Promise<{ ok: boolean; error?: string; run?: { outcome: string; reason?: string } }> =>
  call('opsRun', { key, input: input ?? {} });

/** Turn a pipeline's trigger on or off for this process. */
export const setPipelineEnabled = (key: string, enabled: boolean): Promise<{ ok: boolean; enabled?: boolean; error?: string }> =>
  call('opsSetEnabled', { key, enabled });

/** Subscribe to the live event stream; returns an unsubscribe fn. */
export function subscribeEvents(onEvent: (e: CorralEvent) => void): () => void {
  try {
    return bridge().core.onEvent((event) => onEvent(event as CorralEvent));
  } catch {
    return () => {};
  }
}
