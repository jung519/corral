/**
 * Electron main process — orchestrator host + window manager (the PM2 replacement).
 *
 * Lifecycle: on first run (no config) the window loads the setup wizard; once a
 * config exists it starts the orchestrator child and loads the dashboard. All
 * native capabilities are exposed to the renderer through preload IPC handlers.
 */
import { app, BrowserWindow, ipcMain, Notification } from 'electron';
import { exec, execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configExists, readConfig, writeConfig } from './config-store.js';
import { clearDraft, readDraft, writeDraft } from './draft-store.js';
import { deleteSecret, hasSecret, setSecret } from './keychain.js';
import { callCore, restartOrchestrator, startOrchestrator, stopOrchestrator } from './orchestrator-process.js';
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

/** Brand icon (coral C enclosure). Used for the dev dock icon and the Win/Linux
 *  window icon; the packaged macOS icon comes from build/icon.icns via electron-builder. */
const ICON_PNG = join(__dirname, '..', 'build', 'icon.png');

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Corral',
    backgroundColor: '#0F172A',
    icon: existsSync(ICON_PNG) ? ICON_PNG : undefined,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Ensure the core (IPC control plane) is running whenever a window exists — covers
  // first launch and macOS reopen-after-close. Idempotent (no-op if already up).
  startOrchestrator();
  const firstRun = !configExists();
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
  ipcMain.handle('cli:detect', (_e, provider: string) => detectCli(provider));
  ipcMain.handle('claude:setup-token', () => runClaudeSetupToken());
  ipcMain.handle('codex:import-auth', () => importCodexAuth());
  ipcMain.handle('notify', (_e, title: string, body: string) => showNotification(title, body));

  ipcMain.handle('validate:notion', (_e, token: string) => validateNotion(token));
  ipcMain.handle('notion:schema', (_e, token: string, dbId: string) => fetchNotionSchema(token, dbId));
  ipcMain.handle('test:repo', (_e, input: RepoTestInput) => testRepoConnection(input));
  ipcMain.handle('test:tracker', (_e, input: TrackerTestInput) => testTrackerConnection(input));
  ipcMain.handle('test:reference', (_e, repo: string, token: string) => testReferenceConnection(repo, token));
  ipcMain.handle('validate:github', (_e, token: string) => validateGithub(token));
  ipcMain.handle('validate:agent', (_e, provider: string, key: string) => validateAgent(provider, key));

  // After setup (config + secrets just written): respawn the core so it picks up the
  // new config and the freshly-saved keychain secrets (injected as env on spawn).
  ipcMain.handle('orchestrator:start', () => {
    restartOrchestrator();
    return { ok: true };
  });

  // The renderer's control-plane calls + event stream, relayed over the core IPC channel.
  ipcMain.handle('core:call', (_e, method: string, args?: Record<string, unknown>) => callCore(method, args));
}

/** Show an OS notification when human action is needed (approval / error). Suppressed
 *  while the window is focused — no point nagging if the user is already looking. Click
 *  raises the app so they can act immediately. */
function showNotification(title: string, body: string): void {
  if (!Notification.isSupported() || win?.isFocused()) return;
  const n = new Notification({ title, body });
  n.on('click', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  n.show();
}

function detectDocker(): Promise<{ available: boolean; version?: string }> {
  return new Promise((resolve) => {
    exec('docker --version', (err, stdout) => {
      if (err) resolve({ available: false });
      else resolve({ available: true, version: stdout.trim() });
    });
  });
}

/** The official CLI binary for each agent provider. */
const CLI_BIN: Record<string, string> = { claude: 'claude', gemini: 'gemini', gpt: 'codex' };

/** Check whether a provider's CLI is installed (runs `<bin> --version`). Binary is
 *  looked up from a fixed whitelist, never interpolated from the provider arg. */
function detectCli(provider: string): Promise<{ installed: boolean; version?: string }> {
  const bin = CLI_BIN[provider];
  if (!bin) return Promise.resolve({ installed: false });
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err) resolve({ installed: false });
      else resolve({ installed: true, version: stdout.trim().split('\n')[0] });
    });
  });
}

/** Run `claude setup-token` to obtain a long-lived subscription OAuth token at save
 *  time, so the user doesn't have to run it in a terminal and paste the result. The
 *  CLI opens the browser itself and serves a localhost OAuth callback (no stdin/TTY
 *  needed), then prints the `sk-ant-oat…` token — which we extract from its output.
 *  On failure we return the output tail (it contains the URL) so the UI can fall back
 *  to manual auth. */
function runClaudeSetupToken(): Promise<{ ok: boolean; token?: string; error?: string }> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (r: { ok: boolean; token?: string; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn('claude', ['setup-token'], { stdio: ['ignore', 'pipe', 'pipe'] });
    // Browser auth can take a while; give the user 5 minutes before giving up.
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, error: 'timeout — 인증이 완료되지 않았습니다 (5분 초과)' });
    }, 300_000);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', (err) =>
      finish({ ok: false, error: `claude CLI 실행 실패 (설치/PATH 확인): ${err instanceof Error ? err.message : String(err)}` }),
    );
    child.on('close', () => {
      const m = out.match(/sk-ant-oat[A-Za-z0-9_-]+/);
      if (m) finish({ ok: true, token: m[0] });
      else finish({ ok: false, error: out.trim().slice(-600) || '출력에서 토큰을 찾지 못했습니다.' });
    });
  });
}

// App name (menu bar, About, dock tooltip).
app.setName('Corral');
// Electron derives BOTH the userData dir AND safeStorage's keychain entry
// ("<name> Safe Storage") from the app name. Pin userData to the historical
// 'corral-desktop' dir so plaintext config/state is preserved. NOTE: secrets stay tied
// to the name — after this rename, existing encrypted tokens must be re-entered once
// (they re-encrypt under the new "Corral" key); config itself is untouched.
app.setPath('userData', join(app.getPath('appData'), 'corral-desktop'));

/** Import the host's codex login (~/.codex/auth.json) so it can be injected into a
 *  docker worker for GPT. Codex auth is a FILE (oauth tokens + key), so unlike Claude
 *  it mounts/injects cleanly on macOS. Returns the file base64-encoded for the keychain. */
function importCodexAuth(): { ok: boolean; b64?: string; error?: string } {
  const path = join(homedir(), '.codex', 'auth.json');
  if (!existsSync(path)) {
    return { ok: false, error: '호스트에 codex 로그인이 없습니다. 먼저 `codex login`으로 로그인하세요.' };
  }
  try {
    const raw = readFileSync(path);
    if (!raw.length) return { ok: false, error: 'auth.json이 비어 있습니다.' };
    return { ok: true, b64: raw.toString('base64') };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

app.whenReady().then(() => {
  // macOS dev: the dock icon comes from the bundle when packaged, but in `electron .`
  // it's the default Electron icon — set the brand icon explicitly so dev matches.
  if (process.platform === 'darwin' && app.dock && existsSync(ICON_PNG)) app.dock.setIcon(ICON_PNG);
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
