<script lang="ts">
  /**
   * The operations mode's landing screen.
   *
   * Deliberately plain for now: what is registered, whether it is on, and what makes it
   * fire. The dashboard proper — today's usage against the shared ceiling, live run
   * status, per-pipeline counts, manual runs — is its own issue; this exists so the mode
   * you switch into is a real place with real data rather than an empty frame.
   */
  import { onMount } from 'svelte';
  import * as api from './lib/api';
  import { t } from './lib/i18n.svelte';

  let pipelines = $state<api.OpsPipeline[]>([]);
  let error = $state<string | undefined>();
  let loading = $state(true);

  async function refresh() {
    try {
      const res = await api.getPipelines();
      pipelines = res.pipelines;
      error = res.error;
    } catch (err) {
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

  onMount(refresh);
</script>

<div class="view">
  <div class="hdr">
    <h2>{t('nav.pipelines')}</h2>
    <button onclick={reload} disabled={loading}>{t('ops.reload')}</button>
  </div>

  {#if error}
    <!-- A broken definition file leaves the list empty; saying why beats an empty page. -->
    <pre class="err">{error}</pre>
  {/if}

  {#if !loading && pipelines.length === 0}
    <div class="card empty">
      <p>{t('ops.none')}</p>
      <p class="hint">{t('ops.noneHint')}</p>
    </div>
  {:else}
    {#each pipelines as p}
      <div class="card row">
        <span class="dot" class:on={p.enabled}></span>
        <span class="key">{p.key}</span>
        <span class="desc">{p.description ?? ''}</span>
        <span class="trigger">{p.trigger}</span>
        <span class="state">{p.enabled ? t('ops.enabled') : t('ops.disabled')}</span>
      </div>
    {/each}
  {/if}
</div>

<style>
  .view {
    padding: 24px 28px;
    max-width: 900px;
  }
  .hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
  }
  h2 {
    font-size: 14px;
    margin: 0;
    color: var(--text);
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 16px;
    margin-bottom: 8px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 13px;
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
  .empty p {
    margin: 0 0 4px;
    font-size: 13px;
  }
  .hint {
    color: var(--text-dim);
    font-size: 12px;
  }
  .err {
    color: var(--red, #f85149);
    font-size: 12px;
    white-space: pre-wrap;
    margin: 0 0 12px;
  }
</style>
