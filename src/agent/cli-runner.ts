/**
 * Provider-neutral CLI turn runner. Spawns a coding-agent CLI, streams its
 * line-delimited output through a provider-specific parser, and emits normalized
 * AgentEvents — identical lifecycle (timeout → SIGTERM, auth/crash detection, usage
 * aggregation) for every provider so claude/gemini/codex transports stay thin.
 *
 * The provider differences live in two injected pieces: the CliSpawnSpec (binary,
 * flags, env) and the CliStreamParser (how to read that CLI's stream format).
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Logger } from '../core/logger.js';
import { looksLikeAuth, looksLikeRateLimit, type UsageAcc } from './stream-json.js';
import type { AgentEvent, AgentTurnSpec } from './types.js';

/** How to read one CLI's stream output, normalized to AgentEvents. */
export interface CliStreamParser<T> {
  /** Parse one stdout line into a provider event, or null for non-JSON noise. */
  parse(line: string): T | null;
  /** Normalized activity events (text / tool_use) for the live timeline. */
  activity(event: T): AgentEvent[];
  /** Fold this event's cost/token data into the accumulator. */
  usage(event: T, acc: UsageAcc): void;
  /** Whether this event signals an auth/credential failure (non-retryable). The raw
   *  line is passed so parsers can keyword-match the serialized error text. */
  isAuthFailure(event: T, rawLine: string): boolean;
  /** Optional: whether this event signals the usage/rate limit was hit (fail-over
   *  trigger). The raw line is passed for keyword matching. */
  isRateLimit?(event: T, rawLine: string): boolean;
  /** Optional: emit any buffered output at end-of-stream (stateful parsers only).
   *  Stateful parsers MUST be instantiated per turn — never shared across turns. */
  flush?(): AgentEvent[];
}

/** What to spawn for one turn. */
export interface CliSpawnSpec {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
}

/** Run one CLI turn: spawn, stream-parse, and resolve after the final `done` event. */
export function runCliTurn<T>(
  spec: AgentTurnSpec,
  spawnSpec: CliSpawnSpec,
  parser: CliStreamParser<T>,
  onEvent: (event: AgentEvent) => void,
  log: Logger,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: spawnSpec.cwd,
      env: spawnSpec.env,
      signal: spec.signal,
    });
    const acc: UsageAcc = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
    let sawAuth = false;
    let sawRateLimit = false;
    let timedOut = false;
    let stderr = '';

    const timeoutMs = spec.turnTimeoutMs;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          log.warn(`turn timeout (${timeoutMs}ms) — SIGTERM`);
          child.kill('SIGTERM');
        }, timeoutMs)
      : undefined;

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const event = parser.parse(line);
      if (!event) return;
      for (const e of parser.activity(event)) onEvent(e);
      parser.usage(event, acc);
      if (parser.isAuthFailure(event, line)) sawAuth = true;
      if (parser.isRateLimit?.(event, line)) sawRateLimit = true;
    });

    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (looksLikeAuth(stderr)) sawAuth = true;
      if (looksLikeRateLimit(stderr)) sawRateLimit = true;
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      log.error('agent spawn error', String(err));
      onEvent({ type: 'usage', ...acc });
      onEvent({ type: 'error', error: 'crashed', message: String(err) });
      onEvent({ type: 'done', exitCode: null });
      resolve();
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (parser.flush) for (const e of parser.flush()) onEvent(e);
      onEvent({ type: 'usage', ...acc });
      // rate_limit before auth: a spent quota is auto-recoverable (fail over), whereas
      // auth needs manual re-auth — don't misreport a usage limit as the latter.
      if (sawRateLimit) onEvent({ type: 'error', error: 'rate_limit' });
      // Split auth: a turn that produced ZERO tokens never authenticated → it's a
      // credential/login setup problem (login_required), NOT capacity exhaustion. A turn
      // that ran (tokens > 0) and THEN hit auth is a mid-run session/account end (auth).
      else if (sawAuth)
        onEvent({ type: 'error', error: acc.inputTokens === 0 && acc.outputTokens === 0 ? 'login_required' : 'auth' });
      else if (timedOut) onEvent({ type: 'error', error: 'timeout' });
      else if (code !== 0) onEvent({ type: 'error', error: 'crashed', message: stderr.slice(-300) });
      log.info(`agent done code=${code} cost=$${acc.costUsd.toFixed(4)} tok=${acc.inputTokens}/${acc.outputTokens}`);
      onEvent({ type: 'done', exitCode: code });
      resolve();
    });
  });
}

/** Single-quote shell escaping for embedding args in `bash -lc "<cmd>"` (docker exec). */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
