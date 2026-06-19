/**
 * Environment-variable credential store — the headless / CI fallback.
 *
 * Read-only: secrets come from `process.env` under the CORRAL_<SERVICE>_<ACCOUNT>
 * convention (see envVarNameFor). The OS-keychain store for the desktop app lands
 * in S3; this keeps the core runnable without a GUI.
 */
import { type CredentialRef, type CredentialStore, envVarNameFor } from './types.js';

export class EnvCredentialStore implements CredentialStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async get(ref: CredentialRef): Promise<string | null> {
    const value = this.env[envVarNameFor(ref)];
    return value && value.length > 0 ? value : null;
  }

  async has(ref: CredentialRef): Promise<boolean> {
    return (await this.get(ref)) !== null;
  }

  async set(): Promise<void> {
    throw new Error('EnvCredentialStore is read-only; set CORRAL_* environment variables instead');
  }

  async delete(): Promise<void> {
    throw new Error('EnvCredentialStore is read-only; unset the CORRAL_* environment variable instead');
  }
}
