/**
 * The wall between the two pillars, checked by machine.
 *
 * `docs/module-boundaries.md` says the operational AI must not import the development AI
 * and vice versa, with the wiring points as the only meeting place. That rule was written
 * down and nothing enforced it; the first code under `ops/` is the moment it starts being
 * possible to break. An import is one line and a reviewer will not always catch it.
 *
 * The point isn't tidiness. The operational AI has to stay domain-neutral, and reaching
 * into issue/PR/workspace code is exactly how that neutrality would be lost.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('..', import.meta.url).pathname;

/** Development-AI modules, relative to `src/`. */
const DEV_AI = ['orchestrator', 'review/', 'workspace/', 'tracker/', 'repository/', 'attachments'];

/** The only files allowed to know about both — where the app is assembled. */
const WIRING = ['bootstrap.ts', 'ipc-main.ts', 'main.ts', 'core-host.ts', 'index.ts'];

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** Module specifiers this file imports. */
function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

describe('module boundaries', () => {
  it('ops/ does not import development-AI code', () => {
    const offences: string[] = [];
    for (const file of filesUnder(join(SRC, 'ops'))) {
      for (const spec of importsOf(file)) {
        // Resolve `../../tracker/x.js` down to `tracker/x.js` for comparison.
        const target = spec.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '');
        if (DEV_AI.some((d) => target.startsWith(d))) offences.push(`${file.replace(SRC, '')} → ${spec}`);
      }
    }

    expect(offences).toEqual([]);
  });

  it('development-AI code does not import ops/', () => {
    const offences: string[] = [];
    for (const file of filesUnder(SRC)) {
      const rel = file.replace(SRC, '');
      if (rel.startsWith('ops/') || WIRING.includes(rel)) continue;
      for (const spec of importsOf(file)) {
        if (/(^|\/)ops\//.test(spec)) offences.push(`${rel} → ${spec}`);
      }
    }

    expect(offences).toEqual([]);
  });

  it('ops/ imports only shared infrastructure', () => {
    // Whitelist rather than blacklist: a new development-AI directory added later is
    // then off-limits by default instead of silently allowed.
    const SHARED = ['agent', 'core', 'config', 'credentials', 'profile', 'util', 'control-plane'];
    const opsDir = join(SRC, 'ops');
    const outside: string[] = [];

    for (const file of filesUnder(opsDir)) {
      for (const spec of importsOf(file)) {
        if (!spec.startsWith('.')) continue; // node: and npm packages are fine
        // Resolve the specifier for real — `../pipeline/run.js` from `ops/history/` is
        // still inside ops/, and only a resolved path can tell you that.
        const target = resolve(dirname(file), spec);
        if (target.startsWith(opsDir)) continue;
        const top = target.replace(SRC, '').split('/')[0];
        if (!SHARED.includes(top)) outside.push(`${file.replace(SRC, '')} → ${spec}`);
      }
    }

    expect(outside).toEqual([]);
  });
});
