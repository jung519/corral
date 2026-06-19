/**
 * Agent provider × transport abstraction.
 *
 * This is a NET-NEW boundary, designed from scratch — NOT lifted from upstream's
 * claude-only, CLI-only backend (see docs/development-plan.md §1.3). The
 * orchestrator-facing interface stays `AgentAdapter` (../core/types.ts); a generic
 * adapter composes a provider × transport and aggregates the normalized event
 * stream into an AgentRunResult.
 *
 *   provider ∈ { claude, gemini, gpt }   — which model family
 *   transport ∈ { api, cli }             — how we reach it
 *     api : official SDK / HTTP, user API key (BYOK)
 *     cli : spawn a user-installed official CLI (claude / gemini / codex); never bundled
 *
 * Concrete transports (ClaudeApi, ClaudeCli, …) land in S2+; api is the priority path.
 */
import type { AgentStage } from '../core/types.js';

export type AgentProviderId = 'claude' | 'gemini' | 'gpt';
export type AgentTransportId = 'api' | 'cli';

/** Per-stage model mapping, provider-neutral (e.g. planning→opus, implementation→sonnet). */
export type StageModels = Partial<Record<AgentStage, string>>;

export type AgentErrorKind = 'timeout' | 'auth' | 'crashed' | 'budget';

/**
 * Result of checking a provider × transport is usable BEFORE running a turn:
 * api → key present & valid; cli → binary installed & logged in.
 */
export interface PreflightResult {
  ok: boolean;
  /** Reason when not ok (e.g. "claude CLI not found in PATH", "missing ANTHROPIC_API_KEY"). */
  detail?: string;
}

/** Normalized streaming event — every provider/transport maps its native output to these. */
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: 'done'; exitCode: number | null }
  | { type: 'error'; error: AgentErrorKind; message?: string };

/** A single agent turn, transport-neutral. */
export interface AgentTurnSpec {
  /** Working directory the turn executes in (workspace workdir). */
  cwd: string;
  /** The turn message / instruction. */
  prompt: string;
  /** Resolved model id for this stage, if any. */
  model?: string;
  /** Keep session memory across turns (provider's "continue" semantics). */
  continueSession: boolean;
  maxTurns?: number;
  turnTimeoutMs?: number;
  allowedTools?: string[];
  signal?: AbortSignal;
}

/**
 * A transport bound to one provider (i.e. one cell of the provider × transport matrix).
 * Registered in the agent Registry under a `${provider}:${transport}` key.
 */
export interface AgentTransport {
  readonly provider: AgentProviderId;
  readonly transport: AgentTransportId;
  /** Verify usability without running a turn (key present / binary installed). */
  preflight(): Promise<PreflightResult>;
  /** Execute one turn, yielding normalized events. */
  run(spec: AgentTurnSpec): AsyncIterable<AgentEvent>;
}
