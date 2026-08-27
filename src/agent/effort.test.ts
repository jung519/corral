/**
 * Reasoning effort — the knob corral had and was not turning.
 *
 * Measured on one issue's planning: 55.6% of the model wait was thinking between tool calls,
 * against 31.7% writing documents and 0.1% actually running the tools. Then the same small
 * task at three settings, twice each:
 *
 *     low      25s, 25s   thinking blocks 0   tool calls 5, 5   output 520, 432 chars
 *     default  34s, 36s   thinking blocks 1   tool calls 5, 5   output 553, 591
 *     high     39s, 33s   thinking blocks 2   tool calls 5, 5   output 740, 620
 *
 * The tool count never moves: effort changes how deeply the model deliberates, not how much
 * it looks at. The output gets thinner as it drops, which is the price (CRL-131).
 *
 * The other half is that a setting which quietly does nothing is its own defect — `agent
 * .max_tokens` was configured, never passed, and nobody could tell (CRL-93).
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSchema } from '../config/schema.js';
import { transportHonoursEffort } from './index.js';

const spawnArgs: string[][] = [];

vi.mock('node:child_process', () => ({
  spawn: (_c: string, args: string[]) => {
    spawnArgs.push(args);
    const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable };
    child.stdout = Readable.from([]);
    child.stderr = Readable.from([]);
    setTimeout(() => child.emit('close', 0), 0);
    return child;
  },
}));

const { ClaudeCliTransport } = await import('./claude-cli.js');

const turn = (effort?: string) =>
  ({
    handle: { id: 'ISS-1', workdir: '/w', backend: 'local' },
    io: { writeFile: async () => {} },
    prompt: 'do it',
    workflow: '',
    continueSession: false,
    effort,
  }) as never;

beforeEach(() => {
  spawnArgs.length = 0;
});

describe('the flag on the wire', () => {
  it('is absent when no effort was configured — every run today', async () => {
    await new ClaudeCliTransport(null).run(turn(), () => {});
    expect(spawnArgs.at(-1)).not.toContain('--effort');
  });

  it('carries the configured level', async () => {
    await new ClaudeCliTransport(null).run(turn('low'), () => {});
    const args = spawnArgs.at(-1)!;
    expect(args[args.indexOf('--effort') + 1]).toBe('low');
  });
});

describe('which transports take it', () => {
  it.each([
    ['claude', 'cli', true],
    ['claude', 'api', false],
    ['gpt', 'cli', false],
    ['gemini', 'cli', false],
  ] as const)('%s:%s → %s', (provider, transport, expected) => {
    expect(transportHonoursEffort({ provider, transport })).toBe(expected);
  });
});

describe('the config', () => {
  const base = { provider: 'claude', transport: 'cli' } as const;

  it('accepts a level per stage', () => {
    const a = AgentSchema.parse({ ...base, effort: { planning: 'high', implementation: 'low' } });
    expect(a.effort).toEqual({ planning: 'high', implementation: 'low' });
  });

  it('defaults to nothing set', () => {
    expect(AgentSchema.parse(base).effort).toEqual({});
  });

  it('refuses a level that is not one of the five', () => {
    // A typo that parsed would be a setting that silently did nothing.
    expect(() => AgentSchema.parse({ ...base, effort: { planning: 'very-high' } })).toThrow();
  });

  it('can be overridden per stage-routed agent', () => {
    const a = AgentSchema.parse({
      ...base,
      effort: { planning: 'high' },
      stages: { review: { provider: 'claude', transport: 'cli', effort: { review: 'max' } } },
    });
    expect(a.stages?.review?.effort).toEqual({ review: 'max' });
  });
});

/**
 * The half that is not about speed: a setting nobody honours must not be silent.
 * `agent.max_tokens` was configured, never passed, and the only way to find out was to read
 * the source (CRL-93).
 */
describe('a level set where nothing will read it', () => {
  const warn = readFileSync(new URL('../bootstrap.ts', import.meta.url), 'utf8');

  it('is warned about at startup, naming who dropped it', () => {
    expect(warn).toMatch(/is ignored: /);
    expect(warn).toMatch(/\$\{r\.provider\}:\$\{r\.transport\} has no reasoning-effort setting/);
  });

  it('checks the stage-routed agents too, not just the base one', () => {
    expect(warn).toMatch(/agent\.stages\.\$\{k\}/);
  });

  it('says nothing when the level is set on a transport that takes it', () => {
    // The guard is the same predicate the adapter uses, so the two cannot drift.
    expect(warn).toContain('!transportHonoursEffort(r)');
  });
});
