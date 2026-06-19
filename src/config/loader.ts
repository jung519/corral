/** Load + validate Corral config from a YAML file. Secrets are NOT here — config
 * holds CredentialRef pointers; secrets are resolved from a CredentialStore. */
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { ConfigSchema, type Config } from './schema.js';

export function parseConfig(raw: string): Config {
  return ConfigSchema.parse(YAML.parse(raw));
}

export async function loadConfig(path: string): Promise<Config> {
  return parseConfig(await readFile(path, 'utf8'));
}
