/**
 * Electron main process — orchestrator host + window manager (the PM2 replacement).
 *
 * Lifecycle: on first run (no config) the window loads the setup wizard; once a
 * config exists it starts the orchestrator child and loads the dashboard. All
 * native capabilities are exposed to the renderer through preload IPC handlers.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { exec } from 'node:child_process';
import { join } from 'node:path';
import { configExists, readConfig, writeConfig } from './config-store.js';
import { clearDraft, readDraft, writeDraft } from './draft-store.js';
import { deleteSecret, hasSecret, setSecret } from './keychain.js';
import { orchestratorRunning, startOrchestrator, stopOrchestrator } from './orchestrator-process.js';
import {
  fetchNotionSchema,
  type RepoTestInput,
  testReferenceConnection,
  testRepoConnection,
  testTrackerConnection,
  type TrackerTestInput,
  validateAgent,
  validateGithub,
  validateNotion,
} from './validators.js';

/** Control-plane port the renderer talks to (kept in sync with the config default). */
const CONTROL_PLANE_PORT = 4400;

/** Renderer location: a Vite dev server in development, built files in production. */
function rendererUrl(hash: string): string {
  const dev = process.env.CORRAL_RENDERER_URL; // Vite dev server in development
  if (dev) return `${dev}${hash}`;
  const base = app.isPackaged
    ? join(process.resourcesPath, 'renderer', 'index.html')
    : join(app.getAppPath(), '..', 'renderer', 'dist', 'index.html');
  return `file://${base}${hash}`;
}

let win: BrowserWindow | undefined;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const firstRun = !configExists();
  if (!firstRun) startOrchestrator();
  void win.loadURL(rendererUrl(firstRun ? '#/setup' : '#/'));
}

function registerIpc(): void {
  ipcMain.handle('config:exists', () => configExists());
  ipcMain.handle('config:read', () => readConfig());
  ipcMain.handle('config:write', (_e, yaml: string) => writeConfig(yaml));

  ipcMain.handle('draft:read', () => readDraft());
  ipcMain.handle('draft:write', (_e, json: string) => writeDraft(json));
  ipcMain.handle('draft:clear', () => clearDraft());

  ipcMain.handle('secret:set', (_e, service: string, account: string, value: string) =>
    setSecret(service, account, value),
  );
  ipcMain.handle('secret:has', (_e, service: string, account: string) => hasSecret(service, account));
  ipcMain.handle('secret:delete', (_e, service: string, account: string) => deleteSecret(service, account));

  ipcMain.handle('docker:detect', () => detectDocker());

  ipcMain.handle('validate:notion', (_e, token: string) => validateNotion(token));
  ipcMain.handle('notion:schema', (_e, token: string, dbId: string) => fetchNotionSchema(token, dbId));
  ipcMain.handle('test:repo', (_e, input: RepoTestInput) => testRepoConnection(input));
  ipcMain.handle('test:tracker', (_e, input: TrackerTestInput) => testTrackerConnection(input));
  ipcMain.handle('test:reference', (_e, repo: string, token: string) => testReferenceConnection(repo, token));
  ipcMain.handle('validate:github', (_e, token: string) => validateGithub(token));
  ipcMain.handle('validate:agent', (_e, provider: string, key: string) => validateAgent(provider, key));

  ipcMain.handle('orchestrator:start', () => {
    if (!orchestratorRunning()) startOrchestrator();
    void win?.loadURL(rendererUrl('#/'));
    return { ok: true, port: CONTROL_PLANE_PORT };
  });
}

function detectDocker(): Promise<{ available: boolean; version?: string }> {
  return new Promise((resolve) => {
    exec('docker --version', (err, stdout) => {
      if (err) resolve({ available: false });
      else resolve({ available: true, version: stdout.trim() });
    });
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopOrchestrator();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => stopOrchestrator());
