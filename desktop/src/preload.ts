/**
 * Preload — the thin, audited IPC bridge. The renderer talks HTTP to the control
 * plane for orchestrator data; this bridge is ONLY for native capabilities the
 * browser cannot do: keychain secrets, config file IO, Docker detection, and
 * starting the orchestrator after the setup wizard completes.
 */
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  config: {
    exists: (): Promise<boolean> => ipcRenderer.invoke('config:exists'),
    read: (): Promise<string | null> => ipcRenderer.invoke('config:read'),
    write: (yaml: string): Promise<void> => ipcRenderer.invoke('config:write', yaml),
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
  /** Verify a token/key before writing config (wizard "Test" buttons). */
  validate: {
    notion: (token: string): Promise<{ ok: boolean; detail?: string }> => ipcRenderer.invoke('validate:notion', token),
    github: (token: string): Promise<{ ok: boolean; detail?: string }> => ipcRenderer.invoke('validate:github', token),
    agent: (provider: string, key: string): Promise<{ ok: boolean; detail?: string }> =>
      ipcRenderer.invoke('validate:agent', provider, key),
  },
  /** Read a Notion DB's property schema for the wizard's property/option dropdowns. */
  notion: {
    schema: (
      token: string,
      dbId: string,
    ): Promise<{ ok: boolean; properties?: Array<{ name: string; type: string; options: string[] }>; detail?: string }> =>
      ipcRenderer.invoke('notion:schema', token, dbId),
  },
  /** Start the orchestrator child + reload into the dashboard. */
  startOrchestrator: (): Promise<{ ok: boolean; port: number }> => ipcRenderer.invoke('orchestrator:start'),
};

export type CorralBridge = typeof api;

contextBridge.exposeInMainWorld('corral', api);
