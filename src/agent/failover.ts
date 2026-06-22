/**
 * Ordered failover over multiple agents. Wraps a priority-ordered list of
 * AgentAdapters and presents the same AgentAdapter interface to the orchestrator, so
 * `this.agent.run(...)` transparently advances to the next agent when the active one
 * is out of capacity.
 *
 * Trigger = the active run returns a fail-over error (rate_limit / auth / budget):
 * its quota/window is spent or its account ended. timeout/crashed are NOT triggers —
 * those are transient/bug failures the orchestrator retries on the same agent.
 *
 * State is account-wide (shared across all issues): if account #1's quota is spent,
 * every issue should move to #2. A cooldown periodically retries from the top so a
 * recovered quota (e.g. Claude's window reset) is picked back up automatically.
 */
import { bus } from '../core/events.js';
import { logger } from '../core/logger.js';
import type { AgentAdapter, AgentRunOptions, AgentRunResult, Issue, WorkspaceHandle } from '../core/types.js';

export interface FailoverMember {
  adapter: AgentAdapter;
  /** Human label for notices, e.g. "claude:cli" or "gemini:cli #2". */
  label: string;
}

/** Errors that mean "this agent is out of capacity — try the next one". */
const FAILOVER_ERRORS = new Set<AgentRunResult['error']>(['rate_limit', 'auth', 'budget']);

export class FailoverAgent implements AgentAdapter {
  readonly kind: string;
  readonly primary = true;

  /** Index of the agent currently in use (sticky; advances on exhaustion). */
  private active = 0;
  /** Index used on the previous run() call — to decide whether session continuity holds. */
  private lastIndex = 0;
  /** When the active agent was last advanced past the top, for the cooldown reset. */
  private advancedAt = 0;

  constructor(
    private readonly members: FailoverMember[],
    /** After this long with the top agent skipped, retry from index 0 (quota may have
     *  reset). 0 disables the reset (stick until restart). Default 1 hour. */
    private readonly resetMs = 60 * 60 * 1000,
  ) {
    if (members.length === 0) throw new Error('FailoverAgent requires at least one agent');
    this.kind = members.map((m) => m.adapter.kind).join(' → ');
  }

  async run(workspace: WorkspaceHandle, issue: Issue, opts: AgentRunOptions): Promise<AgentRunResult> {
    this.maybeReset();
    const log = logger.child(workspace.id);
    let lastResult: AgentRunResult | undefined;

    for (let i = this.active; i < this.members.length; i++) {
      const member = this.members[i]!; // i bounded by members.length
      // Session continuity (--continue/--resume) only holds when the SAME agent ran the
      // previous turn; a switch starts the new agent fresh.
      const continueSession = opts.continueSession && i === this.lastIndex;
      const result = await member.adapter.run(workspace, issue, { ...opts, continueSession });
      this.lastIndex = i;

      if (!FAILOVER_ERRORS.has(result.error)) {
        this.active = i; // stick with the agent that worked
        return result;
      }

      // Exhausted — advance and tell the user. The error surfaces only if every agent fails.
      lastResult = result;
      const next = this.members[i + 1];
      const msg = next
        ? `⚠️ ${member.label} 사용량 소진(${result.error}) → ${next.label}(으)로 전환`
        : `❌ 모든 에이전트 사용량 소진 — 마지막: ${member.label}(${result.error})`;
      log.warn(`failover: ${member.label} exhausted (${result.error})${next ? ` → ${next.label}` : ' (last)'}`);
      bus.emitEvent({ identifier: workspace.id, kind: next ? 'notice' : 'error', label: msg });

      if (next) {
        if (this.active === 0) this.advancedAt = Date.now();
        this.active = i + 1;
      }
    }

    // Everything exhausted: return the last failure so the orchestrator reacts (e.g.
    // auth → auth_error_waiting). active stays at the last index.
    return lastResult ?? { ok: false, costUsd: 0, inputTokens: 0, outputTokens: 0, exitCode: null, error: 'crashed' };
  }

  /** If the cooldown has elapsed, retry from the top — the quota may have reset. */
  private maybeReset(): void {
    if (this.active > 0 && this.resetMs > 0 && Date.now() - this.advancedAt >= this.resetMs) {
      logger.child('agent').info(`failover: cooldown elapsed — retrying from ${this.members[0]!.label}`);
      this.active = 0;
    }
  }
}
