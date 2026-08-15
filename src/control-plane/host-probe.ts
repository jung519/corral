/**
 * Probes the machine THIS core runs on — Docker and the agent CLIs.
 *
 * The setup wizard asks "is Docker available?" to pick a workspace backend. When the
 * core is remote, the honest answer is about the remote machine, not the laptop showing
 * the wizard: the containers run where the core runs. So the probe lives here and the
 * desktop asks the core for it (see the routing issue), instead of shelling out itself.
 */
import { execFile } from 'node:child_process';

const PROBE_TIMEOUT_MS = 5_000;

/** Run `<bin> --version` and return its first line, or null if the binary isn't usable. */
function version(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: PROBE_TIMEOUT_MS }, (err, stdout) => {
      resolve(err ? null : (stdout.trim().split('\n')[0] ?? ''));
    });
  });
}

export async function detectDocker(): Promise<{ available: boolean; version?: string }> {
  const v = await version('docker');
  return v === null ? { available: false } : { available: true, version: v };
}

/** The official CLI binary for each agent provider. */
const CLI_BIN: Record<string, string> = { claude: 'claude', gemini: 'gemini', gpt: 'codex' };

/**
 * Whether a provider's CLI is installed here. The binary comes from the fixed table
 * above and is never built from the caller's string — over a remote control plane the
 * provider name is attacker-shaped input, and `execFile` with an interpolated binary
 * would be a command-execution hole.
 */
export async function detectCli(provider: string): Promise<{ installed: boolean; version?: string }> {
  const bin = CLI_BIN[provider];
  if (!bin) return { installed: false };
  const v = await version(bin);
  return v === null ? { installed: false } : { installed: true, version: v };
}
