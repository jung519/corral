/**
 * Keeping the public wording inside what is actually built.
 *
 * The adoption plan fixed a line for this (§3): SDD is a general term used by several
 * products, so no first/only claims, and each layer earns a phrase only once it exists.
 * Today all three layers of the target line are in — prompts, three approval gates, task
 * state tracking — and the fourth (dependency-wave parallelism) is not.
 *
 * A one-off read-through would hold until the next commit, so the line is checked here.
 * Note that most of these currently pass because the README says very little about spec
 * mode at all: this is a guard for what gets written next, not a report of something fixed.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const README = read('README.md');
const GUIDE = read('docs/spec-mode.md');
const PLAN = read('docs/sdd-adoption-plan.md');

/** The public-facing surfaces. The plan doc is a working document, not a claim. */
const PUBLIC = { 'README.md': README, 'docs/spec-mode.md': GUIDE };

describe('what the public documents may claim', () => {
  /**
   * §3: "SDD는 Kiro 전유 용어가 아닌 일반 용어다 … 따라서 '최초'·'독자적' 류의 선점 주장은
   * 불가." Checked on the sentences that mention SDD, so ordinary uses of "only" elsewhere
   * are not swept up.
   */
  it.each(Object.entries(PUBLIC))('%s makes no first/only claim about SDD', (_name, text) => {
    const sentences = text.split(/(?<=[.!?])\s+|\n\n/).filter((s) => /spec[- ]driven|SDD|spec mode/i.test(s));
    const offenders = sentences.filter((s) =>
      /\b(first|only|unique|사상 최초|최초|독자적|유일)\b/i.test(s.replace(/`[^`]*`/g, '')),
    );
    expect(offenders).toEqual([]);
  });

  /**
   * The fourth row of the §3 table — Kiro-level parallelism — is explicitly out of scope,
   * and `task-loop.ts` runs tasks one at a time. Saying otherwise would be the exact
   * failure the line exists to prevent.
   */
  it.each(Object.entries(PUBLIC))('%s does not claim parallel task execution', (_name, text) => {
    const sentences = text.split(/\n/).filter((l) => /task/i.test(l));
    const offenders = sentences.filter((l) => /\bin parallel\b|\bconcurrently\b|병렬로 (돌|실행)/i.test(l));
    expect(offenders).toEqual([]);
  });

  it('the guide says outright that parallelism is absent', () => {
    // Stronger than not claiming it: someone comparing products should find the answer.
    expect(GUIDE).toMatch(/병렬/);
    expect(GUIDE).toMatch(/순서대로 하나씩/);
  });
});

describe('spec mode is presented as a choice, not the default', () => {
  /**
   * `spec_mode` defaults to `single` because the ceiling is shared with the operational AI
   * (CRL-101). A reader who takes the three gates for the normal behaviour would plan
   * around a cost nobody is paying.
   */
  it('the README says it is optional and names the cost', () => {
    // The whole paragraph — "Optional" opens it, before the phrase itself.
    const para = README.split('\n\n').find((p) => p.includes('spec mode'))!;
    expect(para).toMatch(/Optional|optional/);
    expect(para).toMatch(/off by default/);
    expect(para).toMatch(/2\.4/);
  });

  it('the guide leads with the default and the trade', () => {
    expect(GUIDE).toMatch(/기본 동작은 \*\*계획 문서 하나를 한 번 승인\*\*/);
    expect(GUIDE).toMatch(/약 2\.4배/);
    // The shared ceiling is the reason for the default, so it belongs next to the cost.
    expect(GUIDE).toMatch(/운영 AI 와 한 통/);
  });
});

describe('the coinage stays out', () => {
  /**
   * "Spec-Driven Orchestration" appeared exactly once in the repo — the plan's own title —
   * while the body and the §3 table never used it. A phrase nobody uses, presented as a
   * name, is the shape §3 rules out (CRL-112).
   */
  it('is gone from every document', () => {
    for (const [name, text] of [...Object.entries(PUBLIC), ['docs/sdd-adoption-plan.md', PLAN]] as const) {
      const uses = text.split('Spec-Driven Orchestration').length - 1;
      // The plan records why it was removed, so one mention there is the note itself.
      expect(uses, `${name}`).toBeLessThanOrEqual(name.includes('adoption-plan') ? 1 : 0);
    }
  });

  it('the plan records why, so it does not come back', () => {
    expect(PLAN).toMatch(/제목에서 조어를 뺐다/);
    expect(PLAN).toMatch(/다시 넣지 않는다/);
  });
});

describe('the guide teaches from real output', () => {
  /**
   * Every example came from documents corral produced running its own issues. An invented
   * example can differ from what the agent actually writes, and then the guide teaches the
   * wrong shape.
   */
  it('shows all five EARS forms', () => {
    for (const form of ['THE SYSTEM SHALL', 'WHEN', 'WHILE', 'IF', 'THEN', 'WHERE']) {
      expect(GUIDE, form).toContain(form);
    }
  });

  it('shows the defect spec, including the section that earns its place', () => {
    expect(GUIDE).toContain('## Unchanged Behavior');
    expect(GUIDE).toContain('SHALL CONTINUE TO');
    // "The existing tests still pass" is a hope, not a behaviour — the guide has to say so.
    expect(GUIDE).toMatch(/동작이 아니라 희망이다/);
  });

  it('shows a tasks.md line a parser would actually accept', () => {
    const TASK_LINE = /^- \[ \] (T\d+) — (.+?) \(((?:REQ-\d+)(?:, REQ-\d+)*)\)(?: \[after: (T\d+)\])?$/;
    const examples = GUIDE.split('\n').filter((l) => l.startsWith('- [ ] T'));
    expect(examples.length).toBeGreaterThanOrEqual(2);
    for (const line of examples) expect(line, `unparseable: ${line}`).toMatch(TASK_LINE);
  });

  it('warns about the mistake the measurement actually found', () => {
    // CRL-98 measured two providers contorting nothing into WHEN only because they were
    // given the other forms; the guide passes that on.
    expect(GUIDE).toMatch(/`WHEN` 으로 뒤틀지 말 것/);
  });
});
