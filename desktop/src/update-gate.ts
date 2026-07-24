/**
 * Version gate — the POLICY layer of updates (deliberately separate from delivery, so it
 * works before code-signing/auto-update exist: an out-of-date app can be blocked with just
 * a "download" link). At launch, main fetches a small remote manifest and this decides
 * whether to force an update, recommend one, or proceed. See docs/version-gate-plan (TBD).
 *
 * This file is electron-free on purpose (pure logic + fetch) so it stays unit-testable.
 */

/** Remote kill-switch manifest. All fields optional — a missing field means "no opinion". */
export interface VersionManifest {
  /** Below this → FORCED: the app is blocked until updated. Your remote kill switch. */
  minSupported?: string;
  /** Below this (but >= minSupported) → RECOMMENDED: a dismissible nudge. */
  recommended?: string;
  /** Newest version, for display. */
  latest?: string;
  /** Where the user gets the new build (release page / installer). */
  downloadUrl?: string;
  /** Short message shown in the prompt (e.g. "security fix included"). */
  notice?: string;
}

export type GateKind = 'ok' | 'recommended' | 'forced';

export interface GateDecision {
  kind: GateKind;
  /** The version the user should move to (recommended/minSupported), for the message. */
  target?: string;
  downloadUrl?: string;
  notice?: string;
}

/**
 * Where the manifest lives. Baked into the shipped binary, so it can't change afterwards
 * without force-updating everyone — hence the OWNED custom domain (corralhq.dev): the feed
 * can move hosts (GitHub Pages, S3, …) forever without touching this URL. Host `version.json`
 * at this path (e.g. GitHub Pages for the corral repo with a corralhq.dev CNAME). Overridable
 * via env for testing. Until the file exists the gate fails open (offline → proceed).
 */
export const MANIFEST_URL =
  process.env.CORRAL_UPDATE_MANIFEST_URL ?? 'https://corralhq.dev/version.json';

/** Compare two `x.y.z` versions → -1 | 0 | 1. Pre-release/build metadata is ignored
 *  (`1.2.0-beta` compares as `1.2.0`). Throws on a non-numeric core. */
export function compareSemver(a: string, b: string): number {
  const core = (v: string): number[] => {
    const parts = v.trim().replace(/^v/, '').split(/[-+]/)[0]!.split('.');
    return [0, 1, 2].map((i) => {
      const n = Number(parts[i] ?? 0);
      if (!Number.isInteger(n) || n < 0) throw new Error(`bad version: ${v}`);
      return n;
    });
  };
  const pa = core(a);
  const pb = core(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i]! < pb[i]!) return -1;
    if (pa[i]! > pb[i]!) return 1;
  }
  return 0;
}

/**
 * Decide the gate for `current` against the manifest. **Fail-open**: any parse problem or
 * missing manifest resolves to `ok` — never brick a user over a bad version string or a
 * network blip (offline handling lives in the caller, which passes an empty manifest).
 */
export function decideGate(current: string, manifest: VersionManifest | null): GateDecision {
  if (!manifest) return { kind: 'ok' };
  try {
    const below = (v?: string): boolean => !!v && compareSemver(current, v) < 0;
    if (below(manifest.minSupported)) {
      return { kind: 'forced', target: manifest.minSupported, downloadUrl: manifest.downloadUrl, notice: manifest.notice };
    }
    if (below(manifest.recommended)) {
      return { kind: 'recommended', target: manifest.recommended, downloadUrl: manifest.downloadUrl, notice: manifest.notice };
    }
    return { kind: 'ok' };
  } catch {
    return { kind: 'ok' };
  }
}

/**
 * Fetch the manifest. Returns null on ANY failure (offline, timeout, non-200, bad JSON) so
 * the caller fails open. Appends a cache-buster to dodge the CDN cache on raw/Pages hosts.
 */
export async function fetchManifest(url = MANIFEST_URL, timeoutMs = 4000): Promise<VersionManifest | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const bust = url.includes('?') ? '&' : '?';
    const res = await fetch(`${url}${bust}t=${Date.now()}`, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (typeof data !== 'object' || data === null) return null;
    return data as VersionManifest;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
