import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControlPlaneAuth } from './auth.js';

describe('ControlPlaneAuth', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'corral-auth-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts with no tokens and no pairing open', () => {
    const auth = new ControlPlaneAuth(dir);
    expect(auth.hasTokens()).toBe(false);
    expect(auth.pairingOpen()).toBe(false);
  });

  it('issues a 6-digit code and exchanges it for a token', () => {
    const auth = new ControlPlaneAuth(dir);
    const code = auth.issueCode();
    expect(code).toMatch(/^\d{6}$/);

    const token = auth.redeemCode(code, 'macbook');
    expect(token).toBeTruthy();
    expect(auth.verifyToken(token!)).toBe(true);
    expect(auth.listLabels()).toEqual(['macbook']);
  });

  it('rejects a wrong code and burns it after too many attempts', () => {
    const auth = new ControlPlaneAuth(dir);
    const code = auth.issueCode();

    for (let i = 0; i < 5; i++) expect(auth.redeemCode('000000', 'x')).toBeNull();

    // Burned: even the CORRECT code no longer works — brute force gets one shot at a code.
    expect(auth.redeemCode(code, 'x')).toBeNull();
    expect(auth.pairingOpen()).toBe(false);
    expect(auth.hasTokens()).toBe(false);
  });

  it('makes a code single-use', () => {
    const auth = new ControlPlaneAuth(dir);
    const code = auth.issueCode();
    expect(auth.redeemCode(code, 'first')).toBeTruthy();
    expect(auth.redeemCode(code, 'second')).toBeNull(); // already spent
    expect(auth.listLabels()).toEqual(['first']);
  });

  it('rejects pairing when no code was issued', () => {
    expect(new ControlPlaneAuth(dir).redeemCode('123456', 'x')).toBeNull();
  });

  it('rejects unknown or empty tokens', () => {
    const auth = new ControlPlaneAuth(dir);
    auth.redeemCode(auth.issueCode(), 'a');
    expect(auth.verifyToken('not-a-real-token')).toBe(false);
    expect(auth.verifyToken('')).toBe(false);
  });

  it('keeps tokens across restarts (new instance, same state dir)', () => {
    const first = new ControlPlaneAuth(dir);
    const token = first.redeemCode(first.issueCode(), 'macbook')!;

    const afterRestart = new ControlPlaneAuth(dir); // simulates a core restart
    expect(afterRestart.verifyToken(token)).toBe(true);
  });

  it('revokes by label and revokes all', () => {
    const auth = new ControlPlaneAuth(dir);
    const a = auth.redeemCode(auth.issueCode(), 'laptop')!;
    const b = auth.redeemCode(auth.issueCode(), 'phone')!;

    expect(auth.revoke('laptop')).toBe(1);
    expect(auth.verifyToken(a)).toBe(false); // revoked client is refused
    expect(auth.verifyToken(b)).toBe(true); // the other one still works

    expect(auth.revoke('all')).toBe(1);
    expect(auth.verifyToken(b)).toBe(false);
  });

  it('never stores the plaintext token, and writes the file 0600', () => {
    const auth = new ControlPlaneAuth(dir);
    const token = auth.redeemCode(auth.issueCode(), 'macbook')!;

    const file = join(dir, 'control-plane-tokens.json');
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(token); // hash at rest — a leaked file is not usable
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('issuing a new code invalidates the previous one', () => {
    const auth = new ControlPlaneAuth(dir);
    const old = auth.issueCode();
    auth.issueCode();
    expect(auth.redeemCode(old, 'x')).toBeNull();
  });
});
