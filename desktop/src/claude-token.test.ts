import { describe, expect, it } from 'vitest';
import {
  awaitingCode,
  failureReason,
  findAuthUrl,
  findToken,
  oauthError,
  spawnFailureReason,
  splitAuthCode,
  renderText,
} from './claude-token.js';

/**
 * Fixtures are trimmed from a real `claude setup-token` run (CLI 2.1.234) under a pty —
 * escape sequences and all. Hand-written samples would have tested a screen the CLI does
 * not draw, which is exactly the mistake that produced CRL-83.
 */
const URL_LINE =
  "\r\x1b[1C\x1b[1ABrowser didn't open?\x1b[23GUse the url\x1b[35Gbelow\x1b[41Gto\x1b[44Gsign\x1b[49Gin\x1b[52G(c\x1b[55Gto\x1b[58Gcopy)\r\r\n\r\r\n" +
  '\x1b]8;id=lvr5ja;https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code\x07' +
  'https://claude.com/cai/oauth/\r\nauthorize?code=true\x1b]8;;\x07\r\r\n';

const PROMPT = '\x1b[2GPaste\x1b[8Gcode\x1b[13Ghere\x1b[18Gif\x1b[21Gprompted\x1b[30G>\r\r\n';

const REJECTED =
  '\r\x1b[1C\x1b[4AOAuth error: Invalid\x1b[23Gcode. Please make\x1b[41Gsure the full\x1b[55Gc\x1b[57Gde was\x1b[64Gcopied\r\n';

/** A well-formed code the exchange refused — the real bytes, partial redraw and all. */
const EXCHANGE_FAILED =
  '\r\x1b[1C\x1b[4AOAuth error: Requ\x1b[20Gst\x1b[23Gfailed with\x1b[35Gstatus code 400\x1b[K\r\n';

const SPINNER = '\r\x1b[1C\x1b[1A✳\r\r\n\r\x1b[1C\x1b[1A✢\r\r\n';

describe('renderText', () => {
  it('drops OSC hyperlinks, colour codes and carriage returns', () => {
    expect(renderText(SPINNER).trim()).toBe('✳\n✢');
  });

  // The whole reason this exists: Ink places each word at a column instead of writing
  // spaces, so deleting the escapes would give "Pastecodehere".
  it('replays column moves as padding, so words stay words', () => {
    // Real bytes: `\x1b[2GPaste\x1b[8Gcode…`. Deleting the escapes would give
    // "Pastecodehere"; padding to the columns keeps it a sentence.
    expect(renderText(PROMPT).trim()).toBe('Paste code here if prompted >');
  });
});

describe('findAuthUrl', () => {
  it('takes the URL from the OSC 8 hyperlink, in one piece', () => {
    expect(findAuthUrl(URL_LINE)).toBe(
      'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code',
    );
  });

  it('un-wraps the visible copy when the terminal has no hyperlink support', () => {
    const noLink = 'Use the url below\r\n\r\nhttps://claude.com/cai/oauth/\r\nauthorize?code=true\r\n';
    expect(findAuthUrl(noLink)).toBe('https://claude.com/cai/oauth/authorize?code=true');
  });

  it('is null before the URL is drawn', () => {
    expect(findAuthUrl(SPINNER)).toBeNull();
  });
});

describe('awaitingCode', () => {
  // The point of the glued form: Ink writes `Paste\x1b[8Gcode`, so the phrase never
  // appears with its spaces and a plain /Paste code here/ would never match.
  it('sees the prompt across the columns Ink placed its words at', () => {
    expect(awaitingCode(PROMPT)).toBe(true);
  });

  it('is false while the CLI is still working', () => {
    expect(awaitingCode(SPINNER + URL_LINE)).toBe(false);
  });
});

describe('oauthError', () => {
  // Two refusals with different advice attached, told apart by fragments Ink writes in one
  // piece. Quoting the CLI's own sentence is not possible — it is drawn across frames, and
  // trying gave the user "Requstfailed withstatus code 400" (CRL-84).
  it('names the locally-caught one, which means the code was incomplete', () => {
    expect(oauthError(REJECTED)).toEqual({ kind: 'invalid-code' });
  });

  it('names the server refusal and carries the status', () => {
    expect(oauthError(EXCHANGE_FAILED)).toEqual({ kind: 'refused', status: 400 });
  });

  it('does not fire on the prompt itself', () => {
    expect(oauthError(PROMPT)).toBeNull();
  });
});

describe('findToken', () => {
  it('reads the token', () => {
    expect(findToken(`granted\r\n\x1b[2Gsk-ant-oat01-EXAMPLE_token-123\r\n`)).toBe('sk-ant-oat01-EXAMPLE_token-123');
  });

  it('joins a token the terminal wrapped mid-string', () => {
    // A cursor move lands inside the token when it reaches the right edge; matching the
    // raw stream would return only the first fragment.
    expect(findToken('sk-ant-oat01-AAA\x1b[1GBBB\r\n')).toBe('sk-ant-oat01-AAABBB');
  });

  it('is null while nothing has been issued', () => {
    expect(findToken(PROMPT)).toBeNull();
  });
});

describe('failureReason', () => {
  it('calls an empty screen what it is — no TTY, so the CLI drew nothing', () => {
    expect(failureReason('\n')).toBe('no-output');
  });

  it('separates a rejected code from an unexplained stop', () => {
    expect(failureReason(REJECTED)).toBe('invalid-code');
    expect(failureReason(SPINNER)).toBe('unknown');
  });
});

describe('spawnFailureReason', () => {
  it('a missing expect is "no pty here", not a failure to explain', () => {
    expect(spawnFailureReason('ENOENT')).toBe('no-pty');
  });

  it('anything else is a spawn failure', () => {
    expect(spawnFailureReason('EACCES')).toBe('spawn-failed');
    expect(spawnFailureReason(undefined)).toBe('spawn-failed');
  });
});

describe('splitAuthCode', () => {
  // The CLI's own rule, verified in its bundle: `pasted.split("#")` with both halves
  // required. Checking it here is what keeps a half-copied code from costing a round trip.
  it('accepts a code with both halves', () => {
    expect(splitAuthCode('abc123#state456')).toEqual({ ok: true, code: 'abc123#state456' });
  });

  it('trims what a copy usually carries', () => {
    expect(splitAuthCode('  abc#def\n')).toEqual({ ok: true, code: 'abc#def' });
  });

  it.each(['abc123', '', '   ', '#state', 'code#'])('refuses %o', (bad) => {
    expect(splitAuthCode(bad)).toEqual({ ok: false });
  });
});
