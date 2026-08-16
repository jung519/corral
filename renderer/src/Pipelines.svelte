<script lang="ts">
  /**
   * The operations mode's landing screen.
   *
   * Built on the same bones as the development dashboard — a `header` with the connection
   * dot and a count, `main` split into labelled sections, one row per thing, a live
   * timeline at the bottom. Both pillars are the same app, and a screen that invented its
   * own layout would read as a different product bolted on.
   *
   * The dashboard proper — today's usage against the shared ceiling, per-pipeline run
   * counts, manual runs — is its own issue. What is here is what the core can already
   * answer.
   */
  import { onMount } from 'svelte';
  import Button from './lib/Button.svelte';
  import PageHeader from './lib/PageHeader.svelte';
  import * as api from './lib/api';
  import { t } from './lib/i18n.svelte';
  import type { CorralEvent } from './lib/types';

  let pipelines = $state<api.OpsPipeline[]>([]);
  let error = $state<string | undefined>();
  let online = $state(false);
  let loading = $state(true);
  let live = $state<CorralEvent[]>([]);

  async function refresh() {
    try {
      const res = await api.getPipelines();
      pipelines = res.pipelines;
      error = res.error;
      online = true;
    } catch (err) {
      online = false;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  async function reload() {
    loading = true;
    await api.reloadPipelines().catch(() => {});
    await refresh();
  }

  onMount(() => {
    void refresh();
    // Runs are seconds long and there are many; the timeline is how you see the thing
    // working at all without opening a log file.
    const unsub = api.subscribeEvents((e) => {
      if (e.kind !== 'run') return;
      live = [...live, e].slice(-200);
      void refresh();
    });
    const poll = setInterval(() => void refresh(), 15000);
    return () => {
      unsub();
      clearInterval(poll);
    };
  });
</script>

<PageHeader title={t('nav.pipelines')} {online} meta="{pipelines.length} {t('ops.count')}">
  <Button onclick={reload} disabled={loading}>{t('ops.reload')}</Button>
</PageHeader>

<main>
  {#if error}
    <!-- A broken definition file leaves the list empty; saying why beats an empty page. -->
    <div class="setup-banner"><span>{error}</span></div>
  {/if}

  <section>
    <h2>{t('nav.pipelines')}</h2>
    {#if !loading && pipelines.length === 0}
      <p class="dim">{t('ops.none')}</p>
      <p class="dim small">{t('ops.noneHint')}</p>
    {:else}
      {#each pipelines as p (p.key)}
        <div class="row">
          <span class="dot" class:on={p.enabled}></span>
          <span class="key">{p.key}</span>
          <span class="desc">{p.description ?? ''}</span>
          {#if p.activeRuns > 0}
            <span class="working"><span class="spin" aria-hidden="true"></span>{p.activeRuns}</span>
          {/if}
          <span class="trigger">{p.trigger}</span>
          <span class="state">{p.enabled ? t('ops.enabled') : t('ops.disabled')}</span>
        </div>
      {/each}
    {/if}
  </section>

  <section>
    <h2>{t('dash.timeline')}</h2>
    <div class="timeline">
      {#each live.slice().reverse() as e}
        <div class="event" title={e.label}><span class="ev-id">{String(e.data?.pipeline ?? e.identifier)}</span> {e.label}</div>
      {/each}
    </div>
  </section>
</main>

<style>
  main {
    padding: 18px 22px;
  }
  section {
    margin-bottom: 22px;
  }
  h2 {
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-dim);
    margin: 0 0 10px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-dim);
    flex: none;
  }
  .dot.on {
    background: var(--green, #3fb950);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 8px;
    font-size: 13px;
  }
  .key {
    font-weight: 500;
    color: var(--text);
  }
  .desc {
    flex: 1;
    min-width: 0;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .trigger,
  .state {
    color: var(--text-dim);
    font-size: 12px;
  }
  .working {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: var(--accent);
  }
  .spin {
    width: 8px;
    height: 8px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .dim {
    color: var(--text-dim);
    font-size: 13px;
    margin: 0 0 4px;
  }
  .small {
    font-size: 12px;
  }
  .setup-banner {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    margin-bottom: 16px;
    border: 1px solid var(--red, #f85149);
    border-radius: var(--radius);
    color: var(--red, #f85149);
    font-size: 12px;
    white-space: pre-wrap;
  }
  .timeline {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 14px;
    max-height: 240px;
    overflow: auto;
    font-size: 12px;
  }
  .event {
    padding: 2px 0;
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ev-id {
    color: var(--text);
    margin-right: 6px;
  }
</style>
