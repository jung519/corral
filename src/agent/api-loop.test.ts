import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceHandle, WorkspaceIO } from '../core/types.js';
import { ApiHttpError, type ChatClient, type ChatTurn, type NeutralMessage, runApiAgent, type ToolDef } from './api-loop.js';
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
