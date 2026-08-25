/**
 * Making the implementation visible.
 *
 * `implementing` used to be one label sitting still for tens of minutes; the plan doc calls
 * this the biggest change a user feels. The interesting part is not the number but where it
 * comes from — recorded where the loop already parses the file, so showing it costs no
 * extra I/O on a path the dashboard polls (CRL-107).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ORCHESTRATOR = readFileSync(new URL('../orchestrator.ts', import.meta.url), 'utf8');
const DASHBOARD = readFileSync(new URL('../../renderer/src/Dashboard.svelte', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../../renderer/src/lib/i18n.svelte.ts', import.meta.url), 'utf8');

describe('where the count comes from', () => {
  it('is written from the parse the loop already holds', () => {
    // The alternative — reading tasks.md inside snapshot() — would put file I/O per issue
    // on every dashboard poll.
    const loop = ORCHESTRATOR.slice(ORCHESTRATOR.indexOf('private async runTaskLoop'));
    const parse = loop.indexOf('parseSpecTasks(await this.workspace.io.readFile');
    const record = loop.indexOf('rt.taskProgress = tasks');
    expect(parse).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(parse);
  });

  it('adds no read of its own', () => {
    // One read of tasks.md per round at the top of the loop, plus the one CRL-109 does to
    // check the tick. Progress reuses the first.
    const loop = ORCHESTRATOR.slice(
      ORCHESTRATOR.indexOf('private async runTaskLoop'),
      ORCHESTRATOR.indexOf('private async repoHeads'),
    );
    expect(loop.split('readFile(handle, SPEC.tasks)').length - 1).toBe(2);
  });

  it('is persisted, so a restart still has it before the loop runs again', () => {
    expect(ORCHESTRATOR).toMatch(/rt\.taskProgress = tasks[\s\S]{0,160}this\.store\.upsert\(rt\)/);
  });

  it('is cleared when the loop leaves, so a later cycle cannot show old numbers', () => {
    const loop = ORCHESTRATOR.slice(ORCHESTRATOR.indexOf('private async runTaskLoop'));
    // Both exits: the downgrade to a single turn, and the finish that goes on to review.
    expect(loop.slice(0, 3000).split('this.clearTaskProgress(rt)').length - 1).toBe(2);
  });
});

describe('what the dashboard shows', () => {
  it('shows nothing when there is no progress to show', () => {
    // `single` mode, and any issue planned before spec mode existed.
    expect(DASHBOARD).toMatch(/\{#if issue\.taskProgress\}/);
  });

  /**
   * A clean `3/5` over a file whose other lines could not be read is the misreading CRL-105
   * built its warnings for and CRL-106 surfaced as events. The count must not be the last
   * word on screen either.
   */
  it('says when the count is over a partly unreadable file', () => {
    expect(DASHBOARD).toMatch(/issue\.taskProgress\.warnings > 0/);
    expect(I18N).toContain('dash.tasks.warn.hint');
  });

  it('offers the spec documents after the approval cards are gone', () => {
    expect(DASHBOARD).toContain("specFor = issue.identifier");
  });
});

describe('the spec document reader', () => {
  const specDocs = ORCHESTRATOR.slice(ORCHESTRATOR.indexOf('async specDocs('), ORCHESTRATOR.indexOf('private clearTaskProgress'));

  it('renders on the core side', () => {
    // The window has no markdown parser, and that boundary is deliberate — the same call
    // CRL-104 made for YAML.
    expect(specDocs).toContain('renderMarkdown(markdown)');
  });

  it('leaves out a stage that has not run, rather than showing an empty tab', () => {
    // An empty tab reads as "there is nothing to say here", which is a different statement
    // from "this stage has not happened".
    expect(specDocs).toMatch(/if \(markdown\?\.trim\(\)\)/);
  });

  it('answers with nothing for an issue that has no workspace', () => {
    expect(specDocs).toMatch(/if \(!handle\) return \[\];/);
  });
});

describe('the new strings', () => {
  it.each(['dash.tasks', 'dash.tasks.hint', 'dash.tasks.warn.hint', 'spec.open', 'spec.title', 'spec.none'])(
    '%s exists in both catalogues',
    (key) => {
      // The pairing check added in CRL-104 covers this generally; these are named because a
      // missing one here shows the raw key on the busiest screen.
      expect(I18N.split(`'${key}':`).length - 1).toBe(2);
    },
  );
});
