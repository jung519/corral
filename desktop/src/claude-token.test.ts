import { describe, expect, it } from 'vitest';
import { awaitingCode, failureReason, findAuthUrl, findToken, invalidCode, spawnFailureReason, stripAnsi } from './claude-token.js';

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
  '\x1b(B\x1b[mOAuth error: Invalid\x1b[21Gcode. Please make\x1b[38Gsure the full\x1b[52Gcode was copied. Press Enter to retry.\r\n';

const SPINNER = '\r\x1b[1C\x1b[1A✳\r\r\n\r\x1b[1C\x1b[1A✢\r\r\n';

describe('stripAnsi', () => {
  it('drops OSC hyperlinks, CSI moves and carriage returns', () => {
    expect(stripAnsi(SPINNER).trim()).toBe('✳\n✢');
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
  it('sees the prompt through the cursor moves between its words', () => {
    expect(awaitingCode(PROMPT)).toBe(true);
  });

  it('is false while the CLI is still working', () => {
    expect(awaitingCode(SPINNER + URL_LINE)).toBe(false);
  });
});

describe('invalidCode', () => {
  it('recognises a rejected code', () => {
    expect(invalidCode(REJECTED)).toBe(true);
  });

  it('does not fire on the prompt itself', () => {
    expect(invalidCode(PROMPT)).toBe(false);
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
