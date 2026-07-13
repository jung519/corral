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
