/**
 * Shared agentic loop for `*:api` transports — a provider-neutral coding agent over raw
 * HTTP. Unlike the cli transports (which delegate the loop to a CLI), this drives the
 * model with tool calls itself: the model gets ONE tool — `bash` — and reads/writes/edits
 * files and runs commands by issuing shell commands in the workspace, looping until it
 * stops calling tools (done) or hits the turn cap.
 *
 * Provider differences (auth, request/response shape, tool-call format) live behind the
 * `ChatClient` interface; this engine is the same for claude/gemini/gpt. Net-new logic,
 * exercised by api-loop.test.ts with a fake client so it works before any real key runs.
 */
import type { AgentEvent, AgentErrorKind, AgentProviderId, AgentTurnSpec, PreflightResult } from './types.js';

/** A tool the model may call. `parameters` is a JSON Schema object. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One tool call the model emitted. */
export interface NeutralToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Provider-neutral conversation message. */
export interface NeutralMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant: the tool calls it requested this turn. */
  toolCalls?: NeutralToolCall[];
  /** tool: which call this result answers. */
  toolCallId?: string;
}

/** One assistant turn from a provider. */
export interface ChatTurn {
  text: string;
  toolCalls: NeutralToolCall[];
  inputTokens: number;
  outputTokens: number;
}

/** A provider's HTTP chat client — translates the neutral conversation/tool model to and
 *  from the provider's wire format. The only provider-specific surface. */
export interface ChatClient {
  readonly provider: AgentProviderId;
  /** Key present / reachable — checked before the loop runs. */
  preflight(): Promise<PreflightResult>;
  /** One assistant turn given the conversation + available tools. Throws ApiHttpError on
   *  a non-2xx response so the loop can classify auth / rate-limit / crash. */
  send(messages: NeutralMessage[], tools: ToolDef[], model: string | undefined, signal?: AbortSignal): Promise<ChatTurn>;
}

/** Thrown by clients on a non-2xx HTTP response; carries the status for classification. */
export class ApiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

export const BASH_TOOL: ToolDef = {
  name: 'bash',
  description:
    'Run a shell command in the current working directory and get back its stdout, stderr, and exit code. ' +
    'This is your ONLY tool: read files with cat/ls/grep, write or edit files with heredocs/sed/python, and run builds, tests, and git with it.',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string', description: 'The shell command to run.' } },
    required: ['command'],
    additionalProperties: false,
  },
};

const SYSTEM_GUIDE = [
  'You are an autonomous coding agent working directly inside a real git workspace. Your only',
  'tool is `bash`: you cannot see files unless you read them (cat/ls/grep), and you make every',
  'change by running shell commands (write with heredocs, edit with sed/python, build, test, git).',
  'Work in the current directory. Never ask the user questions — decide and act. When the task is',
  'fully complete, reply with a short final summary and stop calling tools.',
].join(' ');

/** Cap a single tool result so one runaway command can't blow the context window. */
const MAX_TOOL_OUTPUT = 60_000;

function classify(e: unknown): { kind: AgentErrorKind; message: string } {
  if (e instanceof ApiHttpError) {
    if (e.status === 401 || e.status === 403) return { kind: 'login_required', message: e.message };
    if (e.status === 429) return { kind: 'rate_limit', message: e.message };
    return { kind: 'crashed', message: e.message };
  }
  if (e instanceof DOMException && e.name === 'AbortError') return { kind: 'timeout', message: 'aborted/timed out' };
  return { kind: 'crashed', message: e instanceof Error ? e.message : String(e) };
}

/**
 * Drive `client` through the agentic loop for one orchestrator turn, streaming normalized
 * AgentEvents. Stateless across dispatches (each turn is a fresh conversation) — the
 * orchestrator hands state off through files (.corral/pending_plan.md, etc.), so session
 * continuity isn't required. `continueSession` is intentionally not honored here.
 */
export async function runApiAgent(
  client: ChatClient,
  spec: AgentTurnSpec,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  const pre = await client.preflight();
  if (!pre.ok) {
    onEvent({ type: 'error', error: 'login_required', message: pre.detail });
    onEvent({ type: 'done', exitCode: null });
    return;
  }

  const system = spec.workflow.trim() ? `${SYSTEM_GUIDE}\n\n# Operating guide\n${spec.workflow}` : SYSTEM_GUIDE;
  const messages: NeutralMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: spec.prompt },
  ];

  const maxTurns = spec.maxTurns && spec.maxTurns > 0 ? spec.maxTurns : 60;
  let exitCode: number | null = 0;

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (spec.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const res = await client.send(messages, [BASH_TOOL], spec.model, turnSignal(spec));
      // Per-turn token deltas (GenericAgent sums them); cost is left to the caller's
      // budgeting — BYOK pricing varies by model and isn't tracked here yet.
      onEvent({ type: 'usage', inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: 0 });
      if (res.text) onEvent({ type: 'text', text: res.text });
      if (res.toolCalls.length === 0) break; // no tool calls → the model is done

      messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        onEvent({ type: 'tool_use', name: call.name });
        const command = typeof call.args.command === 'string' ? call.args.command : '';
        let output: string;
        if (call.name !== 'bash' || !command.trim()) {
          output = `error: ${call.name} is not a supported tool or the command was empty.`;
        } else {
          const r = await spec.io.exec(spec.handle, command);
          output = `exit=${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
        }
        messages.push({ role: 'tool', content: output.slice(0, MAX_TOOL_OUTPUT), toolCallId: call.id });
      }
    }
  } catch (e) {
    const { kind, message } = classify(e);
    onEvent({ type: 'error', error: kind, message });
    exitCode = null;
  }

  onEvent({ type: 'done', exitCode });
}

/** Combine the run's abort signal with a per-turn timeout (if configured). */
function turnSignal(spec: AgentTurnSpec): AbortSignal | undefined {
  const timeout = spec.turnTimeoutMs && spec.turnTimeoutMs > 0 ? AbortSignal.timeout(spec.turnTimeoutMs) : undefined;
  if (spec.signal && timeout) return AbortSignal.any([spec.signal, timeout]);
  return spec.signal ?? timeout;
}
