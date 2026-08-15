/**
 * The trigger registry and the reference adapters, wired the same way the other five axes
 * are: register by `kind` at startup, then `create` from the definition.
 */
import { Registry } from '../../core/registry.js';
import type { PipelineTrigger } from '../pipeline/schema.js';
import { ManualTrigger } from './manual.js';
import { PubSubTrigger, type PubSubContext } from './pubsub.js';
import { ScheduleTrigger } from './schedule.js';
import type { TriggerAdapter } from './types.js';

export const triggerRegistry = new Registry<PipelineTrigger, TriggerAdapter, PubSubContext>('trigger');

triggerRegistry.register('manual', (_config, ctx) => new ManualTrigger(ctx));
triggerRegistry.register('schedule', (_config, ctx) => new ScheduleTrigger(ctx));
triggerRegistry.register('pubsub', (_config, ctx) => new PubSubTrigger(ctx));

export { ManualTrigger } from './manual.js';
export { ScheduleTrigger } from './schedule.js';
export { PubSubTrigger, type PubSubContext } from './pubsub.js';
export { GoogleTokenSource, parseServiceAccountKey, signAssertion } from './google-auth.js';
export { cronMatches, parseCron } from './cron.js';
export type { FireFn, StopFn, TriggerAdapter, TriggerContext } from './types.js';
