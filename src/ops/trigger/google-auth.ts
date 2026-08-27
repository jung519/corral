/**
 * A Google access token, two ways, with `node:crypto` and nothing else.
 *
 * The official client library would do this too, along with gRPC, protobufs and several
 * dozen transitive packages — all of which would ship inside the desktop app. What is
 * actually needed is one signed JWT exchanged for a bearer token, which is about thirty
 * lines against a built-in module.
 *
 * **From a service-account key.** The key is a secret and lives in the credential store
 * like every other one; the pipeline definition only names it.
 *
 * **From the machine, when it has an identity of its own.** A core on a GCE VM (or Cloud
 * Run) already is somebody: the metadata server hands out a token for the attached service
 * account over plain HTTP, no secret involved. Requiring a key there meant minting a
 * long-lived credential that did not need to exist — and on an organisation that forbids
 * key creation (`constraints/iam.disableServiceAccountKeyCreation`, a sensible policy) it
 * meant Pub/Sub could not be used at all (CRL-95).
 */
import { createSign } from 'node:crypto';
import { fetchJson } from '../../core/fetch-retry.js';

/** The fields of a service-account JSON key that matter here. */
export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
/** Refresh early — a token that expires between the check and the call is a failed pull. */
const EXPIRY_MARGIN_MS = 60_000;

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let parsed: Partial<ServiceAccountKey>;
  try {
    parsed = JSON.parse(raw) as Partial<ServiceAccountKey>;
  } catch {
    throw new Error('the credential is not a service-account JSON key');
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('the service-account key is missing client_email or private_key');
  }
  return parsed as ServiceAccountKey;
}

/** Sign the assertion Google exchanges for an access token. */
export function signAssertion(key: ServiceAccountKey, scope: string, now: number): string {
  const issuedAt = Math.floor(now / 1000);
  const claims = {
    iss: key.client_email,
    scope,
    aud: key.token_uri ?? DEFAULT_TOKEN_URI,
    iat: issuedAt,
    exp: issuedAt + 3600,
  };
  const signingInput = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  return `${signingInput}.${signer.sign(key.private_key).toString('base64url')}`;
}

/** Anything that can produce a bearer token. Both sources below satisfy it, so the
 *  clients that use one never learn which. */
export interface TokenSource {
  token(): Promise<string>;
}

/**
 * The address the machine's own identity answers at.
 *
 * Only resolves inside Google's network. Off it the hostname does not exist, which is how
 * "there is no identity here" is told apart from "the identity was refused" — the first is
 * a DNS failure in milliseconds, the second an HTTP status.
 */
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/** Required by the metadata server; its absence is what stops a stray web page from
 *  reading the token out of a browser on the instance. */
const METADATA_HEADER = { 'metadata-flavor': 'Google' } as const;

/**
 * A token for the service account attached to this machine.
 *
 * No scope argument: the scopes are fixed when the instance is created, so asking for one
 * here would be a request nobody reads. An instance without the scope the caller needs
 * gets a token that the API then refuses — which is the honest place for that to surface.
 */
export class MetadataTokenSource implements TokenSource {
  private cached?: { token: string; expiresAt: number };

  constructor(private readonly now: () => number = () => Date.now()) {}

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - EXPIRY_MARGIN_MS > this.now()) return this.cached.token;

    const res = await fetchJson<{ access_token?: string; expires_in?: number }>(
      METADATA_TOKEN_URL,
      { headers: METADATA_HEADER },
      // One try. This either answers immediately or is not there at all; retrying a name
      // that does not resolve just delays saying so.
      { label: 'gce-metadata', maxRetries: 0 },
    );
    if (!res.access_token) throw new Error('the metadata server returned no access token');

    this.cached = { token: res.access_token, expiresAt: this.now() + (res.expires_in ?? 3600) * 1000 };
    return this.cached.token;
  }
}

/**
 * A metadata source, if this machine has an identity — otherwise nothing.
 *
 * Asks for a token rather than probing for the hostname: a machine where the endpoint
 * exists but hands out nothing is not one that can be used, and finding that out here is
 * cheaper than finding it out on the first pull.
 */
export async function machineTokenSource(now?: () => number): Promise<TokenSource | null> {
  const source = new MetadataTokenSource(now);
  try {
    await source.token();
    return source;
  } catch {
    return null;
  }
}

/**
 * Caches one access token per key+scope and renews it before it lapses.
 *
 * Pulling runs in a loop; fetching a token per pull would be a second network round trip
 * for every one that matters, on a credential that is good for an hour.
 */
export class GoogleTokenSource implements TokenSource {
  private cached?: { token: string; expiresAt: number };

  constructor(
    private readonly key: ServiceAccountKey,
    private readonly scope: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - EXPIRY_MARGIN_MS > this.now()) return this.cached.token;

    const body = new URLSearchParams({
      grant_type: GRANT_TYPE,
      assertion: signAssertion(this.key, this.scope, this.now()),
    });
    const res = await fetchJson<{ access_token?: string; expires_in?: number }>(
      this.key.token_uri ?? DEFAULT_TOKEN_URI,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() },
      { label: 'google-auth', maxRetries: 1 },
    );
    if (!res.access_token) throw new Error('Google returned no access token');

    this.cached = { token: res.access_token, expiresAt: this.now() + (res.expires_in ?? 3600) * 1000 };
    return this.cached.token;
  }
}
