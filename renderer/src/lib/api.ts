/**
 * Control-plane client. Talks to the core over the Electron IPC bridge
 * (`window.corral.core`) — there is NO HTTP server / port. Each function maps to one
 * core method; `subscribeEvents` is the live bus-event stream.
 */
import type { Candidate, CommandResult, CorralEvent, HistoryRecord, SpecDoc, StateResponse } from './types';

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

/** `profile.language` as config has it — `'auto' | 'en' | 'ko'`.
 *
 *  Undefined when there is no desktop bridge, no config, or no core up yet: parsing YAML
 *  is the core's job (see `configParsed`), so this cannot be counted on during the first
 *  paint. Only caller is the one-time UI-language adoption, which is fine to skip and
 *  retry on the next launch. */
export async function configLanguage(): Promise<string | undefined> {
  try {
    if (typeof window === 'undefined' || !window.corral?.config) return undefined;
    const { config } = await window.corral.config.parsed();
    const language = (config as { profile?: { language?: unknown } } | undefined)?.profile?.language;
    return typeof language === 'string' ? language : undefined;
  } catch {
    return undefined;
  }
}

export async function getState(): Promise<StateResponse> {
  return call<StateResponse>('state');
}

/** The approved spec documents, rendered by the core (it owns the markdown parser). */
export async function getSpecDocs(id: string): Promise<SpecDoc[]> {
  return (await call<{ docs: SpecDoc[] }>('specDocs', { id })).docs;
}

export async function getHistory(outcome?: string): Promise<HistoryRecord[]> {
  const data = await call<{ records: HistoryRecord[] }>('history', outcome ? { outcome } : undefined);
  return data.records ?? [];
}

/** One page of candidates (ID-ascending). `nextCursor` absent = last page. `search`
 *  matches a title substring, or an issue id when the term is one — the tracker does the
 *  filtering, so it covers every candidate and not just the pages already fetched. */
export async function getCandidates(
  cursor?: string,
  search?: string,
): Promise<{ candidates: Candidate[]; nextCursor?: string; searched?: boolean }> {
  const args: Record<string, unknown> = {};
  if (cursor) args.cursor = cursor;
  if (search) args.search = search;
  return call<{ candidates: Candidate[]; nextCursor?: string; searched?: boolean }>(
    'candidates',
    Object.keys(args).length > 0 ? args : undefined,
  );
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

/** One-time consent to spend AI on validating Direction text. Owned by the core. */
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
  /** Whether a manual run has to be handed an event body before it can go (CRL-72). */
  wantsEvent: boolean;
  /** The names that body has to carry. Empty when the input kind has none to name. */
  eventFields: string[];
  /** Undefined = follows the app's configured provider. */
  provider?: string;
  activeRuns: number;
  /**
   * Whether work is actually arriving. Absent while nothing has started the trigger.
   *
   * `enabled` is what the operator asked for; this is what happened. A subscription being
   * refused on every pull is enabled and not working (CRL-60).
   */
  health?:
    | { state: 'attached' }
    /** Passes on its own — the loop is already retrying. */
    | { state: 'retrying'; reason: string }
    /** Does not pass until somebody changes something. */
    | { state: 'blocked'; reason: string };
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
  /** Estimated dollars for the priced part of the day. */
  costUsd?: number;
  /** Calls that spent tokens with no price. Above zero, `costUsd` is a floor. */
  unpricedCalls?: number;
  limits: { dailyInputTokens?: number; dailyOutputTokens?: number; dailyCostUsd?: number };
  /** 0–1 of the tightest configured ceiling; 0 when none is set. */
  used: number;
  /**
   * What each pillar spent today. The operational design requires the ceiling on screen at
   * all times so that development eating the shared budget shows immediately (D12) — the
   * total alone could never say that (CRL-110).
   */
  byPillar?: Partial<
    Record<'development' | 'operations', { inputTokens: number; outputTokens: number; costUsd?: number }>
  >;
  /** Spend from before attribution existed. Shown as unknown, never folded into a pillar. */
  unattributed?: { inputTokens: number; outputTokens: number };
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

/** Run one pipeline now, with a body the caller supplies. */
export const runPipeline = (key: string, input?: unknown): Promise<{ ok: boolean; error?: string; run?: { outcome: string; reason?: string } }> =>
  call('opsRun', { key, input: input ?? {} });

export interface SaveIssue {
  /** Dotted field path, e.g. `agent.prompt.system` — the editor puts the message there. */
  path: string;
  message: string;
}

/** Validate and write a definition. Refused unless `overwrite` when the key exists. */
/**
 * Which providers this core can actually ask, and the models configured for each.
 *
 * Not what the schema allows — what `opsChatClients` kept. Empty means the model step is
 * unwired, and the editor should say so rather than offer a choice that cannot run.
 */
export const getOpsAgents = (): Promise<{ agents: Array<{ provider: string; models: string[]; defaultModel?: string }> }> =>
  call('opsAgents');

/**
 * Make the fetch a pipeline would make, without saving anything.
 *
 * Runs on the core so the credential resolves and no browser is in the way. Failures come
 * back in `error` rather than as a rejection — "the server said 401" is the answer.
 */
export const testFetch = (
  request: unknown,
  event: unknown,
  select: unknown,
): Promise<{
  ok: boolean;
  error?: string;
  body?: unknown;
  fields?: Record<string, unknown>;
  /** Names whose path matched nothing — the answer to "why is that field not here?". */
  missing?: string[];
  /** `select` itself could not be read. The fetch still happened. */
  selectError?: string;
}> => call('opsTestFetch', { request, event, select });

/** Delete a pipeline — its file and its trigger. Run history is kept. */
export const deletePipeline = (key: string): Promise<{ ok: boolean; file?: string; error?: string }> =>
  call('opsDelete', { key });

/**
 * One pipeline's definition, for opening it in the editor.
 *
 * The parsed form the runtime holds, not the file's bytes — the editor wants values, and
 * the file's YAML would have to be parsed and defaulted here to get them.
 */
export const getDefinition = (key: string): Promise<{ ok: boolean; definition?: Record<string, unknown>; error?: string }> =>
  call('opsDefinition', { key });

export const savePipeline = (
  definition: unknown,
  overwrite = false,
): Promise<{ ok: boolean; file?: string; issues?: SaveIssue[] }> => call('opsSave', { definition, overwrite });

/** Turn a pipeline's trigger on or off for this process. */
export const setPipelineEnabled = (key: string, enabled: boolean): Promise<{ ok: boolean; enabled?: boolean; error?: string }> =>
  call('opsSetEnabled', { key, enabled });

export interface OpsRun {
  id: string;
  pipeline: string;
  outcome: string;
  /** Which step ended the run. Absent when it completed. */
  stage?: string;
  reason?: string;
  startedAt: number;
  durationMs: number;
  tokens?: number;
  costUsd?: number;
  provider?: string;
  model?: string;
  failedOver?: boolean;
  lowConfidence?: boolean;
  /** Values the checks discarded. */
  dropped?: string[];
  /** Where a human can look at a held-back result — the user's own screen, not ours. */
  reviewUrl?: string;
}

export interface OpsDailyTotals {
  date: string;
  runs: number;
  byOutcome: Record<string, number>;
  tokens: number;
  costUsd: number;
  failedOver: number;
  lowConfidence: number;
  failed: number;
}

/** Recent runs, newest first. */
export const getRuns = (query: {
  days?: number;
  pipeline?: string;
  outcome?: string;
  limit?: number;
}): Promise<{ runs: OpsRun[] }> => call('opsHistory', query);

/** Per-day summaries, newest first. */
export const getTotals = (days?: number): Promise<{ totals: OpsDailyTotals[] }> => call('opsTotals', { days });

/** Subscribe to the live event stream; returns an unsubscribe fn. */
export function subscribeEvents(onEvent: (e: CorralEvent) => void): () => void {
  try {
    return bridge().core.onEvent((event) => onEvent(event as CorralEvent));
  } catch {
    return () => {};
  }
}
