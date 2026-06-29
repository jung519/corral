import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceHandle, WorkspaceIO } from '../core/types.js';
import {
  ApiHttpError,
  type ChatClient,
  type ChatTurn,
  executeTool,
  type NeutralMessage,
  runApiAgent,
  type ToolContext,
  type ToolDef,
} from './api-loop.js';
import type { AgentEvent, AgentTurnSpec } from './types.js';

const handle = { id: 'iss-1' } as WorkspaceHandle;

function fakeIo(exec: WorkspaceIO['exec']): WorkspaceIO {
  return {
    exec,
    readFile: async () => null,
    writeFile: async () => {},
    exists: async () => false,
    list: async () => [],
    getDiff: async () => '',
  };
}

function spec(over: Partial<AgentTurnSpec> = {}): AgentTurnSpec {
  return {
    handle,
    io: fakeIo(async () => ({ stdout: 'ok', stderr: '', code: 0 })),
    prompt: 'do it',
    workflow: 'GUIDE',
    continueSession: false,
    ...over,
  };
}

/** A client that replays scripted turns; records the messages it was sent. */
class ScriptedClient implements ChatClient {
  readonly provider = 'gpt' as const;
  sent: NeutralMessage[][] = [];
  constructor(
    private readonly turns: ChatTurn[],
    private readonly pre: { ok: boolean; detail?: string } = { ok: true },
  ) {}
  async preflight() {
    return this.pre;
  }
  async send(messages: NeutralMessage[], _tools: ToolDef[]): Promise<ChatTurn> {
    this.sent.push(structuredClone(messages));
    return this.turns[this.sent.length - 1] ?? { text: 'fallback', toolCalls: [], inputTokens: 0, outputTokens: 0 };
  }
}

const collect = () => {
  const events: AgentEvent[] = [];
  return { events, onEvent: (e: AgentEvent) => events.push(e) };
};

describe('runApiAgent', () => {
  it('runs a bash tool call, feeds the result back, then finishes', async () => {
    const client = new ScriptedClient([
      { text: 'let me look', toolCalls: [{ id: 't1', name: 'bash', args: { command: 'ls' } }], inputTokens: 10, outputTokens: 5 },
      { text: 'all done', toolCalls: [], inputTokens: 3, outputTokens: 2 },
    ]);
    const exec = vi.fn(async () => ({ stdout: 'file.txt', stderr: '', code: 0 }));
    const { events, onEvent } = collect();

    await runApiAgent(client, spec({ io: fakeIo(exec) }), onEvent);

    expect(exec).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledWith(handle, 'ls');
    // The 2nd send must include the assistant tool call + the tool result.
    const second = client.sent[1]!;
    expect(second.some((m) => m.role === 'assistant' && m.toolCalls?.[0]?.name === 'bash')).toBe(true);
    expect(second.some((m) => m.role === 'tool' && m.content.includes('file.txt'))).toBe(true);
    // System message carries the workflow guide.
    expect(client.sent[0]![0]!.content).toContain('GUIDE');
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(2);
    expect(events.some((e) => e.type === 'tool_use' && e.name === 'bash')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done', exitCode: 0 });
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('surfaces a failed preflight as login_required without sending', async () => {
    const client = new ScriptedClient([], { ok: false, detail: 'missing key' });
    const { events, onEvent } = collect();

    await runApiAgent(client, spec(), onEvent);

    expect(client.sent).toHaveLength(0);
    expect(events).toContainEqual({ type: 'error', error: 'login_required', message: 'missing key' });
    expect(events.at(-1)).toEqual({ type: 'done', exitCode: null });
  });

  it('classifies a 429 as rate_limit (failover-eligible) and ends', async () => {
    const client: ChatClient = {
      provider: 'gpt',
      preflight: async () => ({ ok: true }),
      send: async () => {
        throw new ApiHttpError(429, 'rate limited');
      },
    };
    const { events, onEvent } = collect();

    await runApiAgent(client, spec(), onEvent);

    expect(events.some((e) => e.type === 'error' && e.error === 'rate_limit')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done', exitCode: null });
  });

  it('stops at the turn cap when the model never stops calling tools', async () => {
    const looping: ChatTurn = {
      text: '',
      toolCalls: [{ id: 't', name: 'bash', args: { command: 'true' } }],
      inputTokens: 1,
      outputTokens: 1,
    };
    const client = new ScriptedClient([looping, looping, looping, looping]);
    const exec = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    const { events, onEvent } = collect();

    await runApiAgent(client, spec({ io: fakeIo(exec), maxTurns: 2 }), onEvent);

    expect(exec).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toEqual({ type: 'done', exitCode: 0 });
  });
});

function memIo(files: Record<string, string> = {}, exec: WorkspaceIO['exec'] = async () => ({ stdout: '', stderr: '', code: 0 })) {
  const store = new Map(Object.entries(files));
  const io: WorkspaceIO = {
    readFile: async (_h, p) => (store.has(p) ? store.get(p)! : null),
    writeFile: async (_h, p, c) => {
      store.set(p, c);
    },
    exists: async (_h, p) => store.has(p),
    list: async () => [...store.keys()],
    getDiff: async () => '',
    exec,
  };
  return { io, store };
}
const ctx = (io: WorkspaceIO): ToolContext => ({ io, handle, readState: new Set<string>() });

describe('executeTool', () => {
  it('read returns numbered, paginated lines and marks the file read', async () => {
    const { io } = memIo({ 'a.txt': 'l1\nl2\nl3\nl4\nl5' });
    const c = ctx(io);
    const out = await executeTool('read', { path: 'a.txt', offset: 2, limit: 2 }, c);
    expect(out).toContain('2\tl2');
    expect(out).toContain('3\tl3');
    expect(out).not.toContain('l5');
    expect(out).toContain('lines 2-3 of 5');
    expect(c.readState.has('a.txt')).toBe(true);
  });

  it('read on a missing file errors and does not mark it read', async () => {
    const c = ctx(memIo().io);
    expect(await executeTool('read', { path: 'nope.txt' }, c)).toContain('file not found');
    expect(c.readState.size).toBe(0);
  });

  it('write creates the file and marks it read', async () => {
    const { io, store } = memIo();
    const c = ctx(io);
    await executeTool('write', { path: 'new.txt', content: 'hi\nthere' }, c);
    expect(store.get('new.txt')).toBe('hi\nthere');
    expect(c.readState.has('new.txt')).toBe(true);
  });

  it('edit refuses a file that was not read first', async () => {
    const { io } = memIo({ 'a.txt': 'foo' });
    expect(await executeTool('edit', { path: 'a.txt', old_string: 'foo', new_string: 'bar' }, ctx(io))).toContain('read a.txt before editing');
  });

  it('edit replaces a unique match after a read', async () => {
    const { io, store } = memIo({ 'a.txt': 'alpha beta' });
    const c = ctx(io);
    await executeTool('read', { path: 'a.txt' }, c);
    const out = await executeTool('edit', { path: 'a.txt', old_string: 'beta', new_string: 'gamma' }, c);
    expect(out).toContain('edited a.txt');
    expect(store.get('a.txt')).toBe('alpha gamma');
  });

  it('edit rejects an ambiguous match unless replace_all', async () => {
    const { io, store } = memIo({ 'a.txt': 'x x x' });
    const c = ctx(io);
    await executeTool('read', { path: 'a.txt' }, c);
    expect(await executeTool('edit', { path: 'a.txt', old_string: 'x', new_string: 'y' }, c)).toContain('matches 3 places');
    await executeTool('edit', { path: 'a.txt', old_string: 'x', new_string: 'y', replace_all: true }, c);
    expect(store.get('a.txt')).toBe('y y y');
  });

  it('edit errors when old_string is absent', async () => {
    const { io } = memIo({ 'a.txt': 'foo' });
    const c = ctx(io);
    await executeTool('read', { path: 'a.txt' }, c);
    expect(await executeTool('edit', { path: 'a.txt', old_string: 'zzz', new_string: 'q' }, c)).toContain('not found');
  });

  it('grep shells out and bash reports exit + output; unknown tool errors', async () => {
    const exec = vi.fn(async (_h: WorkspaceHandle, cmd: string) =>
      cmd.startsWith('grep') ? { stdout: 'a.txt:1:hit', stderr: '', code: 0 } : { stdout: 'built', stderr: '', code: 0 },
    );
    const { io } = memIo({}, exec);
    const c = ctx(io);
    expect(await executeTool('grep', { pattern: 'hit' }, c)).toContain('a.txt:1:hit');
    expect(await executeTool('bash', { command: 'make' }, c)).toContain('built');
    expect(await executeTool('bogus', {}, c)).toContain('not a supported tool');
  });
});
