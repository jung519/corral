/** Repository axis registry. */
import type { RepositoryConfig } from '../config/schema.js';
import { Registry } from '../core/registry.js';
import type { RepositoryAdapter } from '../core/types.js';
import { GithubRepository, type RepositoryCtx } from './github.js';

export const repositories = new Registry<RepositoryConfig, RepositoryAdapter, RepositoryCtx>('repository');

repositories.register('github', (config, ctx) =>
  new GithubRepository(config as Extract<RepositoryConfig, { kind: 'github' }>, ctx),
);

export type { RepositoryCtx };
