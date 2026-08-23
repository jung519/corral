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
 * 3. **Ink positions each word with a cursor move.** `Paste\x1b[8Gcode\x1b[13Ghere` — so
 *    stripping escapes glues words together. Every matcher here is written against the
 *    glued form, which is why they look like `Pastecodehere`.
 *
 * Nothing in this file spawns anything; it is the part that can be tested without a
 * subscription, and the part most likely to need adjusting when the CLI's screen changes.
 */

/** Escape sequences Ink emits: OSC (hyperlinks, title), CSI (colour, cursor), a few singles. */
const OSC = /\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const SINGLE = /\x1b[>=78]/g;

/** Terminal output as text: escapes removed, carriage returns dropped. */
export function stripAnsi(raw: string): string {
  return raw.replace(OSC, '').replace(CSI, '').replace(SINGLE, '').replace(/\r/g, '');
}

/** The same, with whitespace removed — what a phrase looks like after Ink's cursor moves
 *  are stripped out from between its words. Matchers use this form. */
function glued(raw: string): string {
  return stripAnsi(raw).replace(/\s+/g, '');
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
  const plain = /(https:\/\/claude\.com\/[^\s]*(?:\n[^\s]*)*)/.exec(stripAnsi(raw));
  return plain?.[1] ? plain[1].replace(/\n/g, '') : null;
}

/** The CLI is waiting for the code from the sign-in page. */
export function awaitingCode(raw: string): boolean {
  return /Pastecodehere/i.test(glued(raw));
}

/** The code was rejected — recoverable, the CLI offers a retry. */
export function invalidCode(raw: string): boolean {
  return /OAutherror:Invalidcode/i.test(glued(raw));
}

/**
 * The issued token, or null.
 *
 * Matched on the stripped text rather than the raw stream: a token long enough to wrap
 * gets a cursor move inserted mid-string, and the raw form would then yield only its
 * first fragment. Stripping puts the pieces back together.
 */
export function findToken(raw: string): string | null {
  return /sk-ant-oat[A-Za-z0-9_-]+/.exec(stripAnsi(raw))?.[0] ?? null;
}

/**
 * What went wrong, in the user's language, from whatever the screen holds.
 *
 * Used for the message that sends someone to the manual route; the raw tail is not shown
 * because it is mostly escape sequences and spinner frames.
 */
export function failureReason(raw: string): 'no-output' | 'invalid-code' | 'unknown' {
  if (stripAnsi(raw).trim().length === 0) return 'no-output';
  if (invalidCode(raw)) return 'invalid-code';
  return 'unknown';
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
set timeout 600
spawn -noecho claude setup-token

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
