#!/usr/bin/env node
/**
 * Single source of truth for the app version. Corral ships as ONE app (the desktop shell
 * bundles the core + renderer), so all three package.json versions must stay identical —
 * `app.getVersion()` (the update gate + the packaged installer) reads desktop's. Bump them
 * together, then tag the commit `vX.Y.Z` to match. See docs/versioning.md.
 *
 *   node scripts/set-version.mjs 0.2.0
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['package.json', 'renderer/package.json', 'desktop/package.json'];

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Usage: node scripts/set-version.mjs <x.y.z>\n  got: ${version ?? '(nothing)'}`);
  process.exit(1);
}

for (const rel of FILES) {
  const path = join(root, rel);
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  const prev = pkg.version ?? '(none)';
  pkg.version = version;
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`${rel}: ${prev} → ${version}`);
}
console.log(`\nDone. Commit, then: git tag v${version}`);
