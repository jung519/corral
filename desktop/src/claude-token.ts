/**
 * Reading `claude setup-token`'s screen.
 *
 * The CLI is an Ink TUI, and that is the whole difficulty. Three things follow from it,
 * all measured against the real binary (2.1.234) rather than assumed:
 *
 * 1. **With no TTY it prints nothing at all** — one newline, no URL, no token. The old
 *    implementation spawned it with piped stdio and waited for a token that could never
 *    arrive, so the button spun until a five-minute timeout (CRL-83).
 * 2. **The sign-in is not a localhost callback.** It redirects to
 *    `platform.claude.com/oauth/code/callback`, which shows a code; the CLI then waits at
 *    `Paste code here if prompted >` for that code on stdin.
 * 3. **Ink positions each word with a cursor move and redraws partially.**
 *    `OAuth error: Requ\x1b[20Gst\x1b[23Gfailed with` — the missing letters are already on
 *    the screen from an earlier frame. Reproducing that prose would take a real terminal
 *    emulator with a scrolling viewport, and getting it subtly wrong would put mangled
 *    text in front of the user. So this file reads only what Ink writes **in one piece**:
 *    `OAuth error:`, `Invalid`, `status code 400`, the token. Everything the user sees is
 *    corral's own words, chosen from those signals.
 *
 * Nothing in this file spawns anything; it is the part that can be tested without a
 * subscription, and the part most likely to need adjusting when the CLI's screen changes.
 */

/**
 * The screen as text.
 *
 * Ink does not write lines; it positions. `Paste\x1b[8Gcode\x1b[13Ghere` is three words
 * placed at three columns, so simply deleting the escapes glues them into
 * "Pastecodehere" — which is why an earlier version of this file matched on glued strings
 * and why a refusal reached the screen as "Requstfailed withstatus code 400".
 *
 * Replaying the column moves as padding costs a few lines and gives back real text, which
 * every matcher below can then read the way a person would — and which is fit to show the
 * user verbatim.
 */
export function renderText(raw: string): string {
  const lines: string[] = [];
  let line = '';
  let i = 0;
  while (i < raw.length) {
    // OSC (hyperlinks, window title): ends at BEL or ST, carries no visible text.
    if (raw.startsWith('\x1b]', i)) {
      const bel = raw.indexOf('\x07', i);
      const st = raw.indexOf('\x1b\\', i);
      const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
      i = end < 0 ? raw.length : end + (end === st ? 2 : 1);
      continue;
    }
    if (raw.startsWith('\x1b[', i)) {
      const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(raw.slice(i));
      if (m) {
        // `G` is "go to column n". Padding to it keeps words apart — enough to match a
        // phrase, though not enough to rebuild a line Ink drew across several frames.
        if (m[2] === 'G') {
          const col = Math.max(1, Number.parseInt(m[1] || '1', 10));
          while (line.length < col - 1) line += ' ';
        }
        i += m[0].length;
        continue;
      }
    }
    const ch = raw[i] ?? '';
    if (ch === '\n') {
      lines.push(line);
      line = '';
      i += 1;
      continue;
    }
    // A bare CR precedes Ink's newlines and its redraws; dropping it keeps the text we
    // already have rather than blanking a line that was written.
    if (ch === '\r') {
      i += 1;
      continue;
    }
    // Charset designation: ESC ( B and friends are three bytes. Skipping two left the
    // final letter behind as text, which pushed every column after it out by one and
    // glued the next word on (`Invalidcode`).
    if (ch === '\x1b') {
      i += '()*+'.includes(raw[i + 1] ?? '') ? 3 : 2;
      continue;
    }
    // Other C0 controls (SI/SO and friends) are not text either.
    if (ch < ' ') {
      i += 1;
      continue;
    }
    line += ch;
    i += 1;
  }
  lines.push(line);
  return lines.join('\n');
}

/** One line, whitespace squeezed — for matching a phrase without caring how Ink spaced it. */
function flat(raw: string): string {
  return renderText(raw).replace(/\s+/g, ' ');
}

/**
 * The sign-in URL, or null while it has not been printed yet.
 *
 * Taken from the OSC 8 hyperlink, which carries the URL in one piece — the visible copy
 * below it is wrapped across lines by the terminal and would come back in fragments.
 */
export function findAuthUrl(raw: string): string | null {
  const link = /\x1b\]8;[^;]*;(https:\/\/[^\x1b\x07]+)/.exec(raw);
  if (link?.[1]) return link[1];
  // No hyperlink support in this terminal: fall back to the wrapped visible copy, undoing
  // the wrap. A URL has no spaces, so joining the lines back up is safe.
  const plain = /(https:\/\/claude\.com\/[^\s]*(?:\n[^\s]*)*)/.exec(renderText(raw));
  return plain?.[1] ? plain[1].replace(/\n/g, '') : null;
}

/** The CLI is waiting for the code from the sign-in page. */
export function awaitingCode(raw: string): boolean {
  return /Paste code here/i.test(flat(raw));
}

/**
 * The CLI refused, and as much of why as can be read reliably.
 *
 * Structured rather than quoted. The message is drawn across frames — "Requ" here, "st"
 * three columns along, the missing letter already on screen — so passing it through gave
 * the user "Requstfailed withstatus code 400". What *is* written in one piece is the
 * `OAuth error:` prefix, the word `Invalid`, and `status code NNN`, and those separate the
 * two cases that call for different advice:
 *
 *   - `invalid-code` — the CLI rejected it locally: half a code, or no `#`.
 *   - `refused` — it reached the server and came back with a status. Usually an expired
 *     code, or one already spent.
 */
export interface OAuthRefusal {
  kind: 'invalid-code' | 'refused';
  /** HTTP status, when the CLI named one. */
  status?: number;
}

export function oauthError(raw: string): OAuthRefusal | null {
  const text = renderText(raw);
  if (!/OAuth error:/i.test(text)) return null;
  if (/\bInvalid\b/i.test(text)) return { kind: 'invalid-code' };
  const status = /status code (\d{3})/i.exec(text)?.[1];
  return status ? { kind: 'refused', status: Number(status) } : { kind: 'refused' };
}

/**
 * The issued token, or null.
 *
 * Matched on the stripped text rather than the raw stream: a token long enough to wrap
 * gets a cursor move inserted mid-string, and the raw form would then yield only its
 * first fragment. Stripping puts the pieces back together.
 */
export function findToken(raw: string): string | null {
  // Per line, not across the whole screen: the character class runs on letters, so a
  // global match would swallow whatever word came next once the newline was removed. Ink
  // draws the token as a lone string on its own line, and the pty is wide enough (see
  // EXPECT_SCRIPT) that it does not wrap.
  for (const line of renderText(raw).split('\n')) {
    const m = /sk-ant-oat[A-Za-z0-9_-]+/.exec(line);
    if (m) return m[0];
  }
  return null;
}

/**
 * What went wrong, in the user's language, from whatever the screen holds.
 *
 * Used for the message that sends someone to the manual route; the raw tail is not shown
 * because it is mostly escape sequences and spinner frames.
 */
export function failureReason(raw: string): 'no-output' | 'invalid-code' | 'unknown' {
  if (renderText(raw).trim().length === 0) return 'no-output';
  if (oauthError(raw)) return 'invalid-code';
  return 'unknown';
}

/**
 * The code from the sign-in page, split the way the CLI splits it.
 *
 * Source-verified against the CLI: it does `let [code, state] = pasted.split("#")` and
 * refuses anything where either half is empty ("Invalid code. Please make sure the full
 * code was copied"). So a value without a `#` is not worth a round trip through a pty and
 * a network call — it can be refused here, the moment it is typed.
 */
export function splitAuthCode(raw: string): { ok: true; code: string } | { ok: false } {
  const value = raw.trim();
  const [code, state] = value.split('#');
  if (!code || !state) return { ok: false };
  return { ok: true, code: value };
}

/**
 * Why the spawn failed, from the error code.
 *
 * `ENOENT` means no `expect` on this machine — the common, expected case on Linux and
 * Windows, and not a fault. It reads differently to the user than a spawn that failed for
 * some other reason, so the two are named separately.
 */
export function spawnFailureReason(code: string | undefined): 'no-pty' | 'spawn-failed' {
  return code === 'ENOENT' ? 'no-pty' : 'spawn-failed';
}

/**
 * The expect script that lends the CLI a pty.
 *
 * `expect` rather than a native pty module: it is part of the base system on macOS, and
 * one button does not justify a native dependency with per-platform prebuilds. Where it
 * is missing — most Linux desktops, every Windows — the caller falls back to asking the
 * user to run the command themselves, which is the only route that works everywhere
 * anyway.
 *
 * The code arrives on *this* process's stdin (a pipe from the app) and is forwarded into
 * the pty with `expect_user`. BSD `script(1)` cannot do that: it calls `tcgetattr` on its
 * own stdin and dies with "Operation not supported on socket" when handed a pipe.
 */
export const EXPECT_SCRIPT = `
log_user 1
# Half an hour: a human signing in through a browser is slow, and cutting the session
# short is what made a completed login arrive at a dead process. Not unbounded — a crash
# that skipped cleanup should not leave this running forever.
set timeout 1800
spawn -noecho claude setup-token
# A wide, tall pty. Ink wraps to the terminal width, and a wrapped token would reach the
# app in pieces; at 400 columns nothing it prints wraps.
stty rows 60 columns 400 < $spawn_out(slave,name)

# Drain the CLI's screen until it asks for the code. Everything it draws — the sign-in URL
# included — reaches stdout here, where the app reads it. Single words only in these
# patterns: Ink puts a cursor move between words, so "Paste code" never appears as such.
expect {
  -re {Paste} { }
  timeout { exit 3 }
  eof { exit 4 }
}

# The app writes the code (one line) on this process's stdin.
expect_user -re "(.*)\\n"
send -- "$expect_out(1,string)\\r"

# Drain again so the token — or the rejection — reaches the app.
expect {
  -re {sk-ant-oat} { expect eof; exit 0 }
  -re {Invalid} { exit 5 }
  timeout { exit 6 }
  eof { exit 0 }
}
`;
