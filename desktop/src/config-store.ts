/**
 * Config file IO for the desktop app — the corral.yaml lives in userData (NOT next
 * to the binary). First run = no config yet → the renderer shows the setup wizard.
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function configPath(): string {
  return join(app.getPath('userData'), 'corral.yaml');
}

export function configExists(): boolean {
  return existsSync(configPath());
}

export function readConfig(): string | null {
  try {
    return readFileSync(configPath(), 'utf8');
  } catch {
    return null;
  }
}

export function writeConfig(yaml: string): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yaml, 'utf8');
}
