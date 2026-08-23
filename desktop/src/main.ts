/**
 * Electron main process — orchestrator host + window manager (the PM2 replacement).
 *
 * Lifecycle: on first run (no config) the window loads the setup wizard; once a
 * config exists it starts the orchestrator child and loads the dashboard. All
 * native capabilities are exposed to the renderer through preload IPC handlers.
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configExists as localConfigExists } from './config-store.js';
import * as native from './native-routing.js';
import { initAutoUpdate } from './auto-updater.js';
import {
  callCore,
  linkStatus,
  pairRemote,
  restartOrchestrator,
  startOrchestrator,
  stopOrchestrator,
} from './orchestrator-process.js';
import {
  EXPECT_SCRIPT,
  failureReason,
  findAuthUrl,
  findToken,
  oauthError,
  spawnFailureReason,
  splitAuthCode,
  renderText,
} from './claude-token.js';
import { clearRemoteToken, readRemote, writeRemote } from './remote-store.js';
import { decideGate, fetchManifest, type GateDecision } from './update-gate.js';
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

  // External links (tracker pages, PRs) open in the OS browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Ensure the core (IPC control plane) is running whenever a window exists — covers
  // first launch and macOS reopen-after-close. Idempotent (no-op if already up).
  startOrchestrator();
  // Which screen to open first. Only the local config can be checked synchronously, and
  // in remote mode it is the wrong disk to look at — so we open the dashboard and let the
  // renderer redirect once it has asked the core (App.svelte does this on mount).
  const firstRun = !native.isRemote() && !localConfigExists();
  void win.loadURL(rendererUrl(firstRun ? '#/setup' : '#/'));
}

function registerIpc(): void {
  // Config, secrets, direction, draft and host probes go through native-routing: they
  // land on this machine in local mode and on the core's machine in remote mode.
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('config:exists', () => native.configExists());
  ipcMain.handle('config:read', () => native.configRead());
  ipcMain.handle('config:parsed', () => native.configParsed());
  ipcMain.handle('config:write', (_e, yaml: string) => native.configWrite(yaml));

  ipcMain.handle('draft:read', () => native.draftRead());
  ipcMain.handle('draft:write', (_e, json: string) => native.draftWrite(json));
  ipcMain.handle('draft:clear', () => native.draftClear());

  ipcMain.handle('direction:read', () => native.directionRead());
  ipcMain.handle('direction:write', (_e, text: string) => native.directionWrite(text));

  // Core connection: run the core here (local) or attach to one elsewhere (remote).
  ipcMain.handle('remote:get', () => {
    const saved = readRemote();
    return {
      mode: saved.mode,
      url: saved.url ?? '',
      label: saved.label ?? '',
      paired: !!saved.token, // drives whether the UI asks for a pairing code
      ...linkStatus(),
    };
  });
  ipcMain.handle('remote:setMode', (_e, mode: 'local' | 'remote', url?: string, label?: string) => {
    writeRemote({ mode, url, label });
    restartOrchestrator(); // pick up the new mode immediately
    return { ok: true, ...linkStatus() };
  });
  ipcMain.handle('remote:pair', (_e, url: string, code: string, label?: string) => pairRemote({ url, code, label }));
  ipcMain.handle('remote:unpair', () => {
    // Forget this device's token; the next remote connection needs a fresh code.
    clearRemoteToken();
    writeRemote({ mode: 'local' });
    restartOrchestrator();
    return { ok: true };
  });

  ipcMain.handle('secret:set', (_e, service: string, account: string, value: string) =>
    native.secretSet(service, account, value),
  );
  ipcMain.handle('secret:has', (_e, service: string, account: string) => native.secretHas(service, account));
  ipcMain.handle('secret:delete', (_e, service: string, account: string) => native.secretDelete(service, account));

  ipcMain.handle('docker:detect', () => native.detectDocker());
  ipcMain.handle('cli:detect', (_e, provider: string) => native.detectCli(provider));
  // Login capture stays on THIS machine in both modes — it opens a browser, and a VM has
  // none. The token it returns is saved through `secret:set`, so it still lands on the core.
  // Clipboard through the main process, not `navigator.clipboard`: the window is loaded
  // from a `file://` URL, which is not a secure context, so the web API is unavailable.
  // Every value a user would otherwise select by hand goes through here.
  ipcMain.handle('clipboard:write', (_e, text: string) => {
    clipboard.writeText(String(text ?? ''));
    return { ok: true };
  });
  ipcMain.handle('clipboard:read', () => ({ ok: true, text: clipboard.readText() }));
  ipcMain.handle('claude:token-start', () => startClaudeSetupToken());
  ipcMain.handle('claude:token-code', (_e, code: string) => submitClaudeCode(code));
  // A quit mid-flow must not leave a CLI attached to a pty nobody reads.
  app.on('will-quit', endSession);
  ipcMain.handle('claude:token-cancel', () => {
    endSession();
    return { ok: true };
  });
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
  // A remote core has already reloaded itself inside `config:write` — respawning here
  // would only drop and re-establish the link for nothing.
  ipcMain.handle('orchestrator:start', () => {
    if (!native.isRemote()) restartOrchestrator();
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

/**
 * Driving `claude setup-token` for the user, when this machine can.
 *
 * The CLI is an Ink TUI: with no TTY it prints nothing, and after the browser sign-in it
 * waits for a code to be pasted in. The previous version spawned it with piped stdio and
 * awaited a token that could never come — the button spun for five minutes and left the
 * process running (CRL-83).
 *
 * So: a pty (borrowed from `expect`, which is base-system on macOS), and three steps
 * instead of one, because the code only exists after the user has signed in. Every step
 * has an end — a timeout, a failure, or a cancel — and the caller falls back to asking
 * the user to run the command themselves whenever one is reached. That fallback is not
 * only for errors: most Linux desktops and every Windows have no `expect` at all.
 */
type TokenStep = { ok: true; url?: string; token?: string } | { ok: false; reason: string; error?: string };

/** Nothing here ever waits forever. Sign-in is slow, a rejected code is not. */
const URL_WAIT_MS = 20_000;
const TOKEN_WAIT_MS = 60_000;

let session: { child: ChildProcess; out: string } | undefined;

function endSession(): void {
  const s = session;
  session = undefined;
  const pid = s?.child.pid;
  if (!s || !pid) return;

  // Negative pid = the whole group. `expect` is the child; `claude` is *its* child, and
  // killing only the parent leaves a stray CLI holding the pty.
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        s.child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };

  signal('SIGTERM');
  // `expect` ignores SIGTERM — measured, not assumed: after `kill -TERM` it was still
  // running, and only `kill -KILL` ended it. So escalate. A second is long enough for a
  // process that does listen, and short enough that nobody notices.
  const kill = setTimeout(() => signal('SIGKILL'), 1_000);
  s.child.once('close', () => clearTimeout(kill));
}

/** Watch the CLI's screen until `read` finds something, the process dies, or time runs out. */
function watch<T>(ms: number, read: (out: string) => T | null): Promise<T | 'timeout' | 'gone'> {
  return new Promise((resolve) => {
    const s = session;
    if (!s) return resolve('gone');
    const done = (v: T | 'timeout' | 'gone'): void => {
      clearTimeout(timer);
      s.child.stdout?.off('data', onData);
      s.child.off('close', onClose);
      resolve(v);
    };
    const check = (): boolean => {
      const found = read(s.out);
      if (found === null) return false;
      done(found);
      return true;
    };
    const onData = (d: Buffer): void => {
      s.out += d.toString();
      check();
    };
    const onClose = (): void => done('gone');
    const timer = setTimeout(() => done('timeout'), ms);
    s.child.stdout?.on('data', onData);
    s.child.on('close', onClose);
    // The answer may already be on screen — a listener added now would never see it.
    check();
  });
}

/** Start the flow: spawn under a pty and hand back the sign-in URL. */
async function startClaudeSetupToken(): Promise<TokenStep> {
  endSession();
  const child = spawn('expect', ['-c', EXPECT_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // Its own group, so cancelling takes the CLI down with it.
    detached: true,
  });
  session = { child, out: '' };
  child.stderr?.on('data', (d: Buffer) => session && (session.out += d.toString()));

  const spawnFailed = new Promise<TokenStep>((resolve) =>
    child.once('error', (err: NodeJS.ErrnoException) =>
      resolve({ ok: false, reason: spawnFailureReason(err.code), error: err.message }),
    ),
  );
  const url = watch(URL_WAIT_MS, (out) => findAuthUrl(out));
  const found = await Promise.race([spawnFailed, url]);

  if (typeof found === 'object') {
    endSession();
    return found;
  }
  if (found === 'timeout' || found === 'gone') {
    const reason = session && renderText(session.out).trim().length === 0 ? 'no-pty' : found;
    endSession();
    return { ok: false, reason };
  }
  return { ok: true, url: found };
}

/** Hand the code from the sign-in page to the waiting CLI, and read back the token. */
async function submitClaudeCode(code: string): Promise<TokenStep> {
  if (!session) return { ok: false, reason: 'gone' };
  // The screen checks this too; here it is a guarantee rather than a courtesy — the CLI
  // would reject it and end the session, costing the user the whole flow again.
  const split = splitAuthCode(code);
  if (!split.ok) return { ok: false, reason: 'partial-code' };
  session.child.stdin?.write(`${split.code}\n`);
  // Either outcome, whichever the screen shows first. The refusal carries the CLI's own
  // words — "Invalid code" and "Request failed with status code 400" are different
  // problems and the user can only tell them apart if we pass the message along.
  const found = await watch(TOKEN_WAIT_MS, (out) => {
    const token = findToken(out);
    if (token) return { kind: 'token' as const, token };
    const refusal = oauthError(out);
    return refusal ? { kind: 'refused' as const, refusal } : null;
  });
  if (typeof found === 'object' && found.kind === 'refused') {
    // Recoverable in the CLI, but only by pressing Enter into a screen we would then have
    // to keep reading. Ending here and starting over is the honest shape.
    endSession();
    // The status, when there was one, is the difference between "you copied half of it"
    // and "the server would not take it" — different advice, so it travels with the reason.
    return {
      ok: false,
      reason: found.refusal.kind,
      error: found.refusal.status ? String(found.refusal.status) : undefined,
    };
  }
  if (found === 'timeout' || found === 'gone') {
    const reason = session ? failureReason(session.out) : 'gone';
    endSession();
    return { ok: false, reason };
  }
  endSession();
  return { ok: true, token: found.token };
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

/**
 * Version gate (§update). Blocks a too-old app (forced) or nudges an out-of-date one
 * (recommended), based on the remote manifest. Returns false only when the app must NOT
 * continue (forced → we open the download page and quit). Fail-open: offline / fetch error
 * → proceed, so a network blip never bricks the app.
 */
async function runUpdateGate(): Promise<boolean> {
  const manifest = await fetchManifest();
  const decision = decideGate(app.getVersion(), manifest);
  if (decision.kind === 'ok') return true;

  if (decision.kind === 'forced') {
    const detail =
      `${decision.notice ? decision.notice + '\n\n' : ''}` +
      `이 버전은 더 이상 지원되지 않습니다. 계속하려면 업데이트가 필요합니다.` +
      `${decision.target ? `\n\n필요 버전: ${decision.target} 이상 (현재 ${app.getVersion()})` : ''}`;
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: '업데이트 필요',
      message: 'Corral 업데이트가 필요합니다',
      detail,
      buttons: decision.downloadUrl ? ['다운로드', '종료'] : ['종료'],
      defaultId: 0,
      cancelId: decision.downloadUrl ? 1 : 0,
      noLink: true,
    });
    if (decision.downloadUrl && response === 0) await shell.openExternal(decision.downloadUrl);
    app.quit();
    return false;
  }

  // recommended → let the app open, then show a dismissible nudge (non-blocking).
  return true;
}

/** The dismissible "update available" nudge shown AFTER the window opens (recommended). */
function showRecommendedNudge(decision: GateDecision): void {
  void dialog
    .showMessageBox({
      type: 'info',
      title: '업데이트 권장',
      message: '새 버전이 있습니다',
      detail:
        `${decision.notice ? decision.notice + '\n\n' : ''}` +
        `${decision.target ? `권장 버전: ${decision.target} (현재 ${app.getVersion()})` : ''}`,
      buttons: decision.downloadUrl ? ['지금 업데이트', '나중에'] : ['확인'],
      defaultId: 0,
      cancelId: decision.downloadUrl ? 1 : 0,
      noLink: true,
    })
    .then(({ response }) => {
      if (decision.downloadUrl && response === 0) void shell.openExternal(decision.downloadUrl);
    });
}

app.whenReady().then(async () => {
  // macOS dev: the dock icon comes from the bundle when packaged, but in `electron .`
  // it's the default Electron icon — set the brand icon explicitly so dev matches.
  if (process.platform === 'darwin' && app.dock && existsSync(ICON_PNG)) app.dock.setIcon(ICON_PNG);

  // Version gate BEFORE anything else — a forced-out app must not spawn the core or window.
  const manifest = await fetchManifest();
  const decision = decideGate(app.getVersion(), manifest);
  if (decision.kind === 'forced') {
    await runUpdateGate();
    return;
  }

  registerIpc();
  createWindow();
  if (decision.kind === 'recommended') showRecommendedNudge(decision);
  // Background delivery: keep the app current so the forced gate rarely fires (packaged only).
  initAutoUpdate();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopOrchestrator();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => stopOrchestrator());
