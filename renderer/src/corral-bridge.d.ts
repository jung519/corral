/** Ambient type for the preload IPC bridge (desktop/src/preload.ts). Present only
 * inside the Electron app — undefined in a plain browser (the wizard degrades). */
export {};

/**
 * How the app reaches a remote core. Mirrors `desktop/src/core-link/tunnel.ts` — the
 * renderer never imports from the desktop package, so the shape is restated at the
 * boundary the same way every other bridge type is.
 */
export interface TunnelConfig {
  /** ssh destination: `user@host`, or a host alias from the user's ssh config. */
  target: string;
  remotePort: number;
  localPort: number;
  identityFile?: string;
  /** Extra hop for a host that is not reachable directly — passed as `-o ProxyCommand=…`. */
  proxyCommand?: string;
}

export interface TunnelStatus {
  state: 'off' | 'starting' | 'up' | 'failed';
  code?: 'ssh-not-found' | 'auth-failed' | 'host-key' | 'forward-failed' | 'exited' | 'timeout';
  detail?: string;
  /** Retrying cannot help — the operator has to act. */
  fatal?: boolean;
}

declare global {
  interface Window {
    corral?: {
      platform: string;
      appVersion(): Promise<string>;
      config: {
        exists(): Promise<boolean>;
        read(): Promise<string | null>;
        /** As the core reads it: `config` with defaults applied, `raw` as written. The
         *  window has no YAML parser; both are needed because for some fields, being
         *  written down at all is the meaning. */
        parsed(): Promise<{ config?: unknown; raw?: unknown }>;
        /** Saving against a remote core also restarts it on the new config, so failures
         *  (bad token, unreachable tracker) come back here instead of passing silently. */
        write(yaml: string): Promise<{ ok: boolean; error?: string }>;
        /** Change planning shape only. The core does the read-modify-write, because this
         *  window has no YAML parser and a one-key document would erase the rest. */
        specMode(mode: 'single' | 'split'): Promise<{ ok: boolean; error?: string }>;
      };
      draft: {
        read(): Promise<string | null>;
        write(json: string): Promise<void>;
        clear(): Promise<void>;
      };
      /** Third-party attribution text, or null when the build did not ship it. */
      thirdPartyLicenses(): Promise<string | null>;
      direction: {
        read(): Promise<string>;
        write(text: string): Promise<void>;
      };
      remote: {
        get(): Promise<{
          mode: 'local' | 'remote';
          url: string;
          label: string;
          paired: boolean;
          /** Saved tunnel settings; null when the address is used as-is. */
          tunnel: TunnelConfig | null;
          state: 'connected' | 'connecting' | 'disconnected';
          denial?: string;
          tunnelStatus: TunnelStatus;
        }>;
        setMode(
          mode: 'local' | 'remote',
          url?: string,
          label?: string,
          tunnel?: TunnelConfig,
        ): Promise<{ ok: boolean }>;
        pair(
          url: string,
          code: string,
          label?: string,
          tunnel?: TunnelConfig,
        ): Promise<{ ok: boolean; error?: string; tunnelStatus?: TunnelStatus }>;
        unpair(): Promise<{ ok: boolean }>;
        onState(cb: (s: { state: string; denial?: string; tunnelStatus?: TunnelStatus }) => void): () => void;
      };
      secret: {
        set(service: string, account: string, value: string): Promise<void>;
        has(service: string, account: string): Promise<boolean>;
        delete(service: string, account: string): Promise<void>;
      };
      detectDocker(): Promise<{ available: boolean; version?: string }>;
      detectCli(provider: string): Promise<{ installed: boolean; version?: string }>;
      clipboard: {
        write(text: string): Promise<{ ok: boolean }>;
        read(): Promise<{ ok: boolean; text: string }>;
      };
      claudeTokenStart(): Promise<{ ok: boolean; url?: string; reason?: string; error?: string }>;
      claudeTokenCode(code: string): Promise<{ ok: boolean; token?: string; reason?: string; error?: string }>;
      claudeTokenAlive(): Promise<{ alive: boolean }>;
      claudeTokenCancel(): Promise<{ ok: boolean }>;
      codexImportAuth(): Promise<{ ok: boolean; b64?: string; error?: string }>;
      notify(title: string, body: string): Promise<void>;
      validate: {
        notion(token: string): Promise<{ ok: boolean; detail?: string }>;
        github(token: string): Promise<{ ok: boolean; detail?: string }>;
        agent(provider: string, key: string): Promise<{ ok: boolean; detail?: string }>;
      };
      notion: {
        schema(
          token: string,
          dbId: string,
        ): Promise<{ ok: boolean; properties?: Array<{ name: string; type: string; options: string[] }>; detail?: string }>;
      };
      test: {
        repo(input: {
          kind: 'github' | 'gitlab' | 'bitbucket';
          repo: string;
          token: string;
          host?: string;
          username?: string;
        }): Promise<{ ok: boolean; detail?: string }>;
        tracker(input: {
          kind: 'notion' | 'github_issues' | 'jira';
          token: string;
          databaseId?: string;
          repo?: string;
          host?: string;
          email?: string;
          project?: string;
        }): Promise<{ ok: boolean; detail?: string }>;
        reference(repo: string, token: string): Promise<{ ok: boolean; detail?: string }>;
      };
      startOrchestrator(): Promise<{ ok: boolean }>;
      core: {
        call(method: string, args?: Record<string, unknown>): Promise<unknown>;
        onEvent(cb: (event: unknown) => void): () => void;
      };
    };
  }
}
