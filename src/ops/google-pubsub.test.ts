/**
 * Which way in the client takes, and what it says when there is none.
 *
 * The order is the whole subject. It used to be "emulator, else a key, else refuse", and
 * refusing was wrong on a GCE VM — a core there already has an identity and minting a key
 * for it means a long-lived secret nobody needed. On an organisation that forbids key
 * creation it meant Pub/Sub could not be used at all (CRL-95).
 *
 * Refusing is still right when there is genuinely nothing, and the sentence has to name
 * every way out — that is the part CRL-46 was about.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pubsubClient } from './google-pubsub.js';
import type { CredentialStore } from '../credentials/types.js';

const EMULATOR = process.env.PUBSUB_EMULATOR_HOST;
const CREDENTIAL = { service: 'gcp', account: 'bot' };

/** A store holding whatever the test says, and nothing else. */
function store(secrets: Record<string, string> = {}): CredentialStore {
  return {
    get: async (ref) => secrets[`${ref.service}:${ref.account}`] ?? null,
    set: async () => {},
    delete: async () => {},
    has: async (ref) => `${ref.service}:${ref.account}` in secrets,
  };
}

/** The metadata server, answering or absent. */
function stubMetadata(answers: boolean): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (!href.includes('metadata.google.internal')) throw new Error(`unexpected fetch: ${href}`);
      // Off Google's network the hostname does not resolve; a thrown fetch is what that
      // looks like from here.
      if (!answers) throw new Error('getaddrinfo ENOTFOUND metadata.google.internal');
      return new Response(JSON.stringify({ access_token: 'machine-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

beforeEach(() => delete process.env.PUBSUB_EMULATOR_HOST);
afterEach(() => {
  vi.unstubAllGlobals();
  if (EMULATOR === undefined) delete process.env.PUBSUB_EMULATOR_HOST;
  else process.env.PUBSUB_EMULATOR_HOST = EMULATOR;
});

describe('the way in', () => {
  it('takes the emulator first, and asks for no auth', async () => {
    process.env.PUBSUB_EMULATOR_HOST = '127.0.0.1:8085';
    // No credential, no store, and no metadata server to fall back to.
    stubMetadata(false);

    await expect(pubsubClient(undefined, undefined)).resolves.toBeDefined();
  });

  it('prefers a named credential over the machine, because it was named on purpose', async () => {
    // A desktop reaching a project the machine it sits on has nothing to do with is the
    // case this ordering exists for. The metadata server answering must not win.
    stubMetadata(true);
    const key = JSON.stringify({ client_email: 'bot@p.iam.gserviceaccount.com', private_key: 'k' });

    const client = await pubsubClient(CREDENTIAL, store({ 'gcp:bot': key }));

    expect(client).toBeDefined();
    // Nothing was asked of the metadata server: the key decided it.
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('says which secret is missing when a credential is named but not stored', async () => {
    stubMetadata(true);

    await expect(pubsubClient(CREDENTIAL, store())).rejects.toThrow(/no secret stored for gcp:bot/);
  });

  it('uses the machine when nothing was named and the machine is somebody', async () => {
    stubMetadata(true);

    await expect(pubsubClient(undefined, undefined)).resolves.toBeDefined();
  });

  it('refuses when there is nothing, and names every way out', async () => {
    stubMetadata(false);

    // The sentence is what an operator reads on a `blocked` trigger, so all three have to
    // be in it — a reader who has none of them should not have to guess which they need.
    await expect(pubsubClient(undefined, undefined)).rejects.toThrow(/service-account JSON key/);
    await expect(pubsubClient(undefined, undefined)).rejects.toThrow(/GCE VM/);
  });
});
