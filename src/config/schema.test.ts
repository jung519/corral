import { describe, expect, it } from 'vitest';
import { ConfigSchema } from './schema.js';

const baseConfig = {
  tracker: {
    kind: 'notion',
    database_id: 'db_123',
    credential: { service: 'notion' },
    states: {
      planning: '시작 전',
      plan_review: '계획 검토',
      in_progress: '개발 중',
      in_review: '리뷰 중',
      done: '완료',
    },
    properties: { status: 'Status', identifier: 'ID' },
  },
  repositories: [
    {
      kind: 'github',
      key: 'main',
      repo: 'acme/widgets',
      credential: { service: 'github' },
    },
  ],
  agent: {
    provider: 'claude',
    transport: 'api',
    credential: { service: 'anthropic' },
  },
};

describe('ConfigSchema', () => {
  it('parses a minimal config and applies defaults', () => {
    const cfg = ConfigSchema.parse(baseConfig);
    expect(cfg.profile.language).toBe('en');
    expect(cfg.profile.stack).toBe('generic');
    expect(cfg.workspace.backend).toBe('local');
    expect(cfg.channel.kind).toBe('web');
    expect(cfg.channel.port).toBe(4400);
    expect(cfg.repositories[0]?.branch_strategy.production).toBe('main');
    expect(cfg.tracker.credential.account).toBe('default');
  });

  it('rejects api transport without a credential', () => {
    const bad = { ...baseConfig, agent: { provider: 'claude', transport: 'api' } };
    const result = ConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects a repo that is not owner/name', () => {
    const bad = {
      ...baseConfig,
      repositories: [{ kind: 'github', key: 'main', repo: 'not-a-path', credential: { service: 'github' } }],
    };
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  it('requires at least one repository', () => {
    const bad = { ...baseConfig, repositories: [] };
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });
});
