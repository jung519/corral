/**
 * File-backed credential store — the writable BYOK store for headless/self-hosted
 * use (the desktop app uses the OS keychain instead). Lets the user configure
 * secrets from within the app (setup wizard → /api/setup) with no external program
 * or pre-set environment. Stored as JSON, mode 0600.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CredentialRef, CredentialStore } from './types.js';

export class FileCredentialStore implements CredentialStore {
  constructor(private readonly file: string) {}

  private key(ref: CredentialRef): string {
    return `${ref.service}:${ref.account}`;
  }

  private load(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private save(store: Record<string, string>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(store, null, 2), { mode: 0o600 });
  }

  async get(ref: CredentialRef): Promise<string | null> {
    return this.load()[this.key(ref)] ?? null;
  }

  async set(ref: CredentialRef, secret: string): Promise<void> {
    const store = this.load();
    store[this.key(ref)] = secret;
    this.save(store);
  }

  async delete(ref: CredentialRef): Promise<void> {
    const store = this.load();
    delete store[this.key(ref)];
    this.save(store);
  }

  async has(ref: CredentialRef): Promise<boolean> {
    return this.key(ref) in this.load();
  }
}
