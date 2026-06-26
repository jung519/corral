/**
 * Codex CLI transport (provider 'gpt'). Spawns OpenAI's `codex exec --json` and streams
 * its JSONL output as normalized AgentEvents (shared lifecycle via runCliTurn). Mirrors
 * the gemini transport; the differences are the binary (`codex`), its flags, where it
 * reads project rules (AGENTS.md), and its stream schema (CodexStreamParser).
 *
 * AUTH: local backend uses codex's own stored login (~/.codex — ChatGPT subscription or
 * `codex login --with-api-key`). Codex does NOT read OPENAI_API_KEY from env at exec
 * time, so docker auth (mount ~/.codex or login-with-key) is wired in a later phase.
 *
 * SESSION: codex resumes by thread id (captured from `thread.started`). We remember the
 * last thread per issue so continueSession resumes the exact session. (codex `resume
 * --last` is global to ~/.codex, so per-issue ids are required for parallel local runs.)
 */
import { logger } from '../core/logger.js';
import { containerName, WORKER_USER } from '../workspace/docker-io.js';
import { type CliSpawnSpec, runCliTurn, shq } from './cli-runner.js';
import { CodexStreamParser } from './codex-stream.js';
import type { AgentEvent, AgentTransport, AgentTurnSpec, PreflightResult } from './types.js';

/** Where codex reads its durable project instructions inside the workspace. */
const CODEX_RULES_PATH = 'AGENTS.md';

export class CodexCliTransport implements AgentTransport {
  readonly provider = 'gpt' as const;
  readonly transport = 'cli' as const;

  /** Last codex thread id per issue (workspace.id) — to resume the exact session. */
  private readonly threadByIssue = new Map<string, string>();

  constructor(private readonly apiKey: string | null) {}

  async preflight(): Promise<PreflightResult> {
    return { ok: true, detail: 'relying on an installed & logged-in codex CLI (~/.codex)' };
  }

  async run(spec: AgentTurnSpec, onEvent: (event: AgentEvent) => void): Promise<void> {
    const log = logger.child(spec.handle.id);

    if (spec.workflow) await spec.io.writeFile(spec.handle, CODEX_RULES_PATH, spec.workflow);

    const priorThread = this.threadByIssue.get(spec.handle.id);
    const setup = this.spawnSpec(spec, priorThread);
    const parser = new CodexStreamParser();
    log.info(`agent run model=${spec.model ?? 'default'} continue=${spec.continueSession}`);

    await runCliTurn(spec, setup, parser, onEvent, log);

    if (parser.threadId) this.threadByIssue.set(spec.handle.id, parser.threadId);
  }

  private spawnSpec(spec: AgentTurnSpec, priorThread: string | undefined): CliSpawnSpec {
    const args = buildArgs(spec, priorThread);
    if (spec.handle.backend === 'local') {
      return { command: 'codex', args, cwd: spec.handle.workdir, env: this.localEnv() };
    }
    // docker: run inside the container as the worker user. (Auth into the container is
    // added in the docker phase — mount ~/.codex or `codex login --with-api-key`.)
    const codexCmd = ['codex', ...args.map(shq)].join(' ');
    return {
      command: 'docker',
      args: ['exec', '--user', WORKER_USER, '-w', spec.handle.workdir, containerName(spec.handle), 'bash', '-lc', codexCmd],
      env: this.localEnv(),
    };
  }

  /** Env for the local spawn. Codex authenticates from its own stored login, not env. */
  private localEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.apiKey) env.OPENAI_API_KEY = this.apiKey;
    return env;
  }
}

/** Build the codex argv after the binary: `exec [opts] [resume <id>] <prompt>`. */
function buildArgs(spec: AgentTurnSpec, priorThread: string | undefined): string[] {
  const opts = ['--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
  if (spec.model) opts.push('-m', spec.model);
  // Resume the exact prior session only when we have its id (precise, parallel-safe).
  const resume = spec.continueSession && priorThread ? ['resume', priorThread] : [];
  return ['exec', ...opts, ...resume, spec.prompt];
}
