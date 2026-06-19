/**
 * BYOK credential store for the desktop app — secrets encrypted with Electron's
 * safeStorage (OS keychain-backed) and persisted to userData/credentials.json.
 * Stored by "service:account"; mapped to CORRAL_<SERVICE>_<ACCOUNT> env vars when
 * the orchestrator child is started (matches the core's EnvCredentialStore).
 */
import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function credsPath(): string {
  return join(app.getPath('userData'), 'credentials.json');
}

function key(service: string, account: string): string {
  return `${service}:${account}`;
}

/** ref → CORRAL_<SERVICE>_<ACCOUNT>, matching the core's envVarNameFor. */
export function envVarNameFor(service: string, account: string): string {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `CORRAL_${norm(service)}_${norm(account)}`;
}

function load(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(credsPath(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function save(store: Record<string, string>): void {
  const path = credsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
}

export function setSecret(service: string, account: string, secret: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS secure storage is not available on this system');
  }
  const store = load();
  store[key(service, account)] = safeStorage.encryptString(secret).toString('base64');
  save(store);
}

export function getSecret(service: string, account: string): string | null {
  const enc = load()[key(service, account)];
  if (!enc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return null;
  }
}

export function deleteSecret(service: string, account: string): void {
  const store = load();
  delete store[key(service, account)];
  save(store);
}

export function hasSecret(service: string, account: string): boolean {
  return key(service, account) in load();
}

/** Decrypt all stored secrets into a CORRAL_* env map for the orchestrator child. */
export function secretsAsEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of Object.keys(load())) {
    const [service, account] = k.split(':');
    if (!service || !account) continue;
    const secret = getSecret(service, account);
    if (secret) env[envVarNameFor(service, account)] = secret;
  }
  return env;
}
