/**
 * Claude CLI transport — spawns the user's installed `claude` CLI and streams its
 * stream-json output as normalized AgentEvents. Works for both the local backend
 * (spawn in the workdir) and docker (exec into the issue container).
 *
 * Lifted from upstream's ClaudeBackend. KEY ADAPTATION (BYOK): auth is the user's
 * own credential, injected as env (local: process env; docker: `exec -e`) — never
 * the host ~/.claude subscription mount. Two credential kinds are supported:
 *   - ANTHROPIC_API_KEY        — pay-per-use API key
 *   - CLAUDE_CODE_OAUTH_TOKEN  — subscription token from `claude setup-token`,
 *     which lets the cli run in a container with NO API key (no billing).
 * Provider/transport-specific concerns (where claude reads its rules, CLI flags)
 * live here, not in GenericAgent.
 */
import { logger } from '../core/logger.js';
import { containerName, WORKER_USER } from '../workspace/docker-io.js';
import { type CliStreamParser, runCliTurn, shq } from './cli-runner.js';
import { activityEvents, applyUsage, looksLikeAuth, parseStreamLine, type StreamEvent } from './stream-json.js';
import type { AgentEvent, AgentTransport, AgentTurnSpec, PreflightResult } from './types.js';

/** Maps Claude Code's stream-json output to normalized events. */
const claudeParser: CliStreamParser<StreamEvent> = {
  parse: parseStreamLine,
  activity: activityEvents,
  usage: applyUsage,
  isAuthFailure: (ev, line) => ev.type === 'result' && ev.is_error === true && looksLikeAuth(line),
};

/** Where the claude CLI reads its durable behavior rules inside the workspace. */
const CLAUDE_RULES_PATH = '.claude/rules/WORKFLOW.md';

export class ClaudeCliTransport implements AgentTransport {
  readonly provider = 'claude' as const;
  readonly transport = 'cli' as const;

  constructor(
    private readonly apiKey: string | null,
    private readonly oauthToken: string | null = null,
  ) {}

  async preflight(): Promise<PreflightResult> {
    if (this.apiKey) return { ok: true };
    if (this.oauthToken) return { ok: true, detail: 'using subscription OAuth token (CLAUDE_CODE_OAUTH_TOKEN)' };
    return { ok: true, detail: 'no credential set; relying on an installed & logged-in claude CLI' };
  }

  async run(spec: AgentTurnSpec, onEvent: (event: AgentEvent) => void): Promise<void> {
    const log = logger.child(spec.handle.id);

    // Workspace prep: write the rendered workflow the agent must follow. An empty
    // workflow means a self-contained side run that must NOT clobber the main one.
    if (spec.workflow) await spec.io.writeFile(spec.handle, CLAUDE_RULES_PATH, spec.workflow);

    const flags = buildFlags(spec);
    const { command, args, cwd } = this.spawnSpec(spec, flags);
    log.info(`agent run model=${spec.model ?? 'default'} continue=${spec.continueSession}`);

    await runCliTurn(spec, { command, args, cwd, env: this.localEnv() }, claudeParser, onEvent, log);
  }

  private spawnSpec(
    spec: AgentTurnSpec,
    flags: string[],
  ): { command: string; args: string[]; cwd?: string } {
    if (spec.handle.backend === 'local') {
      return { command: 'claude', args: ['-p', spec.prompt, ...flags], cwd: spec.handle.workdir };
    }
    // docker: run inside the container as the worker user; inject the credential via -e.
    const claudeCmd = ['claude', '-p', shq(spec.prompt), ...flags.map(shq)].join(' ');
    const envArgs: string[] = [];
    if (this.apiKey) envArgs.push('-e', `ANTHROPIC_API_KEY=${this.apiKey}`);
    if (this.oauthToken) envArgs.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${this.oauthToken}`);
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
    if (this.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = this.oauthToken;
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
