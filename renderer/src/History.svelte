<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from './lib/i18n.svelte';
  import * as api from './lib/api';
  import type { HistoryRecord } from './lib/types';

  let records: HistoryRecord[] = $state([]);
  let filter = $state<'' | 'completed' | 'removed' | 'failed'>('');
  let expanded = $state<string | null>(null);
  let loading = $state(true);

  async function refresh() {
    loading = true;
    try {
      records = await api.getHistory(filter || undefined);
    } catch {
      /* offline */
    } finally {
      loading = false;
    }
  }

  onMount(refresh);

  function setFilter(f: typeof filter) {
    filter = f;
    void refresh();
  }

  // "1h 40m" / "45m 34s" / "12s"
  function dur(ms: number): string {
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${sec}s`;
    return `${sec}s`;
  }
  function when(ms: number): string {
    return new Date(ms).toLocaleString();
  }
  const tabs: Array<{ key: typeof filter; label: string }> = [
    { key: '', label: 'history.all' },
    { key: 'completed', label: 'history.completed' },
    { key: 'removed', label: 'history.removed' },
    { key: 'failed', label: 'history.failed' },
  ];
  const outcomeLabel = (o: string) => t(`history.${o}`);
</script>

<div class="view">
  <div class="head">
    <div>
      <h1>{t('history.title')}</h1>
      <p class="dim">{t('history.subtitle')}</p>
    </div>
    <button class="ghost" onclick={refresh}>↻ {t('history.refresh')}</button>
  </div>

  <div class="tabs">
    {#each tabs as tab}
      <button class="tab" class:on={filter === tab.key} onclick={() => setFilter(tab.key)}>{t(tab.label)}</button>
    {/each}
  </div>

  {#if loading && records.length === 0}
    <p class="dim">…</p>
  {:else if records.length === 0}
    <p class="dim">{t('history.empty')}</p>
  {:else}
    <div class="list">
      {#each records as r (r.identifier + r.endedAt)}
        <div class="card" class:open={expanded === r.identifier + r.endedAt}>
          <button class="row" onclick={() => (expanded = expanded === r.identifier + r.endedAt ? null : r.identifier + r.endedAt)}>
            <span class="badge b-{r.outcome}">{outcomeLabel(r.outcome)}</span>
            <span class="id">{r.identifier}</span>
            <span class="title" title={r.title}>{r.title ?? ''}</span>
            <span class="metrics">
              <span title={t('history.wall')}>⏱ {dur(r.wallMs)}</span>
              <span title={t('history.agent')}>🤖 {dur(r.agentActiveMs)}</span>
              <span title={t('history.cost')}>${r.costUsd.toFixed(2)}</span>
            </span>
            <span class="date">{when(r.startedAt)}</span>
          </button>

          {#if expanded === r.identifier + r.endedAt}
            <div class="detail">
              <div class="bars">
                {@render bar(t('history.wall'), r.wallMs, r.wallMs)}
                {@render bar(t('history.agent'), r.agentActiveMs, r.wallMs, 'ai')}
                {@render bar(t('history.wait'), r.humanWaitMs + r.setupMs, r.wallMs, 'wait')}
              </div>
              {#if r.phases.length}
                <div class="phases">
                  {#each r.phases as p}
                    <span class="phase"><b>{p.phase}</b> {dur(p.durationMs)}</span>
                  {/each}
                </div>
              {/if}
              <div class="facts">
                <span>{t('history.started')}: {when(r.startedAt)}</span>
                <span>{t('history.dispatches')}: {r.dispatches}</span>
                <span>{t('history.tokens')}: {r.inputTokens.toLocaleString()} / {r.outputTokens.toLocaleString()}</span>
                <span>{t('history.repos')}: {r.repoKeys.join(', ')}</span>
                <span>{r.backend} · {r.agentProvider}{r.failoverUsed ? ` · ${t('history.failover')}` : ''}</span>
                {#if r.prs.length}
                  <span>{t('history.prs')}:
                    {#each r.prs as pr}
                      {#if pr.url}<a href={pr.url} target="_blank" rel="noreferrer">{pr.repoKey}#{pr.number}</a>{:else}{pr.repoKey}#{pr.number}{/if}
                    {/each}
                  </span>
                {/if}
              </div>
              {#if r.qa?.length}
                <div class="qa">
                  <div class="qa-head">{t('history.qa')} · {r.qa.length}</div>
                  {#each r.qa as x (x.ts)}
                    <div class="qa-item">
                      <div class="qa-q"><b>Q</b> {x.q}</div>
                      <div class="qa-a"><b>A</b> {x.a}</div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

{#snippet bar(label: string, ms: number, total: number, kind = 'total')}
  <div class="barrow">
    <span class="blabel">{label}</span>
    <div class="track"><div class="fill f-{kind}" style:width={`${total ? Math.min(100, (ms / total) * 100) : 0}%`}></div></div>
    <span class="bval">{dur(ms)}</span>
  </div>
{/snippet}

<style>
  .view {
    padding: 24px 28px;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }
  h1 {
    font-size: 18px;
    margin: 0 0 4px;
  }
  .dim {
    color: var(--text-dim);
    margin: 0 0 12px;
    font-size: 13px;
  }
  .ghost {
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 8px;
    padding: 6px 12px;
    cursor: pointer;
    font-size: 13px;
  }
  .tabs {
    display: flex;
    gap: 6px;
    margin: 8px 0 16px;
  }
  .tab {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-dim);
    border-radius: 999px;
    padding: 4px 14px;
    cursor: pointer;
    font-size: 13px;
  }
  .tab.on {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    background: transparent;
    border: none;
    color: var(--text);
    cursor: pointer;
    text-align: left;
    font-size: 13px;
  }
  .row:hover {
    background: var(--surface-2);
  }
  .badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    white-space: nowrap;
  }
  .b-completed {
    background: color-mix(in srgb, var(--green, #3fb950) 22%, transparent);
    color: var(--green, #3fb950);
  }
  .b-removed {
    background: var(--surface-2);
    color: var(--text-dim);
  }
  .b-failed {
    background: color-mix(in srgb, var(--red, #f85149) 22%, transparent);
    color: var(--red, #f85149);
  }
  .id {
    color: var(--text-dim);
    white-space: nowrap;
  }
  .title {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .metrics {
    display: flex;
    gap: 12px;
    white-space: nowrap;
    color: var(--text-dim);
  }
  .date {
    color: var(--text-dim);
    white-space: nowrap;
    font-size: 12px;
  }
  .detail {
    padding: 4px 16px 16px;
    border-top: 1px solid var(--border);
    font-size: 13px;
  }
  .bars {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 12px 0;
  }
  .barrow {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .blabel {
    width: 80px;
    color: var(--text-dim);
  }
  .track {
    flex: 1;
    height: 8px;
    background: var(--surface-2);
    border-radius: 999px;
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--text-dim);
  }
  .f-ai {
    background: var(--accent);
  }
  .f-wait {
    background: var(--amber, #d29922);
  }
  .bval {
    width: 80px;
    text-align: right;
    color: var(--text-dim);
  }
  .phases {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 8px 0;
  }
  .phase {
    background: var(--surface-2);
    border-radius: 6px;
    padding: 2px 8px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
    margin-top: 8px;
    color: var(--text-dim);
  }
  .facts a {
    color: var(--accent);
  }
  .qa {
    margin-top: 12px;
    border-top: 1px solid var(--border);
    padding-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .qa-head {
    font-size: 12px;
    color: var(--text-dim);
  }
  .qa-item {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 13px;
    line-height: 1.55;
  }
  .qa-q b,
  .qa-a b {
    color: var(--accent);
    margin-right: 4px;
  }
  .qa-a {
    color: var(--text-dim);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
