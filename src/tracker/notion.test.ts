import { describe, expect, it } from 'vitest';
import { blockToAttachment, blockToText, classifyAttachment, searchClause, searchIdOf } from './notion.js';

describe('notion pure helpers', () => {
  it('flattens rich_text out of a typed block', () => {
    const block = { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'hello ' }, { plain_text: 'world' }] } };
    expect(blockToText(block)).toBe('hello world');
  });

  it('returns empty for a block with no rich_text', () => {
    expect(blockToText({ type: 'divider', divider: {} })).toBe('');
    expect(blockToText({})).toBe('');
  });

  it('extracts a file attachment with a derived name', () => {
    const block = { type: 'pdf', pdf: { file: { url: 'https://x.com/path/spec.pdf?sig=1' } } };
    const att = blockToAttachment(block);
    expect(att).toEqual({ kind: 'pdf', name: 'spec.pdf', url: 'https://x.com/path/spec.pdf?sig=1' });
  });

  it('ignores non-attachment blocks', () => {
    expect(blockToAttachment({ type: 'paragraph', paragraph: { rich_text: [] } })).toBeNull();
  });

  it('classifies by extension and block type', () => {
    expect(classifyAttachment('readme.md', 'file')).toBe('md');
    expect(classifyAttachment('photo.PNG', 'file')).toBe('image');
    expect(classifyAttachment('noext', 'image')).toBe('image');
    expect(classifyAttachment('data.bin', 'file')).toBe('other');
  });
});

// The picker's search box (CRL-124). The clause shape *is* the behavior: a wrong key or
// a stray clause surfaces as "no results", which reads as a broken box, not a bad filter.
describe('candidate search clause', () => {
  it('has nothing to add without a term', () => {
    expect(searchClause('', 'Task', 'title', 'ID')).toBeNull();
    expect(searchClause('   ', 'Task', 'title', 'ID')).toBeNull();
  });

  it('matches a title substring, and only the title', () => {
    expect(searchClause('festival', 'Task', 'title', 'ID')).toEqual({
      property: 'Task',
      title: { contains: 'festival' },
    });
  });

  it('uses whichever title filter key the database took', () => {
    expect(searchClause('festival', 'Task', 'rich_text', 'ID')).toEqual({
      property: 'Task',
      rich_text: { contains: 'festival' },
    });
  });

  it('also matches the exact id when the term is one', () => {
    expect(searchClause('CRL-545', 'Task', 'title', 'ID')).toEqual({
      or: [{ property: 'Task', title: { contains: 'CRL-545' } }, { property: 'ID', unique_id: { equals: 545 } }],
    });
    expect(searchClause('545', 'Task', 'title', 'ID')).toEqual({
      or: [{ property: 'Task', title: { contains: '545' } }, { property: 'ID', unique_id: { equals: 545 } }],
    });
  });

  it('reads an id only when the whole term is one', () => {
    expect(searchIdOf('545')).toBe(545);
    expect(searchIdOf('CRL-545')).toBe(545);
    expect(searchIdOf('CRL 545')).toBe(545);
    expect(searchIdOf('  crl_545  ')).toBe(545);
    // A phrase ending in a number is a phrase: the prefix cap is what tells the two
    // apart, so a word longer than an id prefix keeps the term a title search.
    expect(searchIdOf('festival 2026')).toBeNull();
    expect(searchIdOf('2026 festival')).toBeNull();
    expect(searchIdOf('CRL-545-b')).toBeNull();
    expect(searchIdOf('')).toBeNull();
    // Erring toward an id: a short word before a number reads as one. The cost is one
    // extra row (the OR only adds), which beats refusing an id the user can see.
    expect(searchIdOf('phase-2')).toBe(2);
  });
});
