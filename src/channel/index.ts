/** Channel axis registry. Keyed by `web` | `slack`. */
import { Registry } from '../core/registry.js';
import type { ChannelAdapter } from '../core/types.js';
import { WebChannel } from './web.js';

interface ChannelRegistryConfig {
  kind: string;
  port: number;
}

export const channels = new Registry<ChannelRegistryConfig, ChannelAdapter>('channel');

channels.register('web', () => new WebChannel());
// slack adapter is lifted in a later milestone.
