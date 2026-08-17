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
import type { AgentStage, WorkspaceHandle, WorkspaceIO } from '../core/types.js';

export type AgentProviderId = 'claude' | 'gemini' | 'gpt';
export type AgentTransportId = 'api' | 'cli';

/** Per-stage model mapping, provider-neutral (e.g. planning→opus, implementation→sonnet). */
export type StageModels = Partial<Record<AgentStage, string>>;

export type AgentErrorKind = 'timeout' | 'auth' | 'login_required' | 'crashed' | 'budget' | 'rate_limit';

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
  /** The workspace (backend + id + workdir) the turn runs against. */
  handle: WorkspaceHandle;
  /** File IO into the workspace (used to write the workflow guide before running). */
  io: WorkspaceIO;
  /** The turn message / instruction. */
  prompt: string;
  /** Rendered workflow guide; empty string = don't (over)write it (e.g. side runs). */
  workflow: string;
  /** Resolved model id for this stage, if any. */
  model?: string;
  /** Keep session memory across turns (provider's "continue" semantics). */
  continueSession: boolean;
  maxTurns?: number;
  maxBudgetUsd?: number;
  turnTimeoutMs?: number;
  allowedTools?: string[];
  /**
   * Run with no tools at all.
   *
   * A coding agent normally gets a shell and a filesystem, and its prompt is the user's
   * own issue. An operational turn's prompt carries a queue message and an external API
   * response — text nobody here controls — so it asks a question and must not be able to
   * act on the answer to it. Measured: narrowing tools stops commands but not writes, so
   * the only sound setting is none (CRL-43).
   *
   * A transport that cannot express this must refuse the turn rather than run it wide.
   */
  noTools?: boolean;
  /**
   * Receive the model's reply verbatim.
   *
   * The `text` AgentEvent is capped for the live timeline (`oneLine(text, 2000)`), which
   * is right for a UI and wrong for an answer that has to parse as JSON. With no tools
   * there is no file to read it from, so a caller that needs the whole thing asks here.
   */
  onAnswerText?: (text: string) => void;
  signal?: AbortSignal;
}

/**
 * A transport bound to one provider (i.e. one cell of the provider × transport matrix).
 * Registered in the agent Registry under a `${provider}:${transport}` key.
 *
 * Streaming is callback-based: `run` invokes `onEvent` for each normalized event
 * (text / tool_use / usage / error) and resolves when the turn ends (after a final
 * `done` event). This avoids bridging spawn callbacks to an async iterator.
 */
export interface AgentTransport {
  readonly provider: AgentProviderId;
  readonly transport: AgentTransportId;
  /** Verify usability without running a turn (key present / binary installed). */
  preflight(): Promise<PreflightResult>;
  /** Execute one turn, streaming normalized events through onEvent. */
  run(spec: AgentTurnSpec, onEvent: (event: AgentEvent) => void): Promise<void>;
}
