/**
 * Auto-update DELIVERY (electron-updater) — the mechanism half of updates, complementing
 * the version GATE (policy, `update-gate.ts`). The gate decides whether to force/nudge; this
 * quietly keeps most users on the latest build so the forced gate rarely fires.
 *
 * Flow: check GitHub Releases (the `publish` config → bundled `app-update.yml`), download in
 * the background, install on quit, and pop an OS notification when a build is ready.
 *
 * Guards:
 * - **Packaged only** — a dev run has no `app-update.yml` and no code signature.
 * - **macOS needs signing** — Squirrel.Mac refuses to install an unsigned update, so until
 *   the signing secrets exist (docs/signing.md) this errors on macOS; the error is logged
 *   and swallowed, and the gate's download link stays as the fallback. Windows works unsigned.
 */
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

const SIX_HOURS = 6 * 60 * 60 * 1000;

export function initAutoUpdate(): void {
  if (!app.isPackaged) return;

  // Never surface a raw updater error to the user — unsigned macOS, offline, or a missing
  // release all land here and must stay silent (the gate handles anything user-facing).
  autoUpdater.on('error', (err: Error) => console.warn('[auto-update] error:', err?.message ?? err));

  const check = (): void => {
    // checkForUpdatesAndNotify: download in the background, notify + install-on-quit when ready.
    autoUpdater
      .checkForUpdatesAndNotify()
      .catch((err: unknown) => console.warn('[auto-update] check failed:', err instanceof Error ? err.message : err));
  };

  check();
  // Long-running sessions: re-check periodically. unref so it never keeps the app alive.
  setInterval(check, SIX_HOURS).unref();
}
