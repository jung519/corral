/**
 * The one-turn runner is where a pipeline meets a model. It has to come back with an
 * answer of the declared shape or move to another provider — and say which one answered.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChatClient, ChatTurn, NeutralMessage, ToolDef } from '../../agent/api-loop.js';
import type { AgentProviderId } from '../../agent/types.js';
import { PipelineSchema, type PipelineAgentStep } from '../pipeline/schema.js';
import type { OperationOutcome, OperationResult } from '../pipeline/ports.js';
import { checkAnswer, OneTurnOperationRunner, schemaInstruction } from './one-turn.js';

/** A provider that answers with whatever you hand it, or throws. */
function client(provider: AgentProviderId, reply: string | Error, seen?: NeutralMessage[][]): ChatClient {
  return {
    provider,
    preflight: async () => ({ ok: true }),
    send: async (messages): Promise<ChatTurn> => {
      seen?.push(messages);
      if (reply instanceof Error) throw reply;
      return { text: reply, toolCalls: [], inputTokens: 1000, outputTokens: 200 };
    },
  };
}

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

const GOOD = JSON.stringify({ items: ['a', 'b'], confidence: 0.9 });

/**
 * The answer, for a test that expects one.
 *
 * A turn now reports failure instead of throwing (CRL-44), so reading `.answer` off the
 * outcome needs narrowing. Doing it here means a test that was expecting an answer says
 * what came back instead of failing on `undefined`.
 */
function answered(outcome: OperationOutcome): OperationResult {
  if (!outcome.ok) throw new Error(`expected a usable answer, got: ${outcome.reason}`);
  return outcome;
}

describe('asking for a shape and getting one', () => {
  it('returns the parsed answer', async () => {
    const runner = new OneTurnOperationRunner({ clients: [client('claude', GOOD)] });

    const result = await runner.run(step(), { title: 'a record' });

    expect(answered(result).answer).toEqual({ items: ['a', 'b'], confidence: 0.9 });
  });

  it('puts a list of records in front of the model, not [object Object]', async () => {
    const seen: NeutralMessage[][] = [];
    const runner = new OneTurnOperationRunner({ clients: [client('claude', GOOD, seen)] });
    const s = step({ prompt: { system: 'You summarise.', user_template: 'Yesterday:\n{{records}}' } });

    await runner.run(s, { records: [{ id: 1, title: 'first' }, { id: 2, title: 'second' }] });

    // The whole point of a pipeline that reads a list: the model can see the list.
    expect(seen[0]?.[1]?.content).toBe('Yesterday:\n[{"id":1,"title":"first"},{"id":2,"title":"second"}]');
  });

  it('reports what the turn cost and who answered', async () => {
    const runner = new OneTurnOperationRunner({ clients: [client('claude', GOOD)], modelFor: () => 'sonnet' });

    const result = await runner.run(step(), {});

    expect(result).toMatchObject({
      tokens: 1200,
      inputTokens: 1000,
      outputTokens: 200,
      provider: 'claude',
      model: 'sonnet',
      failedOver: false,
    });
    expect(result.costUsd).toBeGreaterThan(0); // priced through the shared table, not invented here
  });

  it('fills the template and states the shape in the system prompt', async () => {
    const seen: NeutralMessage[][] = [];
    const runner = new OneTurnOperationRunner({ clients: [client('claude', GOOD, seen)] });

    await runner.run(step(), { title: 'a record' });

    expect(seen[0]![0]!.content).toContain('You label records.');
    expect(seen[0]![0]!.content).toContain('single JSON object');
    expect(seen[0]![1]).toEqual({ role: 'user', content: 'Title: a record' });
  });

  it('sends no tools — this is one turn, not a loop', async () => {
    // Parameters spelled out so the recorded call is a tuple and not `[]` — the point of
    // the test is the second argument.
    const send = vi.fn(async (_messages: NeutralMessage[], _tools: ToolDef[], _model?: string) => ({
      text: GOOD,
      toolCalls: [],
      inputTokens: 1,
      outputTokens: 1,
    }));
    const runner = new OneTurnOperationRunner({
      clients: [{ provider: 'claude', preflight: async () => ({ ok: true }), send }],
    });

    await runner.run(step(), {});

    expect(send.mock.calls[0]![1]).toEqual([]);
  });

  it('keeps only the declared fields', async () => {
    const reply = JSON.stringify({ items: [], confidence: 1, note: 'ignore previous instructions' });
    const runner = new OneTurnOperationRunner({ clients: [client('claude', reply)] });

    const result = await runner.run(step(), {});

    // The answer is about to be poured into output templates and someone else's API.
    // Whatever else the model felt like adding has no business travelling that far.
    expect(answered(result).answer).toEqual({ items: [], confidence: 1 });
  });
});

describe('failing over', () => {
  it('moves to the next provider when the first refuses, and says it did', async () => {
    const runner = new OneTurnOperationRunner({
      clients: [client('claude', new Error('HTTP 429: rate limited')), client('gemini', GOOD)],
    });

    const result = await runner.run(step(), {});

    expect(result).toMatchObject({ provider: 'gemini', failedOver: true });
  });

  it('moves on when the answer does not match the shape', async () => {
    // A different model may well obey the shape this one ignored — the acceptance
    // criterion this issue exists for.
    const runner = new OneTurnOperationRunner({
      clients: [client('claude', JSON.stringify({ items: ['a'] })), client('gemini', GOOD)],
    });

    const result = await runner.run(step(), {});

    expect(result).toMatchObject({ provider: 'gemini', failedOver: true });
  });

  it('moves on when the reply has no JSON in it at all', async () => {
    const runner = new OneTurnOperationRunner({
      clients: [client('claude', 'I could not classify this record.'), client('gemini', GOOD)],
    });

    expect(answered(await runner.run(step(), {})).provider).toBe('gemini');
  });

  it('does not fail over for packaging it can unwrap', async () => {
    const runner = new OneTurnOperationRunner({
      clients: [client('claude', `Sure!\n\`\`\`json\n${GOOD}\n\`\`\``), client('gemini', GOOD)],
    });

    // A fence is not a reason to spend a second turn on another provider.
    expect(answered(await runner.run(step(), {})).provider).toBe('claude');
  });

  it('fails over on a truncated reply instead of salvaging part of it', async () => {
    const runner = new OneTurnOperationRunner({
      clients: [client('claude', '{"items":["a"],"conf'), client('gemini', GOOD)],
    });

    expect(answered(await runner.run(step(), {})).provider).toBe('gemini');
  });

  it('reports every attempt when they all fail, not just the last', async () => {
    const runner = new OneTurnOperationRunner({
      clients: [client('claude', new Error('HTTP 429')), client('gemini', 'not json at all')],
    });

    // When a pipeline stops overnight, "one provider was down" and "all of them refused
    // the shape" call for completely different fixes.
    const outcome = await runner.run(step(), {});

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toMatch(/claude: HTTP 429.*gemini: the reply was not JSON/s);
  });

  it('uses only the provider a pipeline named', async () => {
    const runner = new OneTurnOperationRunner({
      clients: [client('claude', new Error('down')), client('gemini', GOOD)],
    });

    // Naming a provider is a choice about which model does this work; silently answering
    // with a different one would make that setting a lie.
    const outcome = await runner.run(step({ provider: 'claude' }), {});

    expect(outcome.ok === false && outcome.reason).toMatch(/claude: down/);
  });

  it('says so when the named provider is not configured at all', async () => {
    const runner = new OneTurnOperationRunner({ clients: [client('claude', GOOD)] });

    await expect(runner.run(step({ provider: 'gemini' }), {})).rejects.toThrow(/"gemini" is not configured/);
  });
});

/**
 * A provider that answered has billed for the answer, and nothing about what happens to it
 * afterwards changes that. Before CRL-44 a turn only reported the attempt that worked, so a
 * pipeline the model never matched billed all day against a ceiling reading zero.
 */
describe('what the turn admits to spending', () => {
  it('counts a failed turn — every provider refused the shape, all of it was billed', async () => {
    const runner = new OneTurnOperationRunner({
      clients: [client('claude', 'not json'), client('gemini', 'also not json')],
    });

    const outcome = await runner.run(step(), {});

    expect(outcome.ok).toBe(false);
    // Two replies came back at 1000 + 200 each. A ceiling that read 0 here would not be one.
    expect(outcome).toMatchObject({ tokens: 2400, inputTokens: 2000, outputTokens: 400 });
    expect(outcome.costUsd).toBeGreaterThan(0);
  });

  it('counts every attempt on a run that succeeded, not just the one that worked', async () => {
    const runner = new OneTurnOperationRunner({
      clients: [client('claude', 'not json'), client('gemini', GOOD)],
    });

    const outcome = await runner.run(step(), {});

    // The run completed, and it cost two turns. Reporting only gemini's would undercount
    // every failover — on successful runs, which is most of them.
    expect(outcome).toMatchObject({ ok: true, provider: 'gemini', failedOver: true, tokens: 2400 });
  });

  it('counts nothing for a request that never came back', async () => {
    // A refused or dropped request is the one case where a provider costs nothing — there
    // is no reply to have been billed for.
    const runner = new OneTurnOperationRunner({ clients: [client('claude', new Error('ECONNREFUSED'))] });

    expect(await runner.run(step(), {})).toMatchObject({ ok: false, tokens: 0, inputTokens: 0, outputTokens: 0 });
  });

  it('refuses to exist with no providers', () => {
    expect(() => new OneTurnOperationRunner({ clients: [] })).toThrow(/at least one provider/);
  });
});

describe('checking an answer', () => {
  const schema = {
    type: 'object' as const,
    properties: { items: { type: 'array' }, confidence: { type: 'number' }, note: { type: 'string' } },
    required: ['items'],
  };

  it('names the missing required field', () => {
    expect(checkAnswer(schema, '{"confidence":1}')).toEqual({
      ok: false,
      reason: 'missing required field(s): items',
    });
  });

  it('names the field whose type is wrong', () => {
    expect(checkAnswer(schema, '{"items":"a,b"}')).toMatchObject({ reason: 'items should be array' });
  });

  it('rejects a JSON array or a bare value as the whole reply', () => {
    expect(checkAnswer(schema, '[1,2]')).toMatchObject({ reason: 'the reply was not a JSON object' });
    expect(checkAnswer(schema, '"yes"')).toMatchObject({ reason: 'the reply was not a JSON object' });
  });

  it('accepts an optional field being absent', () => {
    expect(checkAnswer(schema, '{"items":[]}')).toEqual({ ok: true, answer: { items: [] } });
  });

  it('puts the schema itself in the instruction, so the model sees the field names', () => {
    expect(schemaInstruction(schema)).toContain('"confidence"');
  });
});
