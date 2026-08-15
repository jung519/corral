/**
 * Service-account authentication with nothing but `node:crypto` — the reason the official
 * client library (and its several dozen transitive packages) is not in this app.
 */
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleTokenSource, parseServiceAccountKey, signAssertion } from './google-auth.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const KEY = { client_email: 'bot@project.iam.gserviceaccount.com', private_key: privateKey };
const SCOPE = 'https://www.googleapis.com/auth/pubsub';

afterEach(() => vi.unstubAllGlobals());

describe('reading the key', () => {
  it('accepts a real one', () => {
    expect(parseServiceAccountKey(JSON.stringify(KEY)).client_email).toBe(KEY.client_email);
  });

  it('says what is wrong with one that is not', () => {
    expect(() => parseServiceAccountKey('nonsense')).toThrow(/not a service-account JSON key/);
    expect(() => parseServiceAccountKey('{"client_email":"a"}')).toThrow(/missing client_email or private_key/);
  });
});

describe('the assertion', () => {
  it('is a JWT Google would accept — signed, scoped, and time-boxed', () => {
    const now = 1_700_000_000_000;

    const jwt = signAssertion(KEY, SCOPE, now);

    const [header, payload, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({
      iss: KEY.client_email,
      scope: SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now / 1000,
      exp: now / 1000 + 3600,
    });

    // The part that matters: it verifies against the key's public half.
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  });
});

describe('getting a token', () => {
  /** Stub the token endpoint and count the exchanges. */
  function stubTokenEndpoint(expiresIn = 3600): { calls: () => number } {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return new Response(JSON.stringify({ access_token: `tok-${calls}`, expires_in: expiresIn }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    return { calls: () => calls };
  }

  it('exchanges the assertion for one', async () => {
    stubTokenEndpoint();

    expect(await new GoogleTokenSource(KEY, SCOPE).token()).toBe('tok-1');
  });

  it('reuses it — pulling runs in a loop and the credential is good for an hour', async () => {
    const endpoint = stubTokenEndpoint();
    const source = new GoogleTokenSource(KEY, SCOPE, () => 1000);

    for (let i = 0; i < 5; i++) await source.token();

    expect(endpoint.calls()).toBe(1);
  });

  it('renews it before it lapses, not after', async () => {
    const endpoint = stubTokenEndpoint(3600);
    let clock = 0;
    const source = new GoogleTokenSource(KEY, SCOPE, () => clock);

    await source.token();
    clock += 3_559_000; // 59 minutes 19 seconds — inside the refresh margin
    await source.token();

    // A token that expires between the check and the call is a failed pull.
    expect(endpoint.calls()).toBe(2);
  });

  it('complains when the exchange returns no token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));

    await expect(new GoogleTokenSource(KEY, SCOPE).token()).rejects.toThrow(/no access token/);
  });
});
