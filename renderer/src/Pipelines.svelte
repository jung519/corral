<script lang="ts">
  /**
   * The operations dashboard. One row per pipeline.
   *
   * Same bones as the development dashboard — shared header, labelled sections, a live
   * timeline — because both pillars are the same app and a screen that invented its own
   * layout would read as a different product bolted on.
   *
   * The header carries today's token usage even though nothing here may have caused it:
   * the ceiling is shared with the development AI, so a pipeline can stop for a reason
   * that has nothing to do with pipelines, and an operator staring at a stalled list
   * deserves to see that immediately rather than deduce it.
   */
  import { onMount } from 'svelte';
  import PipelineEditor from './PipelineEditor.svelte';
  import Button from './lib/Button.svelte';
  import PageHeader from './lib/PageHeader.svelte';
  import * as api from './lib/api';
  import { t } from './lib/i18n.svelte';
  import { toast } from './lib/toast.svelte';
  import type { CorralEvent } from './lib/types';

  let overview = $state<api.OpsOverview>({ pipelines: [], counts: {} });
  let online = $state(false);
  let loading = $state(true);
  let live = $state<CorralEvent[]>([]);
  let adding = $state(false);

  const budget = $derived(overview.budget);
  const hasLimit = $derived(Boolean(budget?.limits.dailyInputTokens || budget?.limits.dailyOutputTokens));
  const usedPercent = $derived(Math.round((budget?.used ?? 0) * 100));

  async function refresh() {
    try {
      overview = await api.getOverview();
      online = true;
    } catch {
      online = false;
    } finally {
      loading = false;
    }
  }

  async function reload() {
    const r = await api.reloadPipelines().catch(() => ({ loaded: 0, error: 'reload failed' }));
    if (r.error) toast(r.error, 'error');
    await refresh();
  }

  async function run(key: string) {
    const r = await api.runPipeline(key);
    // A manual run is how a pipeline gets tried out, so the reason it stopped matters
    // more than the fact that it did.
    if (!r.ok) toast(r.error ?? `${key}: ${r.run?.outcome ?? 'failed'} — ${r.run?.reason ?? ''}`, 'error');
    else toast(`${key}: ${t('ops.ran')}`);
    await refresh();
  }

  async function toggle(key: string, enabled: boolean) {
    await api.setPipelineEnabled(key, enabled);
    await refresh();
  }

  onMount(() => {
    void refresh();
    // Runs are seconds long and there are many of them; without this the list would only
    // ever be as fresh as the last poll.
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

<PageHeader
  title={t('nav.pipelines')}
  {online}
  meta={hasLimit
    ? `${t('ops.usage')} ${budget?.inputTokens ?? 0}/${budget?.outputTokens ?? 0} · ${usedPercent}%`
    : `${t('ops.usage')} ${budget?.inputTokens ?? 0}/${budget?.outputTokens ?? 0}`}
>
  <button class="ghost" onclick={reload}>{t('ops.reload')}</button>
  <Button class="primary" onclick={() => (adding = true)}>{t('ops.add')}</Button>
</PageHeader>

{#if adding}
  <PipelineEditor
    onclose={() => (adding = false)}
    onsaved={(key) => {
      adding = false;
      toast(`${key}: ${t('ops.added')}`);
      void refresh();
    }}
  />
{/if}

<main>
  {#if hasLimit}
    <div class="budget" class:warn={usedPercent >= 80}>
      <div class="bar"><span style:width="{Math.min(100, usedPercent)}%"></span></div>
      <span class="budget-text">{t('ops.limitUsed')} {usedPercent}%</span>
    </div>
  {/if}

  {#if overview.error}
    <!-- A broken definition file leaves the list empty; saying why beats an empty page. -->
    <div class="banner"><span>{overview.error}</span></div>
  {/if}

  <section>
    <h2>{t('nav.pipelines')}</h2>
    {#if !loading && overview.pipelines.length === 0}
      <div class="empty">
        <p>{t('ops.none')}</p>
        <p class="dim">{t('ops.noneHint')}</p>
        <p class="dim">{t('ops.noneHint2')}</p>
        <p class="add"><Button class="primary" onclick={() => (adding = true)}>{t('ops.add')}</Button></p>
      </div>
    {:else}
      {#each overview.pipelines as p (p.key)}
        {@const c = overview.counts[p.key]}
        <div class="row">
          <span class="dot" class:on={p.enabled}></span>
          <a class="who" href="#/pipeline/{encodeURIComponent(p.key)}">
            <span class="key">{p.key}</span>
            <span class="desc">{p.description ?? ''}</span>
          </a>
          <span class="route">{p.trigger} → {p.provider ?? t('ops.defaultProvider')}</span>

          <span class="counts">
            <span class="today">{c?.runs ?? 0} {t('ops.today')}</span>
            {#if p.activeRuns > 0}
              <span class="working"><span class="spin" aria-hidden="true"></span>{p.activeRuns}</span>
            {/if}
            {#if c?.lowConfidence}<span class="low" title={t('ops.lowConfidence')}>◐ {c.lowConfidence}</span>{/if}
            {#if c?.failed}<span class="failed" title={t('ops.failed')}>✕ {c.failed}</span>{/if}
          </span>

          <span class="actions">
            <Button onclick={() => run(p.key)}>{t('ops.run')}</Button>
            <button class="ghost" onclick={() => toggle(p.key, !p.enabled)}>
              {p.enabled ? t('ops.turnOff') : t('ops.turnOn')}
            </button>
          </span>
        </div>
      {/each}
    {/if}
  </section>

  <section>
    <h2>{t('dash.timeline')}</h2>
    <div class="timeline">
      {#each live.slice().reverse() as e}
        <div class="event" title={e.label}>
          <span class="ev-id">{String(e.data?.pipeline ?? e.identifier)}</span>
          {e.label}
        </div>
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
  .budget {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 16px;
  }
  .bar {
    flex: 1;
    height: 6px;
    border-radius: 999px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .budget.warn .bar span {
    background: var(--red, #f85149);
  }
  .budget-text {
    font-size: 12px;
    color: var(--text-dim);
    white-space: nowrap;
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
  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-decoration: none;
  }
  .who:hover .key {
    color: var(--accent);
  }
  .key {
    font-weight: 500;
    color: var(--text);
  }
  .desc {
    color: var(--text-dim);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .route {
    color: var(--text-dim);
    font-size: 12px;
    white-space: nowrap;
  }
  .counts {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    white-space: nowrap;
  }
  .today {
    color: var(--text-dim);
  }
  .low {
    color: var(--amber, #d29922);
  }
  .failed {
    color: var(--red, #f85149);
  }
  .working {
    display: inline-flex;
    align-items: center;
    gap: 5px;
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
  .actions {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .empty {
    padding: 18px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .empty p {
    margin: 0 0 4px;
    font-size: 13px;
  }
  .add {
    margin-top: 12px;
  }
  .dim {
    color: var(--text-dim);
    font-size: 12px;
  }
  .banner {
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
