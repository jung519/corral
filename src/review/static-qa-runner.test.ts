import { describe, expect, it } from 'vitest';
import type { WorkspaceHandle, WorkspaceIO } from '../core/types.js';
import { runStaticQa } from './static-qa-runner.js';

const handle: WorkspaceHandle = { id: 'ISS-1', workdir: '/w', backend: 'local' };

function fakeIo(written: Record<string, string>): WorkspaceIO {
  return {
    async exec(_h, command) {
      return command.includes('fail')
        ? { stdout: '', stderr: 'boom', code: 1 }
        : { stdout: 'ok', stderr: '', code: 0 };
    },
    async writeFile(_h, path, content) {
      written[path] = content;
    },
  } as unknown as WorkspaceIO;
}

describe('runStaticQa', () => {
  it('returns ran:false for no commands', async () => {
    const report = await runStaticQa(fakeIo({}), handle, []);
    expect(report).toEqual({ ran: false, anyFailed: false, results: [] });
  });

  it('runs each command and flags any failure, persisting the report', async () => {
    const written: Record<string, string> = {};
    const report = await runStaticQa(fakeIo(written), handle, ['lint', 'failcmd']);
    expect(report.ran).toBe(true);
    expect(report.anyFailed).toBe(true);
    expect(report.results).toHaveLength(2);
    expect(report.results[1]?.code).toBe(1);
    expect(Object.keys(written)[0]).toContain('static_qa.json');
  });
});
