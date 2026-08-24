/**
 * The switch exists so that the change which introduces three planning gates does not
 * impose them on everyone the moment it merges (CRL-101).
 */
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from './schema.js';

const minimal = {
  tracker: {
    kind: 'notion',
    database_id: 'db_1',
    credential: { service: 'notion' },
    states: { planning: 'P', plan_review: 'PR', in_progress: 'IP', in_review: 'IR', done: 'D' },
    properties: { status: 'Status', identifier: 'ID' },
  },
  repositories: [{ kind: 'github', key: 'main', repo: 'acme/widgets', credential: { service: 'github' } }],
  agent: { provider: 'claude', transport: 'api', credential: { service: 'anthropic' } },
};

const parse = (extra: Record<string, unknown> = {}) => ConfigSchema.parse({ ...minimal, ...extra });

describe('spec_mode', () => {
  /**
   * Not a cost preference. The daily token ceiling is one pool shared with the operational
   * pillar, so a default of `split` would quietly take ~2.4x the dev-side budget out of the
   * pipeline's share and stop it running.
   */
  it('defaults to single', () => {
    expect(parse().spec_mode).toBe('single');
  });

  it('can be turned on', () => {
    expect(parse({ spec_mode: 'split' }).spec_mode).toBe('split');
  });

  it('rejects anything else rather than falling back', () => {
    expect(() => parse({ spec_mode: 'three-gates' })).toThrow();
  });
});
