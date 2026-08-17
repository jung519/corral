/**
 * The trigger axis: the definition's `kind` picks the adapter, a schedule actually
 * produces runs, and disabling a pipeline makes it go quiet rather than merely refusing
 * the runs it keeps making.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOpsHost } from '../ops-host.js';
import type { OperationRunner } from '../pipeline/ports.js';
import { PipelineSchema, type Pipeline } from '../pipeline/schema.js';
import { ScheduleTrigger } from './schedule.js';
import { triggerRegistry } from './index.js';

let dir: string;

const pipeline = (over: Record<string, unknown>): Pipeline =>
  PipelineSchema.parse({
    key: 'nightly',
    trigger: { kind: 'manual' },
    input: { kind: 'none' },
    agent: { prompt: { system: 's', user_template: 'u' }, schema: { type: 'object', properties: { a: { type: 'string' } } } },
    output: { kind: 'none' },
    ...over,
  });

const stubModel: OperationRunner = { run: async () => ({ answer: { a: 'ok' }, tokens: 1 }) };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'corral-trigger-'));
  mkdirSync(join(dir, 'pipelines'), { recursive: true });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function writePipeline(name: string, body: string): void {
  writeFileSync(join(dir, 'pipelines', name), body);
}

describe('the registry picks by kind', () => {
  it('answers for every kind the schema allows', () => {
    // A kind the schema accepts but nothing implements would be a pipeline that never
    // fires; the two lists have to agree.
    expect(triggerRegistry.has('manual')).toBe(true);
    expect(triggerRegistry.has('schedule')).toBe(true);
  });

  it('names what it has when asked for something else', () => {
    expect(() => triggerRegistry.create({ kind: 'carrier-pigeon' } as never, {})).toThrow(/registered: manual, schedule/);
  });

  it('builds the adapter the definition asks for', () => {
    expect(triggerRegistry.create(pipeline({ trigger: { kind: 'schedule', cron: '* * * * *' } }).trigger, {}).kind).toBe(
      'schedule',
    );
  });
});

describe('a schedule', () => {
  /** Runs the clock forward `minutes` minutes, one tick at a time. */
  async function advance(minutes: number, clock: { at: number }): Promise<void> {
    for (let i = 0; i < minutes; i++) {
      clock.at += 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
    }
  }

  it('fires on the minutes the expression names, and not on the others', async () => {
    const clock = { at: new Date(2026, 7, 15, 0, 58, 0).getTime() };
    const fired: unknown[] = [];
    const stop = new ScheduleTrigger({ now: () => clock.at }).start(
      pipeline({ trigger: { kind: 'schedule', cron: '0 * * * *' } }), // top of every hour
      async (event) => (fired.push(event), undefined),
    );

    await advance(5, clock); // 00:59 … 01:03

    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ pipeline: 'nightly' });
    stop();
  });

  it("fires on the operator's clock, not the machine's", async () => {
    // 2026-08-15T23:58Z. In Seoul that is already 08:58 on the 16th, so "every day at
    // 09:00" is two minutes away — while the machine's own clock is nowhere near it.
    const clock = { at: Date.UTC(2026, 7, 15, 23, 58) };
    const fired: unknown[] = [];
    const stop = new ScheduleTrigger({ now: () => clock.at }).start(
      pipeline({ trigger: { kind: 'schedule', cron: '0 9 * * *', timezone: 'Asia/Seoul' } }),
      async (event) => (fired.push(event), undefined),
    );

    await advance(5, clock); // 23:59Z, 00:00Z, 00:01Z …

    expect(fired).toHaveLength(1);
    expect(new Date((fired[0] as { scheduledAt: string }).scheduledAt).toISOString()).toBe('2026-08-16T00:00:00.000Z');
    stop();
  });

  it('leaves a pipeline without a zone on the machine it runs on', async () => {
    // The existing behaviour, unchanged: no zone means whatever clock the core has.
    const clock = { at: new Date(2026, 7, 15, 8, 58, 0).getTime() };
    const fired: unknown[] = [];
    const stop = new ScheduleTrigger({ now: () => clock.at }).start(
      pipeline({ trigger: { kind: 'schedule', cron: '0 9 * * *' } }),
      async (event) => (fired.push(event), undefined),
    );

    await advance(5, clock);

    expect(fired).toHaveLength(1);
    stop();
  });

  it('stops firing once stopped', async () => {
    const clock = { at: new Date(2026, 7, 15, 0, 0, 0).getTime() };
    const fired: unknown[] = [];
    const stop = new ScheduleTrigger({ now: () => clock.at }).start(
      pipeline({ trigger: { kind: 'schedule', cron: '* * * * *' } }),
      async (event) => (fired.push(event), undefined),
    );

    await advance(2, clock);
    const before = fired.length;
    stop();
    await advance(5, clock);

    expect(before).toBeGreaterThan(0);
    expect(fired).toHaveLength(before);
  });

  it('skips a firing while the previous run is still going', async () => {
    const clock = { at: new Date(2026, 7, 15, 0, 0, 0).getTime() };
    let started = 0;
    let release: (() => void) | undefined;
    const stop = new ScheduleTrigger({ now: () => clock.at }).start(
      pipeline({ trigger: { kind: 'schedule', cron: '* * * * *' } }),
      () => {
        started++;
        return new Promise((resolve) => (release = () => resolve(undefined)));
      },
    );

    await advance(4, clock);

    // A periodic job that has fallen behind should not stack up work the concurrency
    // limit would only throttle later.
    expect(started).toBe(1);
    release?.();
    stop();
  });

  it('stays stopped, loudly, when the expression cannot be read', () => {
    const fired: unknown[] = [];
    const stop = new ScheduleTrigger().start(
      { ...pipeline({}), trigger: { kind: 'schedule', cron: 'every tuesday please' } } as Pipeline,
      async (event) => (fired.push(event), undefined),
    );

    // Guessing at an interval would be worse than not running: nobody asked for whatever
    // we guessed.
    expect(fired).toEqual([]);
    stop();
  });
});

describe('subscriptions follow what is enabled', () => {
  it('starts one for each enabled pipeline and none for the disabled', async () => {
    writePipeline('a.yaml', 'key: a\ntrigger: { kind: schedule, cron: "* * * * *" }\ninput: { kind: none }\nagent: { prompt: { system: s, user_template: u }, schema: { type: object, properties: { a: { type: string } } } }\noutput: { kind: none }\n');
    writePipeline('b.yaml', 'key: b\nenabled: false\ntrigger: { kind: schedule, cron: "* * * * *" }\ninput: { kind: none }\nagent: { prompt: { system: s, user_template: u }, schema: { type: object, properties: { a: { type: string } } } }\noutput: { kind: none }\n');

    const host = await startOpsHost({ stateDir: dir, operation: stubModel });

    expect(host.running()).toEqual(['a']);
  });

  it('stops the trigger when a pipeline is disabled', async () => {
    writePipeline('a.yaml', 'key: a\ntrigger: { kind: schedule, cron: "* * * * *" }\ninput: { kind: none }\nagent: { prompt: { system: s, user_template: u }, schema: { type: object, properties: { a: { type: string } } } }\noutput: { kind: none }\n');
    const host = await startOpsHost({ stateDir: dir, operation: stubModel });

    host.registry.setEnabled('a', false);
    host.syncSubscriptions();

    // Disabling must make it go quiet — a timer that outlives its pipeline is work
    // nobody asked for.
    expect(host.running()).toEqual([]);
  });

  it('starts it again when re-enabled', async () => {
    writePipeline('a.yaml', 'key: a\ntrigger: { kind: schedule, cron: "* * * * *" }\ninput: { kind: none }\nagent: { prompt: { system: s, user_template: u }, schema: { type: object, properties: { a: { type: string } } } }\noutput: { kind: none }\n');
    const host = await startOpsHost({ stateDir: dir, operation: stubModel });

    host.registry.setEnabled('a', false);
    host.syncSubscriptions();
    host.registry.setEnabled('a', true);
    host.syncSubscriptions();

    expect(host.running()).toEqual(['a']);
  });

  it('subscribes a manual pipeline without it doing anything', async () => {
    writePipeline('m.yaml', 'key: m\ntrigger: { kind: manual }\ninput: { kind: none }\nagent: { prompt: { system: s, user_template: u }, schema: { type: object, properties: { a: { type: string } } } }\noutput: { kind: none }\n');

    const host = await startOpsHost({ stateDir: dir, operation: stubModel });

    // `manual` is a kind like any other so nothing in the runtime has to ask "unless
    // it's manual" — it simply has nothing to subscribe to.
    expect(host.running()).toEqual(['m']);
  });

  it('releases everything on shutdown', async () => {
    writePipeline('a.yaml', 'key: a\ntrigger: { kind: schedule, cron: "* * * * *" }\ninput: { kind: none }\nagent: { prompt: { system: s, user_template: u }, schema: { type: object, properties: { a: { type: string } } } }\noutput: { kind: none }\n');
    const host = await startOpsHost({ stateDir: dir, operation: stubModel });

    await host.stop();

    expect(host.running()).toEqual([]);
  });
});
