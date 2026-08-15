/**
 * The core's own setup surface — config file, wizard draft, and the credential store,
 * behind one small interface so the method table (dispatch.ts) never touches bootstrap
 * wiring or the filesystem directly.
 *
 * Why the core owns this at all: when it runs on another machine, "write the config"
 * has to mean *its* config. The desktop can't reach that disk, and there is no parent
 * process out there to respawn it after a write — so `writeConfig` also has to bring
 * the orchestrator up in place. That reload is injected (`reload`) rather than done
 * here, because only the entrypoint knows how the app was bootstrapped.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CredentialStore } from '../credentials/types.js';

/** Rebuild the orchestrator from the config now on disk. Resolves with what happened. */
export type ReloadFn = () => Promise<{ ok: boolean; error?: string }>;

export interface SetupHostOptions {
  /** Absolute path of this core's corral.yaml. */
  configPath: string;
  /** Absolute path of the wizard draft (non-secret in-progress fields). */
  draftPath: string;
  /** Where secrets are written and existence-checked. Values are never read out. */
  credentials: CredentialStore;
  reload: ReloadFn;
}

export class SetupHost {
  constructor(private readonly o: SetupHostOptions) {}

  get credentials(): CredentialStore {
    return this.o.credentials;
  }

  configExists(): boolean {
    return existsSync(this.o.configPath);
  }

  configRead(): string | null {
    try {
      return readFileSync(this.o.configPath, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Persist the config and bring the orchestrator up on it. A reload failure is
   * returned, not thrown: the config IS on disk at that point, and the wizard needs to
   * show the reason (bad token, unreachable tracker) rather than a dead request.
   */
  async configWrite(yaml: string): Promise<{ ok: boolean; error?: string }> {
    mkdirSync(dirname(this.o.configPath), { recursive: true });
    writeFileSync(this.o.configPath, yaml, 'utf8');
    return this.o.reload();
  }

  draftRead(): string | null {
    try {
      return existsSync(this.o.draftPath) ? readFileSync(this.o.draftPath, 'utf8') : null;
    } catch {
      return null;
    }
  }

  draftWrite(json: string): void {
    mkdirSync(dirname(this.o.draftPath), { recursive: true });
    writeFileSync(this.o.draftPath, json, 'utf8');
  }

  draftClear(): void {
    try {
      rmSync(this.o.draftPath, { force: true });
    } catch {
      /* already gone */
    }
  }
}
