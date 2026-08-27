/**
 * Which pillar the app is showing.
 *
 * Corral does two jobs that share an account, a provider and a token ceiling but nothing
 * else: turning issues into pull requests, and running operational pipelines. Someone
 * doing one of them does not want the other's screens in the way, so the app shows one at
 * a time rather than mixing both into one navigation.
 *
 * The choice is remembered because it rarely changes. Asking again on every launch would
 * be a question with the same answer every time — an operator who watches pipelines all
 * day should land on pipelines.
 *
 * Kept next to `prefs`: this is a per-machine view preference, not part of the setup that
 * lives in the config and the keychain. Switching modes must never look like a settings
 * change.
 */
export type Mode = 'dev' | 'ops';

const KEY = 'corral.mode';

function load(): Mode | null {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === 'dev' || saved === 'ops' ? saved : null;
  } catch {
    return null;
  }
}

/** `null` until the user has chosen once — that is what shows the picker. */
export const modeState = $state<{ current: Mode | null }>({ current: load() });

export function setMode(mode: Mode): void {
  modeState.current = mode;
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* storage unavailable — the app still works, it just asks again next time */
  }
}

export function currentMode(): Mode | null {
  return modeState.current;
}
