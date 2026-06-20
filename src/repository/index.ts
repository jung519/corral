/** Repository axis registry. github / gitlab / bitbucket. */
import type { RepositoryConfig } from '../config/schema.js';
import { Registry } from '../core/registry.js';
import type { RepositoryAdapter } from '../core/types.js';
import { BitbucketRepository } from './bitbucket.js';
import { GithubRepository, type RepositoryCtx } from './github.js';
import { GitlabRepository } from './gitlab.js';

export const repositories = new Registry<RepositoryConfig, RepositoryAdapter, RepositoryCtx>('repository');

repositories.register('github', (config, ctx) =>
  new GithubRepository(config as Extract<RepositoryConfig, { kind: 'github' }>, ctx),
);
repositories.register('gitlab', (config, ctx) =>
  new GitlabRepository(config as Extract<RepositoryConfig, { kind: 'gitlab' }>, ctx),
);
repositories.register('bitbucket', (config, ctx) =>
  new BitbucketRepository(config as Extract<RepositoryConfig, { kind: 'bitbucket' }>, ctx),
);

export type { RepositoryCtx };
