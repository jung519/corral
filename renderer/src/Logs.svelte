<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from './lib/i18n.svelte';
  import * as api from './lib/api';
  import type { CorralEvent } from './lib/types';

  let events: CorralEvent[] = $state([]);

  async function refresh() {
    try {
      events = (await api.getState()).events;
    } catch {
      /* offline */
    }
  }

  onMount(() => {
    void refresh();
    const unsub = api.subscribeEvents((e) => (events = [...events, e].slice(-1000)));
    return unsub;
  });

  function ts(ms: number): string {
    return new Date(ms).toLocaleTimeString();
  }
</script>

<div class="view">
  <h1>{t('logs.title')}</h1>
  {#if events.length === 0}
    <p class="dim">{t('logs.empty')}</p>
  {:else}
    <div class="log">
      {#each events.slice().reverse() as e}
        <div class="row">
          <span class="time">{ts(e.ts)}</span>
          <span class="id">{e.identifier}</span>
          <span class="kind kind-{e.kind}">{e.kind}</span>
          <span class="label">{e.label}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .view {
    max-width: 900px;
    margin: 0 auto;
    padding: 24px;
  }
  h1 {
    font-size: 18px;
    margin: 0 0 16px;
  }
  .dim {
    color: var(--text-dim);
  }
  .log {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 14px;
    font-size: 13px;
  }
  .row {
    display: flex;
    gap: 10px;
    padding: 3px 0;
    border-bottom: 1px solid var(--border);
    align-items: baseline;
  }
  .time,
  .id {
    color: var(--text-dim);
    white-space: nowrap;
  }
  .kind {
    font-size: 11px;
    text-transform: uppercase;
    color: var(--text-dim);
    min-width: 64px;
  }
  .kind-error {
    color: var(--red);
  }
  .kind-approval {
    color: var(--amber);
  }
  .label {
    flex: 1;
  }
</style>
