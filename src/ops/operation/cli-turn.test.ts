/**
 * The CLI model step: an agent writes a file, and that file is the answer.
 *
 * The transport is a stub — spawning a real `claude` binary is not what these check.
 * Everything the stub is handed is the real thing the transports receive, and everything
 * it produces goes through the same checks an API answer does.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentTransport, AgentTurnSpec } from '../../agent/types.js';
import { PipelineSchema, type PipelineAgentStep } from '../pipeline/schema.js';
import { ANSWER_FILE, CliTurnOperationRunner } from './cli-turn.js';

function step(over: Record<string, unknown> = {}): PipelineAgentStep {
  return PipelineSchema.parse({
    key: 'p',
    trigger: { kind: 'manual' },
    input: { kind: 'none' },
    agent: {
      prompt: { system: 'You label records.', user_template: 'Title: {{title}}' },
      schema: {
        type: 'object',
        properties: { items: { type: 'array' }, confidence: { type: 'number' } },
        required: ['items', 'confidence'],
      },
      ...over,
    },
    output: { kind: 'none' },
  }).agent;
}

/** An agent that writes `answer.json` and reports what it spent. */
function writes(
  provider: 'claude' | 'gemini' | 'gpt',
  content: string | null,
  seen?: AgentTurnSpec[],
  usage = { inputTokens: 800, outputTokens: 40, costUsd: 0.004 },
): AgentTransport {
  return {
    provider,
    transport: 'cli',
    preflight: async () => ({ ok: true }),
    run: async (spec: AgentTurnSpec, onEvent: (e: AgentEvent) => void) => {
      seen?.push(spec);
      if (content !== null) writeFileSync(join(spec.handle.workdir, ANSWER_FILE), content);
      onEvent({ type: 'usage', ...usage });
      onEvent({ type: 'done', exitCode: 0 });
    },
  };
}

/** An agent that fails the way the CLI runner reports failures. */
function fails(provider: 'claude' | 'gemini' | 'gpt', kind: 'timeout' | 'crashed'): AgentTransport {
  return {
    provider,
    transport: 'cli',
    preflight: async () => ({ ok: true }),
    run: async (_spec, onEvent) => {
      onEvent({ type: 'error', error: kind, message: 'the process gave up' });
    },
  };
}

const GOOD = JSON.stringify({ items: ['news'], confidence: 0.9 });

describe('the file is the answer', () => {
  it('reads what the agent wrote and returns it parsed', async () => {
    const runner = new CliTurnOperationRunner({ transports: [writes('claude', GOOD)] });

    const result = await runner.run(step(), { title: 'a record' });

    expect(result.answer).toEqual({ items: ['news'], confidence: 0.9 });
    expect(result).toMatchObject({ provider: 'claude', tokens: 840, inputTokens: 800, outputTokens: 40, costUsd: 0.004 });
  });

  it('gives the agent a directory of its own and takes it back', async () => {
    const seen: AgentTurnSpec[] = [];
    const runner = new CliTurnOperationRunner({ transports: [writes('claude', GOOD, seen)] });

    await runner.run(step(), {});

    const workdir = seen[0]!.handle.workdir;
    expect(seen[0]!.handle.backend).toBe('local');
    // Thousands of runs a day: the folder cannot outlive the run that made it.
    expect(existsSync(workdir)).toBe(false);
  });

  it('writes no workflow guide — that is the development AI\'s rulebook, not this', async () => {
    const seen: AgentTurnSpec[] = [];
    const runner = new CliTurnOperationRunner({ transports: [writes('claude', GOOD, seen)] });

    await runner.run(step(), {});

    // Empty `workflow` is also what keeps `io` from ever being touched.
    expect(seen[0]!.workflow).toBe('');
    expect(seen[0]!.continueSession).toBe(false);
  });

  it('fills the prompt the same way the API runner does, and says where to put the answer', async () => {
    const seen: AgentTurnSpec[] = [];
    const runner = new CliTurnOperationRunner({ transports: [writes('claude', GOOD, seen)] });

    await runner.run(step(), { title: 'a record' });

    expect(seen[0]!.prompt).toContain('You label records.');
    expect(seen[0]!.prompt).toContain('Title: a record');
    expect(seen[0]!.prompt).toContain(ANSWER_FILE);
  });
});

describe('when the agent does not deliver', () => {
  it('says which file was missing rather than "it failed"', async () => {
    const runner = new CliTurnOperationRunner({ transports: [writes('claude', null)] });

    await expect(runner.run(step(), {})).rejects.toThrow(new RegExp(`did not write ${ANSWER_FILE}`));
  });

  it('holds a CLI answer to the same shape an API answer is held to', async () => {
    // Two shape checks would mean the rules depended on which transport was configured.
    const runner = new CliTurnOperationRunner({ transports: [writes('claude', '{"items":["news"]}')] });

    await expect(runner.run(step(), {})).rejects.toThrow(/missing required field\(s\): confidence/);
  });

  it('moves to the next provider when one crashes, and reports both', async () => {
    const runner = new CliTurnOperationRunner({ transports: [fails('claude', 'crashed'), writes('gemini', GOOD)] });

    const result = await runner.run(step(), {});

    expect(result).toMatchObject({ provider: 'gemini', failedOver: true });
  });

  it('lists every attempt when none of them worked', async () => {
    const runner = new CliTurnOperationRunner({ transports: [fails('claude', 'timeout'), fails('gemini', 'crashed')] });

    await expect(runner.run(step(), {})).rejects.toThrow(/claude: timeout.*gemini: crashed/s);
  });

  it('refuses a provider this core has no cli for, by name', async () => {
    const runner = new CliTurnOperationRunner({ transports: [writes('claude', GOOD)] });

    await expect(runner.run(step({ provider: 'gemini' }), {})).rejects.toThrow(/"gemini" is not configured for the cli/);
  });
});
