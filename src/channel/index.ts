/** Channel axis registry. Keyed by `web` — the only kind the config accepts. */
import { Registry } from '../core/registry.js';
import type { ChannelAdapter } from '../core/types.js';
import { WebChannel } from './web.js';

interface ChannelRegistryConfig {
  kind: string;
}

export const channels = new Registry<ChannelRegistryConfig, ChannelAdapter>('channel');

channels.register('web', () => new WebChannel());
// An axis with one implementation is still an axis: another kind registers here without
// anything above this line changing. The config enum grows at the same time, never before
// (CRL-116).
