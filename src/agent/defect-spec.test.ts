/**
 * "What must not change" as part of the spec, not an afterthought.
 *
 * This capability already showed up once on its own: in the CRL-103 measurement the agent
 * wrote `REQ-3: … exactly as it does today` for a defect issue without being asked, the
 * design answered it with "byte-for-byte today's behavior", and the task list correctly
 * produced no task for it. One out of nine, and only a human reading the file could tell
 * which one it was. This makes it the shape rather than the accident (CRL-111).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderWorkflow } from './prompt-builder.js';
import type { Issue } from '../core/types.js';

const issue: Issue = {
  identifier: 'ISS-1',
  internalId: 'x',
  title: 'a title',
  description: '',
  state: 'in_progress',
  labels: [],
  blockedBy: [],
  attachments: [],
};
const repos = [{ key: 'server', dir: 'server', description: 'API', base_branch: 'main', branch: 'feature/ISS-1' }];
const render = () => renderWorkflow({ issue, tracker_kind: 'notion', repos }, 'WORKFLOW.md');

describe('the defect shape in the guide', () => {
  it('names all three sections', async () => {
    const out = await render();
    for (const heading of ['## Current Behavior', '## Expected Behavior', '## Unchanged Behavior']) {
      expect(out).toContain(heading);
    }
  });

  /**
   * Reached in both planning modes from one definition, so the shape cannot drift between
   * `single` and `split` — the same reason the EARS block is captured once.
   */
  it('reaches both branch A and branch A1', async () => {
    const out = await render();
    // Counted by a phrase that appears once per rendered block — the heading itself shows
    // up twice inside each (the table row and the worked example).
    expect(out.split('is not a behaviour; it is a hope').length - 1).toBe(2);
  });

  it('keeps `SHALL` out of Current Behavior', async () => {
    // It describes what happens, not what ought to. Writing SHALL there would state the
    // defect as a requirement.
    expect(await render()).toMatch(/No `SHALL` here — this is what happens, not what ought to/);
  });

  it('gives Unchanged Behavior its own keyword', async () => {
    expect(await render()).toContain('SHALL CONTINUE TO');
  });

  it('keeps that keyword in English whatever the output language', async () => {
    const ko = await renderWorkflow({ issue, tracker_kind: 'notion', repos, language: 'Korean (한국어)' }, 'WORKFLOW.md');
    expect(ko).toMatch(/`THE SYSTEM SHALL`\/`SHALL CONTINUE TO`\)/);
  });

  it('keeps one REQ number space across the three sections', async () => {
    // Splitting the numbering would drop the unchanged behaviours out of the review's
    // criteria check and out of the met/unmet count — the ones most worth verifying.
    // The guide wraps, so match across the line break.
    expect(await render()).toMatch(/one number space, so the review rules on all of\s+them/);
  });

  it('is a branch, not a replacement — feature issues keep the single list', async () => {
    expect(await render()).toMatch(/\*\*Otherwise\*\* — new capability, changed behaviour — use the single list above/);
  });

  /**
   * An empty heading and a considered "nothing is at risk" look identical on screen. The
   * acceptance criterion is that the difference is visible.
   */
  it('asks for one line rather than an empty section', async () => {
    expect(await render()).toMatch(/If nothing is genuinely at risk, say so in one line/);
  });

  it('rejects a hope in place of a behaviour', async () => {
    expect(await render()).toMatch(/is not a behaviour; it is a hope/);
  });
});

describe('the rest of the pipeline knows about unchanged behaviour', () => {
  it('the design answers it with what it does not touch', async () => {
    expect(await render()).toMatch(/Answer it with what you are \*not\* touching/);
  });

  it('the task list does not invent work for it', async () => {
    // CRL-103 measured this happening correctly by accident; a "REQ with no task" check
    // would otherwise flag every unchanged behaviour as a gap.
    expect(await render()).toMatch(/Do not invent a task for an Unchanged Behavior requirement/);
  });

  const PROMPT = readFileSync(new URL('../review/prompt.ts', import.meta.url), 'utf8');

  it('the plan critic looks for a missing Unchanged section', () => {
    expect(PROMPT).toMatch(/defect spec with no "Unchanged Behavior" section/);
  });

  it('the reviewer checks it by absence, not by presence', () => {
    // Looking for code that implements an unchanged behaviour would mark every one UNMET.
    expect(PROMPT).toMatch(/met by the diff NOT disturbing it/);
  });
});
