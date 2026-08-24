import { describe, expect, it } from 'vitest';
import type { Issue } from '../core/types.js';
import { createTranslator } from '../profile/i18n.js';
import { buildSignals, kickoffPrompt, renderWorkflow, turnPrompt } from './prompt-builder.js';

const issue: Issue = {
  identifier: 'ISS-9',
  internalId: 'x',
  title: 't',
  description: '',
  state: 'planning',
  labels: [],
  blockedBy: [],
  attachments: [],
};

describe('prompt-builder', () => {
  it('kickoff names the issue and the workflow file', () => {
    const p = kickoffPrompt(issue);
    expect(p).toContain('ISS-9');
    expect(p).toContain("Corral's worker");
    expect(p).toContain('.corral/WORKFLOW.md');
  });

  it('turnPrompt passes the message through', () => {
    expect(turnPrompt('go ahead')).toBe('go ahead');
  });

  it('renders the mandatory skills section only when a reference path is set', async () => {
    const repos = [{ key: 'server', dir: 'server', description: 'API', base_branch: 'main', branch: 'feature/ISS-9' }];
    const withRef = await renderWorkflow({ issue, tracker_kind: 'notion', repos, reference_path: '.reference' }, 'WORKFLOW.md');
    expect(withRef).toContain('Skills / conventions (REQUIRED)');
    expect(withRef).toContain('.reference');
    const without = await renderWorkflow({ issue, tracker_kind: 'notion', repos }, 'WORKFLOW.md');
    expect(without).not.toContain('Skills / conventions (REQUIRED)');
  });

  it('renders the Direction block only when direction text is set', async () => {
    const repos = [{ key: 'server', dir: 'server', description: 'API', base_branch: 'main', branch: 'feature/ISS-9' }];
    const withDir = await renderWorkflow(
      { issue, tracker_kind: 'notion', repos, direction: '### Global direction (org / operator)\n안정 우선' },
      'WORKFLOW.md',
    );
    expect(withDir).toContain('Direction (방향성');
    expect(withDir).toContain('guiding, not'); // framing guard present
    expect(withDir).toContain('Issue-level override'); // issue/instructions outrank direction
    expect(withDir).toContain('안정 우선'); // the injected text
    const without = await renderWorkflow({ issue, tracker_kind: 'notion', repos }, 'WORKFLOW.md');
    expect(without).not.toContain('Direction (방향성');
  });

  it('renders the output-language instruction from the context', async () => {
    const repos = [{ key: 'server', dir: 'server', description: 'API', base_branch: 'main', branch: 'feature/ISS-9' }];
    const ko = await renderWorkflow({ issue, tracker_kind: 'notion', repos, language: 'Korean (한국어)' }, 'WORKFLOW.md');
    expect(ko).toContain('Output language');
    expect(ko).toContain('Korean (한국어)');
    const def = await renderWorkflow({ issue, tracker_kind: 'notion', repos }, 'WORKFLOW.md');
    expect(def).toContain('English'); // default when no language given
  });

  /**
   * EARS is a notation, not prose. A Korean user gets the explanation in Korean and the
   * keywords in English — the same split the guide already makes for BLOCKER/SUGGESTION/NIT.
   * If the keywords translated, nothing downstream could ever check the format (CRL-98).
   */
  it('keeps the EARS keywords in English whatever the output language is', async () => {
    const repos = [{ key: 'server', dir: 'server', description: 'API', base_branch: 'main', branch: 'feature/ISS-9' }];
    const ko = await renderWorkflow({ issue, tracker_kind: 'notion', repos, language: 'Korean (한국어)' }, 'WORKFLOW.md');
    expect(ko).toContain('THE SYSTEM SHALL');
    expect(ko).toContain('REQ-n');
  });

  it('gives the planner every EARS form, not just WHEN', async () => {
    // Only offering WHEN makes the agent contort invariants ("WHEN the build runs THE
    // SYSTEM SHALL have no type errors") — that would measure the template, not the agent.
    const repos = [{ key: 'server', dir: 'server', description: 'API', base_branch: 'main', branch: 'feature/ISS-9' }];
    const out = await renderWorkflow({ issue, tracker_kind: 'notion', repos }, 'WORKFLOW.md');
    for (const form of ['THE SYSTEM SHALL', 'WHEN', 'WHILE', 'IF', 'THEN', 'WHERE']) {
      expect(out, `EARS form ${form} missing from branch A`).toContain(form);
    }
    expect(out).toContain('REQ-1');
    // The IDs have to be pointed at by something, or they are decoration.
    expect(out).toMatch(/mark each file you will change and each\s+edge case with the `REQ-n`/);
  });

  it('tells the consolidation to carry the REQ verdicts into pending_review.md', async () => {
    // The rounds rule on each criterion; without this the verdicts die in consolidation and
    // the human never sees which requirement the code missed (CRL-99).
    const repos = [{ key: 'server', dir: 'server', description: 'API', base_branch: 'main', branch: 'feature/ISS-9' }];
    const out = await renderWorkflow({ issue, tracker_kind: 'notion', repos }, 'WORKFLOW.md');
    expect(out).toContain('## Acceptance criteria');
    expect(out).toMatch(/carry those verdicts through/);
    // An older plan without REQ labels must not grow an empty section.
    expect(out).toMatch(/Omit the `## Acceptance criteria` section entirely/);
  });

  /**
   * `claude -p` is one shot: when the model stops talking the process exits. The agent did
   * not know that — it left a background verification running, said it would "wait", and
   * ended the turn with 4.35M tokens of work uncommitted (CRL-89). The guide said nothing
   * about how many turns there are.
   */
  it('tells the worker this is the only turn, and names the background-work trap', async () => {
    const repos = [{ key: 'server', dir: 'server', description: 'API', base_branch: 'main', branch: 'feature/ISS-9' }];
    const out = await renderWorkflow({ issue, tracker_kind: 'notion', repos }, 'WORKFLOW.md');
    expect(out).toContain('single unattended turn');
    expect(out).toMatch(/There is no next turn/);
    // A generic "do not defer" is not enough — the incident WAS a background job whose
    // result was to be collected later, so the guide has to name that shape.
    expect(out).toMatch(/background job and plan to collect its result later/);
  });

  it('orders branch C so the commit precedes any further verification', async () => {
    const repos = [{ key: 'server', dir: 'server', description: 'API', base_branch: 'main', branch: 'feature/ISS-9' }];
    const out = await renderWorkflow({ issue, tracker_kind: 'notion', repos }, 'WORKFLOW.md');
    const commit = out.indexOf('Commit, before any further verification');
    expect(commit).toBeGreaterThan(-1);
    expect(out).toMatch(/Never end the turn with uncommitted changes/);
    // The same failure mode applies to the fix turn, so the rule has to reach it too.
    expect(out.indexOf('this turn is just as final as that one')).toBeGreaterThan(commit);
  });

  it('renders signals in the configured language', () => {
    const ko = buildSignals(createTranslator('ko'));
    expect(ko.approve).toBe('✅ 승인됨');
    expect(ko.feedback('더 명확히')).toBe('⚠️ 피드백: 더 명확히');
    expect(ko.refinePlan('성능')).toBe('🔍 더 검토 요청: 성능');

    const en = buildSignals(createTranslator('en'));
    expect(en.approve).toBe('✅ APPROVED');
    expect(en.feedback('be clearer')).toBe('⚠️ FEEDBACK: be clearer');
  });
});
