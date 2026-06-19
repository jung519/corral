/**
 * Claude CLI transport — spawns the user's installed `claude` CLI and streams its
 * stream-json output as normalized AgentEvents. Works for both the local backend
 * (spawn in the workdir) and docker (exec into the issue container).
 *
 * Lifted from upstream's ClaudeBackend. KEY ADAPTATION (BYOK): auth is the user's
 * own API key, injected as ANTHROPIC_API_KEY (local: process env; docker: `exec -e`)
 * — never the host ~/.claude subscription mount. Provider/transport-specific
 * concerns (where claude reads its rules, CLI flags) live here, not in GenericAgent.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { logger } from '../core/logger.js';
import { containerName, WORKER_USER } from '../workspace/docker-io.js';
import { activityEvents, applyUsage, looksLikeAuth, parseStreamLine, type UsageAcc } from './stream-json.js';
import type { AgentEvent, AgentTransport, AgentTurnSpec, PreflightResult } from './types.js';

/** Where the claude CLI reads its durable behavior rules inside the workspace. */
const CLAUDE_RULES_PATH = '.claude/rules/WORKFLOW.md';

export class ClaudeCliTransport implements AgentTransport {
  readonly provider = 'claude' as const;
  readonly transport = 'cli' as const;

  constructor(private readonly apiKey: string | null) {}

  async preflight(): Promise<PreflightResult> {
    if (this.apiKey) return { ok: true };
    return { ok: true, detail: 'no API key set; relying on an installed & logged-in claude CLI' };
  }

  async run(spec: AgentTurnSpec, onEvent: (event: AgentEvent) => void): Promise<void> {
    const log = logger.child(spec.handle.id);

    // Workspace prep: write the rendered workflow the agent must follow. An empty
    // workflow means a self-contained side run that must NOT clobber the main one.
    if (spec.workflow) await spec.io.writeFile(spec.handle, CLAUDE_RULES_PATH, spec.workflow);

    const flags = buildFlags(spec);
    const { command, args, cwd } = this.spawnSpec(spec, flags);
    log.info(`agent run model=${spec.model ?? 'default'} continue=${spec.continueSession}`);

    await new Promise<void>((resolve) => {
      const child = spawn(command, args, { cwd, env: this.localEnv(), signal: spec.signal });
      const acc: UsageAcc = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
      let sawAuth = false;
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
        const event = parseStreamLine(line);
        if (!event) return;
        for (const e of activityEvents(event)) onEvent(e);
        applyUsage(event, acc);
        if (event.type === 'result' && event.is_error && looksLikeAuth(JSON.stringify(event))) sawAuth = true;
      });

      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
        if (looksLikeAuth(stderr)) sawAuth = true;
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
        onEvent({ type: 'usage', ...acc });
        if (sawAuth) onEvent({ type: 'error', error: 'auth' });
        else if (timedOut) onEvent({ type: 'error', error: 'timeout' });
        else if (code !== 0) onEvent({ type: 'error', error: 'crashed', message: stderr.slice(-300) });
        log.info(`agent done code=${code} cost=$${acc.costUsd.toFixed(4)} tok=${acc.inputTokens}/${acc.outputTokens}`);
        onEvent({ type: 'done', exitCode: code });
        resolve();
      });
    });
  }

  private spawnSpec(
    spec: AgentTurnSpec,
    flags: string[],
  ): { command: string; args: string[]; cwd?: string } {
    if (spec.handle.backend === 'local') {
      return { command: 'claude', args: ['-p', spec.prompt, ...flags], cwd: spec.handle.workdir };
    }
    // docker: run inside the container as the worker user; inject the API key via -e.
    const claudeCmd = ['claude', '-p', shq(spec.prompt), ...flags.map(shq)].join(' ');
    const envArgs = this.apiKey ? ['-e', `ANTHROPIC_API_KEY=${this.apiKey}`] : [];
    return {
      command: 'docker',
      args: [
        'exec',
        '--user',
        WORKER_USER,
        '-w',
        spec.handle.workdir,
        ...envArgs,
        containerName(spec.handle),
        'bash',
        '-lc',
        claudeCmd,
      ],
    };
  }

  /** Env for the local spawn: stripped of inherited CLAUDE_/ANTHROPIC_ vars, with
   *  the user's BYOK key injected. (docker injects via `exec -e` instead.) */
  private localEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('CLAUDE_') || k.startsWith('ANTHROPIC_') || k === 'BAGGAGE') continue;
      env[k] = v;
    }
    if (this.apiKey) env.ANTHROPIC_API_KEY = this.apiKey;
    return env;
  }
}

function buildFlags(spec: AgentTurnSpec): string[] {
  const flags = ['--verbose', '--output-format', 'stream-json'];
  if (spec.model) flags.push('--model', spec.model);
  if (spec.continueSession) flags.push('--continue');
  if (spec.maxTurns) flags.push('--max-turns', String(spec.maxTurns));
  if (spec.maxBudgetUsd) flags.push('--max-budget-usd', String(spec.maxBudgetUsd));
  if (spec.allowedTools && spec.allowedTools.length > 0) flags.push('--allowedTools', spec.allowedTools.join(','));
  // Unattended operation. claude refuses this as root, so docker uses the non-root
  // worker user and local relies on the host being a non-root user.
  flags.push('--dangerously-skip-permissions');
  return flags;
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
