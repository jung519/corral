import { describe, expect, it } from 'vitest';
import { blockToAttachment, blockToText, classifyAttachment } from './notion.js';

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
