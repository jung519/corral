/**
 * Preload — the thin, audited IPC bridge. The renderer talks HTTP to the control
 * plane for orchestrator data; this bridge is ONLY for native capabilities the
 * browser cannot do: keychain secrets, config file IO, Docker detection, and
 * starting the orchestrator after the setup wizard completes.
 */
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  /** Host OS platform ('darwin' | 'win32' | 'linux'). Lets the wizard pick
   *  platform-appropriate defaults (e.g. host-login mount only works on Linux). */
  platform: process.platform,
  config: {
    exists: (): Promise<boolean> => ipcRenderer.invoke('config:exists'),
    read: (): Promise<string | null> => ipcRenderer.invoke('config:read'),
    write: (yaml: string): Promise<void> => ipcRenderer.invoke('config:write', yaml),
  },
  /** In-progress wizard draft (non-secret fields) persisted to userData. */
  draft: {
    read: (): Promise<string | null> => ipcRenderer.invoke('draft:read'),
    write: (json: string): Promise<void> => ipcRenderer.invoke('draft:write', json),
    clear: (): Promise<void> => ipcRenderer.invoke('draft:clear'),
  },
  secret: {
    set: (service: string, account: string, value: string): Promise<void> =>
      ipcRenderer.invoke('secret:set', service, account, value),
    has: (service: string, account: string): Promise<boolean> =>
      ipcRenderer.invoke('secret:has', service, account),
    delete: (service: string, account: string): Promise<void> =>
      ipcRenderer.invoke('secret:delete', service, account),
  },
  /** Detect a usable Docker CLI (for the workspace-backend wizard step). */
  detectDocker: (): Promise<{ available: boolean; version?: string }> => ipcRenderer.invoke('docker:detect'),
  /** Detect a provider's official agent CLI (claude/gemini/codex) — install check. */
  detectCli: (provider: string): Promise<{ installed: boolean; version?: string }> =>
    ipcRenderer.invoke('cli:detect', provider),
  /** Run `claude setup-token` to obtain a subscription OAuth token at save time
   *  (opens the browser; returns the token or an error/URL tail). */
  claudeSetupToken: (): Promise<{ ok: boolean; token?: string; error?: string }> =>
    ipcRenderer.invoke('claude:setup-token'),
  /** Show an OS notification (human action needed). No-op while the window is focused. */
  notify: (title: string, body: string): Promise<void> => ipcRenderer.invoke('notify', title, body),
  /** Verify a token/key before writing config (wizard "Test" buttons). */
  validate: {
    notion: (token: string): Promise<{ ok: boolean; detail?: string }> => ipcRenderer.invoke('validate:notion', token),
    github: (token: string): Promise<{ ok: boolean; detail?: string }> => ipcRenderer.invoke('validate:github', token),
    agent: (provider: string, key: string): Promise<{ ok: boolean; detail?: string }> =>
      ipcRenderer.invoke('validate:agent', provider, key),
  },
  /** Confirm a repo/tracker is actually reachable with the entered settings. */
  test: {
    repo: (input: {
      kind: 'github' | 'gitlab' | 'bitbucket';
      repo: string;
      token: string;
      host?: string;
      username?: string;
    }): Promise<{ ok: boolean; detail?: string }> => ipcRenderer.invoke('test:repo', input),
    tracker: (input: {
      kind: 'notion' | 'github_issues' | 'jira';
      token: string;
      databaseId?: string;
      repo?: string;
      host?: string;
      email?: string;
      project?: string;
    }): Promise<{ ok: boolean; detail?: string }> => ipcRenderer.invoke('test:tracker', input),
    reference: (repo: string, token: string): Promise<{ ok: boolean; detail?: string }> =>
      ipcRenderer.invoke('test:reference', repo, token),
  },
  /** Read a Notion DB's property schema for the wizard's property/option dropdowns. */
  notion: {
    schema: (
      token: string,
      dbId: string,
    ): Promise<{ ok: boolean; properties?: Array<{ name: string; type: string; options: string[] }>; detail?: string }> =>
      ipcRenderer.invoke('notion:schema', token, dbId),
  },
  /** After setup: respawn the core so it picks up the new config + secrets. */
  startOrchestrator: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('orchestrator:start'),
  /** Control plane over the core IPC channel (no HTTP port). `call` = request/response;
   *  `onEvent` = the live bus-event stream (returns an unsubscribe fn). */
  core: {
    call: (method: string, args?: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('core:call', method, args),
    onEvent: (cb: (event: unknown) => void): (() => void) => {
      const listener = (_e: unknown, event: unknown): void => cb(event);
      ipcRenderer.on('core-event', listener);
      return () => ipcRenderer.off('core-event', listener);
    },
  },
};

export type CorralBridge = typeof api;

contextBridge.exposeInMainWorld('corral', api);
