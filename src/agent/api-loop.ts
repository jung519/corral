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
import { priceFor } from './pricing.js';
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

/** Thrown by clients on a non-2xx HTTP response; carries the status for classification and
 *  an optional Retry-After hint (ms) honored by the retry backoff. */
export class ApiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

/** Parse an HTTP `Retry-After` header (seconds or HTTP date) to milliseconds. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
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

/** Normalize and confine a path to the workspace: reject absolute / home / `..`-escaping
 *  paths so the file tools can't read or clobber outside the clone. Returns null if unsafe. */
function safeRelPath(p: unknown, fallback?: string): string | null {
  const s = normPath(p) || (fallback ?? '');
  if (!s) return null;
  if (s.startsWith('/') || s.startsWith('~')) return null;
  if (s.split('/').some((seg) => seg === '..')) return null;
  return s;
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Heuristic denylist for the `bash` tool. NOT a sandbox — a guardrail against the most
 *  destructive footguns (recursive deletes of root/home, fork bombs, disk writes, privilege
 *  escalation, curl|sh). The docker backend is the real isolation; this protects local. */
const BASH_DENY: { re: RegExp; reason: string }[] = [
  { re: /\brm\s+(-[a-z]*\s+)*-?[rf]{1,2}\b[^|&;]*\s(\/|~|\$HOME|\/\*|\.)\s*($|[|&;])/i, reason: 'recursive delete of /, ~, or the workspace root' },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork bomb' },
  { re: /\bmkfs\b|\bdd\b[^|&;]*\bof=\/dev\/|>\s*\/dev\/(sd|nvme|disk)/i, reason: 'raw disk / device write' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: 'host power control' },
  { re: /\bsudo\b/i, reason: 'privilege escalation (sudo)' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i, reason: 'pipe-to-shell of remote content' },
  { re: /\bchmod\s+-R\s+0?777\s+\//i, reason: 'world-writable chmod of root' },
];
function bashPolicy(command: string): string | null {
  for (const { re, reason } of BASH_DENY) if (re.test(command)) return reason;
  return null;
}

/** Restrict the offered toolset to `allowed` when set. If the allowlist names none of our
 *  tools (e.g. it's a CLI-style list), it's ignored rather than locking the agent out. */
export function effectiveTools(allowed?: string[]): ToolDef[] {
  if (!allowed || allowed.length === 0) return TOOLS;
  const set = new Set(allowed.map((s) => s.toLowerCase()));
  const kept = TOOLS.filter((t) => set.has(t.name));
  return kept.length ? kept : TOOLS;
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
        const path = safeRelPath(args.path);
        if (!path) return `error: invalid or escaping path: ${String(args.path)}`;
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
        const path = safeRelPath(args.path);
        if (!path) return `error: invalid or escaping path: ${String(args.path)}`;
        const content = String(args.content ?? '');
        await io.writeFile(handle, path, content);
        readState.add(path);
        return `wrote ${path} (${content.split('\n').length} lines)`;
      }
      case 'edit': {
        const path = safeRelPath(args.path);
        if (!path) return `error: invalid or escaping path: ${String(args.path)}`;
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
        const path = safeRelPath(args.path, '.');
        if (!path) return `error: invalid or escaping path: ${String(args.path)}`;
        const entries = await io.list(handle, path);
        return clampOutput(entries.join('\n')) || '(empty)';
      }
      case 'grep': {
        const pattern = String(args.pattern ?? '');
        if (!pattern) return 'error: pattern is required';
        const path = safeRelPath(args.path, '.');
        if (!path) return `error: invalid or escaping path: ${String(args.path)}`;
        const r = await io.exec(handle, `grep -rnIE --color=never -e ${shq(pattern)} ${shq(path)} 2>/dev/null || true`);
        return clampOutput(r.stdout) || '(no matches)';
      }
      case 'bash': {
        const command = String(args.command ?? '');
        if (!command.trim()) return 'error: command is required';
        const blocked = bashPolicy(command);
        if (blocked) return `error: blocked by safety policy (${blocked}). Run this yourself if you intended it; the agent won't.`;
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
  const tools = effectiveTools(spec.allowedTools);

  const maxTurns = spec.maxTurns && spec.maxTurns > 0 ? spec.maxTurns : 60;
  const maxBudget = spec.maxBudgetUsd && spec.maxBudgetUsd > 0 ? spec.maxBudgetUsd : 0;
  let exitCode: number | null = 0;
  let costUsd = 0; // cumulative — GenericAgent takes the latest costUsd as the run total

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (spec.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      // Stop before starting another paid turn once the budget is spent (failover-eligible).
      if (maxBudget && costUsd >= maxBudget) {
        onEvent({ type: 'error', error: 'budget', message: `budget $${maxBudget.toFixed(2)} reached ($${costUsd.toFixed(2)} spent)` });
        exitCode = null;
        break;
      }
      const res = await sendWithRetry(client, messages, tools, spec);
      // Per-turn token deltas (GenericAgent sums them); cumulative cost (GenericAgent keeps
      // the latest as the run total). Pricing is approximate — see pricing.ts.
      costUsd += priceFor(client.provider, spec.model, res.inputTokens, res.outputTokens);
      onEvent({ type: 'usage', inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd });
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

// ── retry / backoff (transient HTTP failures) ──────────────────────────────
const MAX_ATTEMPTS = 3; // 1 try + 2 retries
const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 8_000;

/** Retry transient failures only: 429 + 5xx, and network errors with no status. A timeout
 *  or explicit cancellation (AbortError) is intentional and never retried. */
function isRetryable(e: unknown): boolean {
  if (e instanceof DOMException && e.name === 'AbortError') return false;
  if (e instanceof ApiHttpError) return e.status === 429 || e.status >= 500;
  return true; // fetch network error / unknown transient
}

function backoffDelay(attempt: number, e: unknown): number {
  const base = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  const jittered = base + Math.random() * base * 0.25;
  const retryAfter = e instanceof ApiHttpError ? e.retryAfterMs : undefined;
  return retryAfter ? Math.max(jittered, retryAfter) : jittered;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/** One `client.send`, retrying transient failures with exponential backoff (honoring
 *  Retry-After). A fresh per-turn timeout signal is built for each attempt. */
async function sendWithRetry(client: ChatClient, messages: NeutralMessage[], tools: ToolDef[], spec: AgentTurnSpec): Promise<ChatTurn> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.send(messages, tools, spec.model, turnSignal(spec));
    } catch (e) {
      if (spec.signal?.aborted || attempt >= MAX_ATTEMPTS || !isRetryable(e)) throw e;
      await sleep(backoffDelay(attempt, e), spec.signal);
    }
  }
}
