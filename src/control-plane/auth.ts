/**
 * Control-plane authentication — pairing codes and long-lived tokens.
 *
 * The remote transport (`ws.ts`) is reachable by anything that can open a socket, so it
 * must prove who is calling. Flow:
 *
 *   1. PAIR   client sends a short code shown in the core's log → gets a long token
 *   2. AUTH   every later connection sends that token
 *
 * ## Why a code first
 * A long token is unpleasant to move by hand. A 6-digit code is easy to read off a log
 * and type once; the token is exchanged and stored by the client after that.
 *
 * ## Why tokens are hashed at rest
 * The token file is a credential store: if it leaks, the tokens in it must not be usable.
 * We only ever need to *verify* a presented token, so a hash is enough — unlike provider
 * API keys, which must be replayed verbatim and therefore can't be hashed.
 *
 * Codes live in memory only: a restart invalidates them, which is the safer default.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULT_STATE_DIR } from '../core/issue-state.js';

/** How long a pairing code stays valid. Long enough to read a log and type it. */
const CODE_TTL_MS = 5 * 60_000;
/** Wrong-code attempts before the code is burned. Blocks brute force on 10^6 space. */
const MAX_CODE_ATTEMPTS = 5;

export interface StoredToken {
  /** SHA-256 of the token — the plaintext is never persisted. */
  hash: string;
  /** Human label so the operator can tell devices apart when revoking. */
  label: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface TokenFile {
  tokens: StoredToken[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time compare of two hex digests (equal length by construction). */
function hashEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Issues and verifies control-plane credentials. Tokens persist to disk (0600); the
 * pairing code lives in memory.
 */
export class ControlPlaneAuth {
  private readonly file: string;
  private code: { value: string; expiresAt: number; attempts: number } | null = null;

  constructor(stateDir: string = DEFAULT_STATE_DIR) {
    this.file = resolve(stateDir, 'control-plane-tokens.json');
  }

  private load(): TokenFile {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<TokenFile>;
      return { tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [] };
    } catch {
      return { tokens: [] };
    }
  }

  private save(data: TokenFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    // 0600: this file grants control-plane access to whoever can read it.
    writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  /** True when at least one client has paired — used to decide whether to show a code. */
  hasTokens(): boolean {
    return this.load().tokens.length > 0;
  }

  /** Labels of paired clients (for `--revoke` and status output). No secrets. */
  listLabels(): string[] {
    return this.load().tokens.map((t) => t.label);
  }

  /**
   * Start (or restart) pairing and return the code to display. Replaces any code already
   * outstanding, so a fresh call always wins and the previous code stops working.
   */
  issueCode(): string {
    // randomInt is uniform and cryptographically strong (Math.random is neither).
    const value = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.code = { value, expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 };
    return value;
  }

  /** Whether a pairing code is currently outstanding (and not expired). */
  pairingOpen(): boolean {
    if (!this.code) return false;
    if (Date.now() > this.code.expiresAt) {
      this.code = null;
      return false;
    }
    return true;
  }

  /**
   * Exchange a pairing code for a token. The code is single-use: it is cleared on success,
   * and burned after too many wrong attempts so a wrong guesser can't keep trying.
   *
   * @returns the plaintext token (shown to the client once), or null when rejected.
   */
  redeemCode(submitted: string, label: string): string | null {
    if (!this.pairingOpen() || !this.code) return null;

    if (!hashEquals(sha256(submitted), sha256(this.code.value))) {
      this.code.attempts += 1;
      if (this.code.attempts >= MAX_CODE_ATTEMPTS) this.code = null; // burned
      return null;
    }

    this.code = null; // single use
    const token = randomBytes(32).toString('base64url');
    const data = this.load();
    data.tokens.push({ hash: sha256(token), label: label || 'client', createdAt: new Date().toISOString() });
    this.save(data);
    return token;
  }

  /** Verify a presented token. Records last use so stale entries are identifiable. */
  verifyToken(token: string): boolean {
    if (!token) return false;
    const data = this.load();
    const presented = sha256(token);
    const match = data.tokens.find((t) => hashEquals(t.hash, presented));
    if (!match) return false;
    match.lastUsedAt = new Date().toISOString();
    this.save(data);
    return true;
  }

  /** Revoke one label (or every token). Revoked clients fail their next connection. */
  revoke(label: string | 'all'): number {
    const data = this.load();
    const before = data.tokens.length;
    data.tokens = label === 'all' ? [] : data.tokens.filter((t) => t.label !== label);
    this.save(data);
    return before - data.tokens.length;
  }
}
