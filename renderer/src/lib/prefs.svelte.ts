/** Local usability preferences (notifications, etc.) — distinct from the operational
 * setup in corral.yaml/keychain. Persisted to localStorage; no secrets. Reactive so
 * the notification trigger reads the current value. */

export interface Prefs {
  /** OS notification when a human approval is requested. */
  notifyApproval: boolean;
  /** OS notification when an error needs attention. */
  notifyError: boolean;
}

const KEY = 'corral.prefs';
const DEFAULTS: Prefs = { notifyApproval: true, notifyError: true };

function load(): Prefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export const prefs = $state<Prefs>(load());

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  prefs[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable — non-fatal */
  }
}
