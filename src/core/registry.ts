/**
 * Generic adapter registry — replaces upstream's hardcoded `switch (kind)` factories.
 *
 * Each axis (tracker / repository / agent / workspace / channel) owns one Registry.
 * Reference adapters register themselves at startup; external adapters can register
 * through the same surface (the basis for `@corral/sdk` plugins, later).
 *
 *   const trackers = new Registry<TrackerConfig, TrackerAdapter, TrackerCtx>('tracker');
 *   trackers.register('notion', (cfg, ctx) => new NotionTracker(cfg, ctx));
 *   const tracker = trackers.create(config.tracker, ctx);
 *
 * TConfig must carry a `kind` discriminator (matches the zod discriminatedUnion).
 */
export type AdapterFactory<TConfig, TAdapter, TCtx> = (config: TConfig, ctx: TCtx) => TAdapter;

export class Registry<TConfig extends { kind: string }, TAdapter, TCtx = void> {
  private readonly factories = new Map<string, AdapterFactory<TConfig, TAdapter, TCtx>>();

  /** Human-readable axis name, used only in error messages. */
  constructor(private readonly axis: string) {}

  /** Register a factory for a `kind`. Throws on duplicate registration. */
  register(kind: string, factory: AdapterFactory<TConfig, TAdapter, TCtx>): this {
    if (this.factories.has(kind)) {
      throw new Error(`${this.axis} adapter already registered for kind "${kind}"`);
    }
    this.factories.set(kind, factory);
    return this;
  }

  /** Instantiate the adapter selected by `config.kind`. Throws on unknown kind. */
  create(config: TConfig, ctx: TCtx): TAdapter {
    const factory = this.factories.get(config.kind);
    if (!factory) {
      const known = this.kinds().join(', ') || '(none registered)';
      throw new Error(`unknown ${this.axis} adapter kind "${config.kind}"; registered: ${known}`);
    }
    return factory(config, ctx);
  }

  has(kind: string): boolean {
    return this.factories.has(kind);
  }

  kinds(): string[] {
    return [...this.factories.keys()];
  }
}
