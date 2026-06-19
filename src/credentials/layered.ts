/**
 * Layered credential store — reads from several stores in order (first hit wins),
 * writes to one designated store. Headless default: read env first (CI/ops
 * override), then the on-disk file store; write to the file store (so the setup
 * wizard can persist without any external program or keychain).
 */
import type { CredentialRef, CredentialStore } from './types.js';

export class LayeredCredentialStore implements CredentialStore {
  constructor(
    private readonly readers: CredentialStore[],
    private readonly writer: CredentialStore,
  ) {}

  async get(ref: CredentialRef): Promise<string | null> {
    for (const r of this.readers) {
      const v = await r.get(ref);
      if (v) return v;
    }
    return null;
  }

  async has(ref: CredentialRef): Promise<boolean> {
    return (await this.get(ref)) !== null;
  }

  set(ref: CredentialRef, secret: string): Promise<void> {
    return this.writer.set(ref, secret);
  }

  delete(ref: CredentialRef): Promise<void> {
    return this.writer.delete(ref);
  }
}
