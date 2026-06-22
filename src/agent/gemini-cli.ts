/**
 * Gemini CLI transport — spawns the user's installed `gemini` CLI and streams its
 * `--output-format stream-json` output as normalized AgentEvents. Mirrors the Claude
 * CLI transport (shared lifecycle via runCliTurn); the differences are the binary,
 * its flags, where it reads its rules (GEMINI.md), and its stream schema
 * (GeminiStreamParser).
 *
 * BYOK auth: the user's Gemini API key, injected as GEMINI_API_KEY (local: process
 * env; docker: `exec -e`). With no key the CLI falls back to its own login (~/.gemini)
 * — local backend only.
 */
import { logger } from '../core/logger.js';
import { containerName, WORKER_USER } from '../workspace/docker-io.js';
import { type CliSpawnSpec, runCliTurn, shq } from './cli-runner.js';
import { GeminiStreamParser } from './gemini-stream.js';
import type { AgentEvent, AgentTransport, AgentTurnSpec, PreflightResult } from './types.js';

/** Where the gemini CLI reads its durable context/rules inside the workspace. */
const GEMINI_RULES_PATH = 'GEMINI.md';

export class GeminiCliTransport implements AgentTransport {
  readonly provider = 'gemini' as const;
  readonly transport = 'cli' as const;

  constructor(private readonly apiKey: string | null) {}

  async preflight(): Promise<PreflightResult> {
    if (this.apiKey) return { ok: true };
    return { ok: true, detail: 'no API key set; relying on an installed & logged-in gemini CLI' };
  }

  async run(spec: AgentTurnSpec, onEvent: (event: AgentEvent) => void): Promise<void> {
    const log = logger.child(spec.handle.id);

    // Workspace prep: write the rendered workflow as the gemini context file. An empty
    // workflow means a self-contained side run that must NOT clobber the main one.
    if (spec.workflow) await spec.io.writeFile(spec.handle, GEMINI_RULES_PATH, spec.workflow);

    const flags = buildFlags(spec);
    const setup = this.spawnSpec(spec, flags);
    log.info(`agent run model=${spec.model ?? 'default'} continue=${spec.continueSession}`);

    // Stateful parser (coalesces text deltas) — one fresh instance per turn.
    await runCliTurn(spec, setup, new GeminiStreamParser(), onEvent, log);
  }

  private spawnSpec(spec: AgentTurnSpec, flags: string[]): CliSpawnSpec {
    if (spec.handle.backend === 'local') {
      // Prompt is the positional query (the -p flag is deprecated upstream).
      return { command: 'gemini', args: [...flags, spec.prompt], cwd: spec.handle.workdir, env: this.localEnv() };
    }
    // docker: run inside the container as the worker user; inject the key via -e.
    const geminiCmd = ['gemini', ...flags.map(shq), shq(spec.prompt)].join(' ');
    const envArgs = this.apiKey ? ['-e', `GEMINI_API_KEY=${this.apiKey}`] : [];
    return {
      command: 'docker',
      args: ['exec', '--user', WORKER_USER, '-w', spec.handle.workdir, ...envArgs, containerName(spec.handle), 'bash', '-lc', geminiCmd],
      env: this.localEnv(),
    };
  }

  /** Env for the local spawn: stripped of inherited Gemini/Google key vars, with the
   *  user's BYOK key injected. (docker injects via `exec -e` instead.) */
  private localEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === 'GEMINI_API_KEY' || k === 'GOOGLE_API_KEY' || k === 'BAGGAGE') continue;
      env[k] = v;
    }
    if (this.apiKey) env.GEMINI_API_KEY = this.apiKey;
    return env;
  }
}

function buildFlags(spec: AgentTurnSpec): string[] {
  const flags = ['--output-format', 'stream-json'];
  if (spec.model) flags.push('--model', spec.model);
  // Resume the most recent session in this project dir (gemini's "continue").
  if (spec.continueSession) flags.push('--resume', 'latest');
  // Unattended operation: auto-approve every tool (no interactive confirmation).
  flags.push('--yolo');
  return flags;
}
