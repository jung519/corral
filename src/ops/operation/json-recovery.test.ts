/**
 * Recovering the answer from a reply that also contains packaging — and refusing to
 * recover one that is actually missing content.
 */
import { describe, expect, it } from 'vitest';
import { extractJsonObject } from './json-recovery.js';

describe('unwrapping a good answer', () => {
  it('gets it out of a code fence', () => {
    expect(extractJsonObject('```json\n{"items":["a"],"confidence":0.9}\n```')).toEqual({
      items: ['a'],
      confidence: 0.9,
    });
  });

  it('gets it out of a fence with no language tag', () => {
    expect(extractJsonObject('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('ignores an opener before it', () => {
    expect(extractJsonObject('Sure! Here you go:\n{"a":1}')).toEqual({ a: 1 });
  });

  it('ignores a sentence after it', () => {
    expect(extractJsonObject('{"a":1}\n\nLet me know if you need anything else!')).toEqual({ a: 1 });
  });

  it('handles both at once, which is what actually happens', () => {
    const reply = 'Of course. Here is the classification:\n\n```json\n{"items":["news"],"confidence":0.82}\n```\n\nHope that helps!';

    expect(extractJsonObject(reply)).toEqual({ items: ['news'], confidence: 0.82 });
  });
});

describe('braces that are not structure', () => {
  it('does not cut at a brace inside a string value', () => {
    expect(extractJsonObject('{"note":"use {curly} braces","a":1}')).toEqual({
      note: 'use {curly} braces',
      a: 1,
    });
  });

  it('handles an escaped quote inside that string', () => {
    expect(extractJsonObject('{"note":"say \\"hi\\" } there","a":1}')).toEqual({
      note: 'say "hi" } there',
      a: 1,
    });
  });

  it('ends the string on a quote after an escaped backslash', () => {
    // `"a\\"` is a complete string ending in one backslash — the brace after it is
    // structure, not text.
    expect(extractJsonObject('{"note":"a\\\\","b":{"c":1}}')).toEqual({ note: 'a\\', b: { c: 1 } });
  });

  it('keeps nested objects whole', () => {
    expect(extractJsonObject('noise {"a":{"b":{"c":1}}} more')).toEqual({ a: { b: { c: 1 } } });
  });

  it('skips a stray brace in the preamble and finds the real answer', () => {
    expect(extractJsonObject('The result {see below}: {"a":1}')).toEqual({ a: 1 });
  });
});

describe('what must not be recovered', () => {
  it('refuses a reply that was cut off mid-object', () => {
    // Content is genuinely missing. Guessing at it would put invented data into
    // someone's system; the run fails and another provider gets a turn.
    expect(extractJsonObject('{"items":["a","b"],"confid')).toBeNull();
  });

  it('refuses a reply cut off inside a nested object', () => {
    // The dangerous case: the inner `{"b":1}` IS balanced and parseable. Handing that
    // back would present half an answer as a whole one.
    expect(extractJsonObject('{"a":{"b":1}')).toBeNull();
  });

  it('refuses rather than salvaging a fragment from a cut-off list of objects', () => {
    expect(extractJsonObject('{"results":[{"a":1},{"b":2}')).toBeNull();
  });

  it('refuses a reply with no object at all', () => {
    expect(extractJsonObject('I could not classify this record.')).toBeNull();
  });

  it('refuses a bare array — the answer has to be an object', () => {
    expect(extractJsonObject('["a","b"]')).toBeNull();
  });

  it('refuses something brace-shaped that is not JSON', () => {
    expect(extractJsonObject('{ items: [a, b] }')).toBeNull();
  });
});
