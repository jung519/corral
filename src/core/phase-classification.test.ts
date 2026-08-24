/**
 * A phase is not just a name — it is a set membership.
 *
 * `WAITING_PHASES` is what stops the poller dispatching over a gate a human is standing at.
 * Add a `*_sent` phase and forget the set, and the flow reads it as idle and runs straight
 * through the approval. Widening the enum is safe; the omission is the bug (CRL-102).
 *
 * The renderer keeps its own copies of these sets as plain string literals rather than
 * importing them, so every membership has to be stated twice. The last block here is what
 * notices when only one copy gets updated. It reads the renderer as text rather than
 * importing it — the renderer is a separate workspace and lives outside this project's
 * `rootDir`, so the same source-reading approach `ops/boundaries.test.ts` uses applies.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { RESUMABLE_PHASES, WAITING_PHASES, type IssuePhase } from './types.js';

/** The three gates spec-driven planning introduces. */
const SPEC_GATES: IssuePhase[] = ['requirements_sent', 'design_sent', 'tasks_sent'];

const PHASE_TS = readFileSync(new URL('../../renderer/src/lib/phase.ts', import.meta.url), 'utf8');

/** The string members of a `const <name> = new Set([...])` in the renderer's phase module. */
function rendererSet(name: string): string[] {
  const m = new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(PHASE_TS);
  expect(m, `${name} not found — the renderer's phase module changed shape`).not.toBeNull();
  return [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

/** The `case '<phase>':` labels the renderer maps to a stage or a waiting label. */
function rendererCases(fnName: string): string[] {
  const start = PHASE_TS.indexOf(`export function ${fnName}`);
  expect(start, `${fnName} not found`).toBeGreaterThan(-1);
  const body = PHASE_TS.slice(start, PHASE_TS.indexOf('\n}', start));
  return [...body.matchAll(/case '([^']+)':/g)].map((x) => x[1]!);
}

describe('the spec gates in the core classifications', () => {
  it.each(SPEC_GATES)('%s waits for a human, so the poller must not dispatch', (phase) => {
    expect(WAITING_PHASES.has(phase)).toBe(true);
  });

  it.each(SPEC_GATES)('%s is not resumable — nothing was interrupted', (phase) => {
    // Resumable means "a restart cut an unattended run short". These are parked on a
    // person; auto-redispatching them would talk over the human, not recover anything.
    expect(RESUMABLE_PHASES.has(phase)).toBe(false);
  });
});

describe('the spec gates in the dashboard', () => {
  it.each(SPEC_GATES)('%s does not show a spinner', (phase) => {
    expect(rendererSet('IDLE_PHASES')).toContain(phase);
  });

  it.each(SPEC_GATES)('%s reads as waiting, not idle', (phase) => {
    expect(rendererSet('WAITING_PHASES')).toContain(phase);
  });

  it('names what each gate is waiting for', () => {
    // Three gates in a row all saying "awaiting plan approval" would tell the reader
    // nothing about where they are.
    const cases = rendererCases('waitingLabelKey');
    for (const phase of SPEC_GATES) expect(cases).toContain(phase);
  });

  it('puts them on a stage instead of falling through to the default', () => {
    // Widening the bar to show them as their own stages is CRL-104; until then they must
    // at least land on the approve column rather than snapping back to stage 0.
    const cases = rendererCases('stageIndex');
    for (const phase of SPEC_GATES) expect(cases).toContain(phase);
  });
});

/**
 * Updating one copy and not the other is silent: the flow gates correctly while the
 * dashboard claims the agent is working, or the reverse.
 */
describe('the two copies of the waiting list', () => {
  it('agree on every phase', () => {
    // `auth_error_waiting` is deliberately only in the core set — the dashboard gives it
    // its own error badge rather than treating it as a normal wait.
    const coreOnly = new Set<string>(['auth_error_waiting']);
    const renderer = new Set(rendererSet('WAITING_PHASES'));
    const missing = [...WAITING_PHASES].filter((p) => !coreOnly.has(p) && !renderer.has(p));
    expect(missing).toEqual([]);
  });
});

/**
 * Spec mode replaces the single approval stage with the three gates it actually is. It has
 * to be told the mode rather than infer it: once the gates are passed the phase says
 * nothing about how planning was shaped, and a bar that inferred would collapse from three
 * stages back to one exactly as the long part of the run begins (CRL-104).
 */
describe('the phase bar in spec mode', () => {
  // These are pure functions, so they are run rather than pattern-matched. Imported
  // through a computed specifier: a literal one fails `tsc` because the renderer is
  // outside this project's `rootDir`, while the runtime resolves it fine.
  let stageIndex: (phase: string, specMode?: string) => number;
  let stageKeys: (specMode?: string) => string[];

  beforeAll(async () => {
    const href = new URL('../../renderer/src/lib/phase.ts', import.meta.url).href;
    const mod = (await import(/* @vite-ignore */ href)) as {
      stageIndex: typeof stageIndex;
      stageKeys: typeof stageKeys;
    };
    stageIndex = mod.stageIndex;
    stageKeys = mod.stageKeys;
  });

  it('leaves the single-mode bar exactly as it was', () => {
    expect(stageKeys('single')).toEqual(['phase.plan', 'phase.approve', 'phase.implement', 'phase.review', 'phase.pr', 'phase.done']);
    expect(stageKeys(undefined)).toEqual(stageKeys('single'));
    for (const [phase, i] of [
      ['initial', 0],
      ['plan_sent', 1],
      ['implementing', 2],
      ['review_sent', 3],
      ['pr_open', 4],
      ['done', 5],
    ] as const) {
      expect(stageIndex(phase), phase).toBe(i);
    }
  });

  it('splits the approval stage into three, rather than appending', () => {
    const keys = stageKeys('split');
    expect(keys).toHaveLength(8);
    expect(keys.slice(1, 4)).toEqual(['kind.requirements', 'kind.design', 'kind.tasks']);
    // The stages around it are the same ones, just shifted.
    expect(keys[0]).toBe('phase.plan');
    expect(keys.slice(4)).toEqual(['phase.implement', 'phase.review', 'phase.pr', 'phase.done']);
  });

  it('gives each gate its own column', () => {
    const at = SPEC_GATES.map((p) => stageIndex(p, 'split'));
    expect(at).toEqual([1, 2, 3]);
  });

  it('shifts everything after the gates by the two extra columns', () => {
    for (const phase of ['implementing', 'review_sent', 'pr_open', 'done']) {
      expect(stageIndex(phase, 'split'), phase).toBe(stageIndex(phase) + 2);
    }
  });

  it('keeps every index inside its own key list', () => {
    for (const mode of ['single', 'split']) {
      const keys = stageKeys(mode);
      for (const phase of ['initial', 'plan_sent', ...SPEC_GATES, 'implementing', 'review_sent', 'pr_open', 'done']) {
        const i = stageIndex(phase, mode);
        expect(keys[i], `${phase} @ ${mode}`).toBeDefined();
      }
    }
  });
});
