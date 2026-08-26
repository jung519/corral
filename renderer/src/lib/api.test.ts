/**
 * The window→core call contract, on the argument NAMES.
 *
 * A wrong name is invisible from either side: `getSpecDocs` sent `{ id }` while the core's
 * dispatch reads `a.identifier`, so `specDocs('')` looked up a handle that cannot exist and
 * the spec panel said "no spec documents for this issue" — for every issue it was ever
 * opened on, however many documents were sitting in the workspace (CRL-127).
 *
 * `id` is not a synonym over there: dispatch uses it for approval ids (`action`, `diffs`)
 * and history record ids. An issue is always `identifier`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getSpecDocs } from './api';

interface Sent {
  method: string;
  args?: Record<string, unknown>;
}

function stubBridge(result: unknown): Sent[] {
  const sent: Sent[] = [];
  (globalThis as unknown as { window: unknown }).window = {
    corral: {
      core: {
        call: async (method: string, args?: Record<string, unknown>) => {
          sent.push({ method, args });
          return result;
        },
      },
    },
  };
  return sent;
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('core call arguments', () => {
  it('asks for spec documents by `identifier`, the name dispatch reads', async () => {
    const sent = stubBridge({ docs: [] });
    await getSpecDocs('ISS-9');
    expect(sent).toEqual([{ method: 'specDocs', args: { identifier: 'ISS-9' } }]);
  });

  it('passes the identifier through rather than dropping it', async () => {
    const sent = stubBridge({ docs: [{ stage: 'requirements', markdown: '#', html: '<h1></h1>' }] });
    const docs = await getSpecDocs('SOJAN-509');
    expect(sent[0]?.args?.identifier).toBe('SOJAN-509');
    expect(docs).toHaveLength(1);
  });
});
