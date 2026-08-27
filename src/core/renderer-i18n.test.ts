/**
 * Two things the dashboard cannot say for itself.
 *
 * The approval card used to print `action.kind` raw. That was survivable while the kinds
 * were `plan` and `review` — short words that read the same in both languages. Spec mode
 * brings three more, and "requirements" vs "design" is the whole content of the card, so a
 * missing translation is not cosmetic (CRL-104).
 *
 * And a key present in one catalogue but not the other falls back to the raw key. Nothing
 * checked that before, so a Korean user could hit an English string — or a key — with no
 * test failing. Read as source rather than imported: the renderer is a separate workspace,
 * outside this project's `rootDir`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APPROVAL_KINDS } from './types.js';

const I18N = readFileSync(new URL('../../renderer/src/lib/i18n.svelte.ts', import.meta.url), 'utf8');
const PHASE = readFileSync(new URL('../../renderer/src/lib/phase.ts', import.meta.url), 'utf8');

/** The keys of one catalogue, located by its `const <name>: Messages = {` header. */
function catalogue(name: string): Set<string> {
  const start = I18N.indexOf(`const ${name}`);
  expect(start, `catalogue ${name} not found`).toBeGreaterThan(-1);
  const end = I18N.indexOf('\n};', start);
  return new Set([...I18N.slice(start, end).matchAll(/^\s{2}'([^']+)':/gm)].map((m) => m[1]!));
}

describe('the two message catalogues', () => {
  const en = catalogue('en');
  const ko = catalogue('ko');

  it('are both non-trivial (the extraction actually worked)', () => {
    expect(en.size).toBeGreaterThan(50);
    expect(ko.size).toBeGreaterThan(50);
  });

  it('carry the same keys', () => {
    // A key in one and not the other renders as the raw key for those users.
    expect([...en].filter((k) => !ko.has(k))).toEqual([]);
    expect([...ko].filter((k) => !en.has(k))).toEqual([]);
  });

  it('name every approval kind', () => {
    for (const kind of APPROVAL_KINDS) {
      expect(en.has(`kind.${kind}`), `kind.${kind} missing from en`).toBe(true);
      expect(ko.has(`kind.${kind}`), `kind.${kind} missing from ko`).toBe(true);
    }
  });

  it('explain what each spec gate approves', () => {
    // The three cards are structurally identical; the badge alone does not say which is
    // which, and approving the wrong one sends the run down the wrong path.
    for (const kind of ['requirements', 'design', 'tasks']) {
      expect(en.has(`kind.${kind}.hint`), `kind.${kind}.hint missing`).toBe(true);
    }
  });

  it('cover every stage the phase bar can render', () => {
    const keys = [...PHASE.matchAll(/'(phase\.[a-z]+|kind\.[a-z]+)'/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(6);
    for (const key of new Set(keys)) expect(en.has(key), `${key} missing from en`).toBe(true);
  });
});

describe('the approval card', () => {
  const CARD = readFileSync(new URL('../../renderer/src/ApprovalCard.svelte', import.meta.url), 'utf8');
  const POPUP = readFileSync(new URL('../../renderer/src/QuestionPopup.svelte', import.meta.url), 'utf8');

  it('translates the kind instead of printing it raw', () => {
    // The badge specifically — `${action.kind}` inside a translation key is fine, printing
    // it as element content is not.
    expect(CARD).not.toMatch(/>\{action\.kind\}</);
    expect(CARD).toMatch(/<span class="badge">\{t\(`kind\.\$\{action\.kind\}`\)\}<\/span>/);
  });

  it('treats the spec gates as plan-like in the question popup', () => {
    // Otherwise approve-with-instructions disappears on three of the six card kinds.
    for (const kind of ['requirements', 'design', 'tasks']) {
      expect(POPUP).toContain(`'${kind}'`);
    }
  });
});
