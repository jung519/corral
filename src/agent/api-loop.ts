/**
 * Shared agentic loop for `*:api` transports — a provider-neutral coding agent over raw
 * HTTP. Unlike the cli transports (which delegate the loop to a CLI), this drives the
 * model with tool calls itself: it exposes a small purpose-built toolset (read / write /
 * edit / ls / grep / bash) and loops until the model stops calling tools (done) or hits
 * the turn cap.
 *
 * Provider differences (auth, request/response shape, tool-call format) live behind the
 * `ChatClient` interface; this engine — including the tool dispatch — is the same for
 * claude/gemini/gpt. Net-new logic, exercised by api-loop.test.ts with a fake client so it
 * works before any real key runs.
 */
import type { WorkspaceHandle, WorkspaceIO } from '../core/types.js';
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

const obj = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const READ_TOOL: ToolDef = {
  name: 'read',
  description:
    'Read a text file from the workspace, returned with line numbers. Large files are paginated — pass `offset` (1-based start line) and `limit` to page through. You MUST read a file before you edit it.',
  parameters: obj(
    {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
      offset: { type: 'integer', description: 'First line to return (1-based). Default 1.' },
      limit: { type: 'integer', description: 'Max lines to return. Default 2000.' },
    },
    ['path'],
  ),
};

export const WRITE_TOOL: ToolDef = {
  name: 'write',
  description: 'Create or overwrite a file with the exact content given. Prefer `edit` for changing part of an existing file.',
  parameters: obj(
    { path: { type: 'string', description: 'Path relative to the workspace root.' }, content: { type: 'string', description: 'Full file content.' } },
    ['path', 'content'],
  ),
};

export const EDIT_TOOL: ToolDef = {
  name: 'edit',
  description:
    'Replace an exact substring in a file. `old_string` must match EXACTLY and be unique (include surrounding context to disambiguate), or set `replace_all`. You must `read` the file first.',
  parameters: obj(
    {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
      old_string: { type: 'string', description: 'Exact text to replace.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' },
    },
    ['path', 'old_string', 'new_string'],
  ),
};

export const LS_TOOL: ToolDef = {
  name: 'ls',
  description: 'List the entries of a directory in the workspace.',
  parameters: obj({ path: { type: 'string', description: 'Directory path relative to the workspace root. Default ".".' } }, []),
};

export const GREP_TOOL: ToolDef = {
  name: 'grep',
  description: 'Search file contents for a pattern (recursive grep). Returns matching lines as `path:line:text`.',
  parameters: obj(
    { pattern: { type: 'string', description: 'Pattern to search for (extended regex).' }, path: { type: 'string', description: 'Path to search under. Default ".".' } },
    ['pattern'],
  ),
};

export const BASH_TOOL: ToolDef = {
  name: 'bash',
  description:
    'Run a shell command in the workspace and get back stdout, stderr, and the exit code. Use it for builds, tests, git, and anything the file tools above do not cover.',
  parameters: obj({ command: { type: 'string', description: 'The shell command to run.' } }, ['command']),
};

/** The toolset offered to the model, ordered most-specific first. */
export const TOOLS: ToolDef[] = [READ_TOOL, LS_TOOL, GREP_TOOL, EDIT_TOOL, WRITE_TOOL, BASH_TOOL];

const SYSTEM_GUIDE = [
  'You are an autonomous coding agent working directly inside a real git workspace. Use the tools to',
  'get things done: `read` (always read a file before editing it), `ls`, and `grep` to explore;',
  '`edit` for precise changes and `write` for new files; `bash` for builds, tests, and git. You cannot',
  'see files unless you read them. Work in the workspace root. Never ask the user questions — decide and',
  'act. When the task is fully complete, reply with a short final summary and stop calling tools.',
].join(' ');

const MAX_TOOL_OUTPUT = 60_000;
const READ_DEFAULT_LIMIT = 2000;
/** bash output line budget before head+tail truncation kicks in. */
const BASH_HEAD = 200;
const BASH_TAIL = 100;

/** Per-run tool execution context. `readState` enforces read-before-edit. */
export interface ToolContext {
  io: WorkspaceIO;
  handle: WorkspaceHandle;
  readState: Set<string>;
}

function normPath(p: unknown): string {
  return String(p ?? '')
    .trim()
    .replace(/^\.\//, '');
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/** Trim a big shell output to a head + tail window with an omission marker. */
function clampOutput(text: string): string {
  const lines = text.split('\n');
  if (lines.length > BASH_HEAD + BASH_TAIL + 1) {
    const omitted = lines.length - BASH_HEAD - BASH_TAIL;
    text = [...lines.slice(0, BASH_HEAD), `… [${omitted} lines omitted] …`, ...lines.slice(-BASH_TAIL)].join('\n');
  }
  return text.slice(0, MAX_TOOL_OUTPUT);
}

/** Execute one tool call against the workspace and return its textual result (never throws
 *  — tool-level failures come back as an `error: …` string the model can react to). */
export async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const { io, handle, readState } = ctx;
  try {
    switch (name) {
      case 'read': {
        const path = normPath(args.path);
        const content = await io.readFile(handle, path);
        if (content === null) return `error: file not found: ${path}`;
        readState.add(path);
        const lines = content.split('\n');
        const offset = Math.max(1, Number(args.offset ?? 1) | 0);
        const limit = Math.max(1, Number(args.limit ?? READ_DEFAULT_LIMIT) | 0);
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join('\n');
        const end = offset - 1 + slice.length;
        const note = end < lines.length ? `\n… [showing lines ${offset}-${end} of ${lines.length}; read with offset=${end + 1} to continue] …` : '';
        return clampOutput(numbered + note);
      }
      case 'write': {
        const path = normPath(args.path);
        if (!path) return 'error: path is required';
        const content = String(args.content ?? '');
        await io.writeFile(handle, path, content);
        readState.add(path);
        return `wrote ${path} (${content.split('\n').length} lines)`;
      }
      case 'edit': {
        const path = normPath(args.path);
        if (!readState.has(path)) return `error: read ${path} before editing it.`;
        const content = await io.readFile(handle, path);
        if (content === null) return `error: file not found: ${path}`;
        const oldS = String(args.old_string ?? '');
        const newS = String(args.new_string ?? '');
        if (!oldS) return 'error: old_string is required';
        const count = countOccurrences(content, oldS);
        if (count === 0) return `error: old_string not found in ${path}`;
        const replaceAll = args.replace_all === true;
        if (count > 1 && !replaceAll) {
          return `error: old_string matches ${count} places in ${path}; add surrounding context to make it unique, or set replace_all.`;
        }
        const updated = replaceAll ? content.split(oldS).join(newS) : content.replace(oldS, newS);
        await io.writeFile(handle, path, updated);
        return `edited ${path} (${replaceAll ? count : 1} replacement${replaceAll && count > 1 ? 's' : ''})`;
      }
      case 'ls': {
        const path = normPath(args.path) || '.';
        const entries = await io.list(handle, path);
        return clampOutput(entries.join('\n')) || '(empty)';
      }
      case 'grep': {
        const pattern = String(args.pattern ?? '');
        if (!pattern) return 'error: pattern is required';
        const path = normPath(args.path) || '.';
        const r = await io.exec(handle, `grep -rnIE --color=never -e ${shq(pattern)} ${shq(path)} 2>/dev/null || true`);
        return clampOutput(r.stdout) || '(no matches)';
      }
      case 'bash': {
        const command = String(args.command ?? '');
        if (!command.trim()) return 'error: command is required';
        const r = await io.exec(handle, command);
        return clampOutput(`exit=${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
      }
      default:
        return `error: ${name} is not a supported tool.`;
    }
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

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
  const ctx: ToolContext = { io: spec.io, handle: spec.handle, readState: new Set<string>() };

  const maxTurns = spec.maxTurns && spec.maxTurns > 0 ? spec.maxTurns : 60;
  let exitCode: number | null = 0;

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (spec.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const res = await client.send(messages, TOOLS, spec.model, turnSignal(spec));
      // Per-turn token deltas (GenericAgent sums them); cost is left to the caller's
      // budgeting — BYOK pricing varies by model and isn't tracked here yet (Phase 3).
      onEvent({ type: 'usage', inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: 0 });
      if (res.text) onEvent({ type: 'text', text: res.text });
      if (res.toolCalls.length === 0) break; // no tool calls → the model is done

      messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        onEvent({ type: 'tool_use', name: call.name });
        const output = await executeTool(call.name, call.args, ctx);
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
