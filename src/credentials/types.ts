/**
 * Credential storage abstraction (BYOK).
 *
 * NET-NEW boundary. Upstream stored secrets as plaintext in yaml / env vars and
 * mounted a host `~/.claude` OAuth dir. Corral never embeds keys and keeps secrets
 * out of config files — config holds only a CredentialRef pointer; the secret lives
 * in a CredentialStore.
 *
 * Implementations:
 *   - EnvCredentialStore  (./env-store.ts) — reads process.env; headless / CI. Available now.
 *   - KeychainCredentialStore             — OS keychain (Electron safeStorage / keytar). Lands in S3.
 */

export interface CredentialRef {
  /** Logical service, e.g. "anthropic" | "github" | "notion". */
  service: string;
  /** Account / scope within the service, e.g. "default" or a repo owner. */
  account: string;
}

export interface CredentialStore {
  /** Resolve the secret for a ref, or null if absent. */
  get(ref: CredentialRef): Promise<string | null>;
  /** Persist a secret. Read-only stores (env) throw. */
  set(ref: CredentialRef, secret: string): Promise<void>;
  /** Remove a secret. Read-only stores (env) throw. */
  delete(ref: CredentialRef): Promise<void>;
  /** Whether a secret exists, without returning it. */
  has(ref: CredentialRef): Promise<boolean>;
}

/** Stable env var name for a ref, e.g. {service:"github",account:"acme"} → "CORRAL_GITHUB_ACME". */
export function envVarNameFor(ref: CredentialRef): string {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `CORRAL_${norm(ref.service)}_${norm(ref.account)}`;
}
