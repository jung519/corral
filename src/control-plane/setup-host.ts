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
import YAML from 'yaml';
import { dirname } from 'node:path';
import { parseConfig } from '../config/loader.js';
import { mergePreserved } from '../config/merge.js';
import type { Config } from '../config/schema.js';
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
   * The same config, parsed, with the schema's defaults filled in.
   *
   * The window asks for this because it has no YAML parser and no schema — the renderer
   * ships with zero runtime dependencies on purpose, so "what does this config actually
   * say" is a question only the core can answer. Before this, the settings screen could
   * only render from the wizard draft, and deleting that file emptied the screen even
   * though the core was configured and running (CRL-76).
   *
   * `undefined` for a config that will not parse. The raw text still goes back beside it,
   * so a screen can show what is there and say it is unreadable — which is more use than
   * an empty panel.
   */
  configParsed(): Config | undefined {
    const raw = this.configRead();
    if (raw === null) return undefined;
    try {
      return parseConfig(raw);
    } catch {
      return undefined;
    }
  }

  /**
   * The document as written, with no schema defaults applied.
   *
   * Needed beside `configParsed` because for some fields **presence is the meaning**. The
   * tracker's optional states default to a core column, so a parsed config always has
   * them — and a screen that read only the parsed form would show "detailed board" as
   * chosen, then write those defaults back as if somebody had chosen them (CRL-77). The
   * parsed form answers "what value applies"; this one answers "was it written down".
   */
  configRaw(): unknown {
    const text = this.configRead();
    if (text === null) return undefined;
    try {
      return YAML.parse(text);
    } catch {
      return undefined;
    }
  }

  /**
   * Persist the config and bring the orchestrator up on it. A reload failure is
   * returned, not thrown: the config IS on disk at that point, and the wizard needs to
   * show the reason (bad token, unreachable tracker) rather than a dead request.
   */
  async configWrite(yaml: string): Promise<{ ok: boolean; error?: string }> {
    mkdirSync(dirname(this.o.configPath), { recursive: true });
    // The wizard renders a whole document from the fields it models, so a block it does
    // not model was erased by every save. Put those back before this lands (CRL-77).
    writeFileSync(this.o.configPath, this.configMerge(yaml), 'utf8');
    return this.o.reload();
  }

  /**
   * Flip `spec_mode` without the caller having to render a config document.
   *
   * The window has no YAML parser — deliberately; the core is the only side that knows what
   * a config contains. Sending a one-key document instead would erase everything outside
   * `PRESERVED_BLOCKS`, so the read-modify-write happens here, where both the parser and
   * the schema live (CRL-104).
   */
  async specModeWrite(mode: 'single' | 'split'): Promise<{ ok: boolean; error?: string }> {
    const text = this.configRead();
    if (text === null) return { ok: false, error: 'No config to update.' };
    let doc: unknown;
    try {
      doc = YAML.parse(text);
    } catch {
      return { ok: false, error: 'The config on disk does not parse; fix it before changing this.' };
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return { ok: false, error: 'The config on disk is not a mapping.' };
    }
    (doc as Record<string, unknown>).spec_mode = mode;
    mkdirSync(dirname(this.o.configPath), { recursive: true });
    writeFileSync(this.o.configPath, YAML.stringify(doc, { lineWidth: 100 }), 'utf8');
    return this.o.reload();
  }

  /**
   * The same merge, without writing.
   *
   * The desktop writes this file itself when the core runs on the same machine — it has
   * to, because a local core is respawned afterwards to pick up freshly stored secrets,
   * and reloading in place before that would fail on credentials it cannot see yet. So it
   * asks for the merged text and writes that, and the knowledge of what a config contains
   * stays here rather than being copied into the app.
   */
  configMerge(yaml: string): string {
    return mergePreserved(yaml, this.configRead());
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
