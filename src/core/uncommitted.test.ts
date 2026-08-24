/**
 * The measured failure this guards: a 4.35M-token turn that edited everything and
 * committed nothing was reported as "no changes detected", and the work was nearly
 * discarded on that sentence (CRL-91).
 */
import { describe, expect, it } from 'vitest';
import { describeUncommitted, uncommittedAcross, uncommittedIn } from './uncommitted.js';
import type { WorkspaceHandle, WorkspaceIO } from './types.js';

const handle = { id: 'ws', workdir: '/ws', backend: 'local' } as unknown as WorkspaceHandle;

function io(fn: (cmd: string) => { stdout: string; code: number } | Error): WorkspaceIO {
  return {
    async exec(_h: WorkspaceHandle, cmd: string) {
      const r = fn(cmd);
      if (r instanceof Error) throw r;
      return { ...r, stderr: '' };
    },
  } as unknown as WorkspaceIO;
}

describe('uncommittedIn', () => {
  it('reads the paths out of porcelain output, dropping the status letters', async () => {
    // Exactly what the measured run had in `server` at the moment of the verdict.
    const out = [
      ' M libs/entity/src/sync-run-log.schema.ts',
      '?? libs/entity/src/sync-run-log.schema.spec.ts',
      '?? verify-boot-warning-tmp.ts',
    ].join('\n');
    const files = await uncommittedIn(io(() => ({ stdout: out, code: 0 })), handle, 'server');
    expect(files).toEqual([
      'libs/entity/src/sync-run-log.schema.ts',
      'libs/entity/src/sync-run-log.schema.spec.ts',
      'verify-boot-warning-tmp.ts',
    ]);
  });

  it('scopes the command to the repo subdirectory', async () => {
    let seen = '';
    await uncommittedIn(io((cmd) => ((seen = cmd), { stdout: '', code: 0 })), handle, 'server');
    expect(seen).toBe('git -C server status --porcelain');
  });

  it('reports nothing for a clean tree', async () => {
    expect(await uncommittedIn(io(() => ({ stdout: '\n', code: 0 })), handle, 'server')).toEqual([]);
  });

  /**
   * This only ever runs to make a stuck message more useful. A repo that was never cloned,
   * or a docker exec that fell over, must not become the thing that breaks the run.
   */
  it('stays quiet when git fails rather than propagating', async () => {
    expect(await uncommittedIn(io(() => ({ stdout: 'not a git repository', code: 128 })), handle, 'x')).toEqual([]);
  });

  it('stays quiet when exec itself throws', async () => {
    expect(await uncommittedIn(io(() => new Error('container gone')), handle, 'x')).toEqual([]);
  });
});

describe('uncommittedAcross', () => {
  it('keeps only the repos that actually have something', async () => {
    const dirty = await uncommittedAcross(
      io((cmd) => ({ stdout: cmd.includes('server') ? ' M a.ts' : '', code: 0 })),
      handle,
      ['app', 'server', 'admin'],
    );
    expect(dirty).toEqual([{ key: 'server', files: ['a.ts'] }]);
  });
});

describe('describeUncommitted', () => {
  it('names the repo, the count and the files', () => {
    expect(describeUncommitted([{ key: 'server', files: ['a.ts', 'b.ts'] }])).toBe('server (2): a.ts, b.ts');
  });

  it('truncates a long list instead of filling the panel', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(describeUncommitted([{ key: 'app', files }])).toBe('app (7): a, b, c, d, e, +2 more');
  });
});
