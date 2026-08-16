<script lang="ts">
  /**
   * One pipeline, when something has gone wrong and you need to know what.
   *
   * The list answers "is it running"; this answers "what happened". So the run rows lead
   * with the outcome and the reason rather than with a timestamp — an operator opening
   * this at 9am is looking for the failures, not reading a log from the top.
   *
   * **A held-back result links out to the user's own screen.** Corral does not know their
   * data model and will not try to render a record it cannot interpret (D14). It knows
   * which run was doubtful and where they said a person can look.
   */
  import { onMount } from 'svelte';
  import Button from './lib/Button.svelte';
  import PageHeader from './lib/PageHeader.svelte';
  import * as api from './lib/api';
  import { t } from './lib/i18n.svelte';
  import { toast } from './lib/toast.svelte';

  interface Props {
    pipelineKey: string;
  }
  let { pipelineKey }: Props = $props();

  const FILTERS = [
    { key: '', label: 'detail.all' },
    { key: 'completed', label: 'detail.completed' },
    { key: 'reported', label: 'detail.reported' },
    { key: 'skipped', label: 'detail.skipped' },
  ] as const;
  /** Failures are four outcomes; the filter offers them as one because that is how an
   *  operator thinks about them. */
  const FAILURES = ['input_failed', 'agent_failed', 'rejected', 'output_failed'];

  let runs = $state<api.OpsRun[]>([]);
  let totals = $state<api.OpsDailyTotals[]>([]);
  let filter = $state('');
  let days = $state(7);
  let online = $state(false);
  let loading = $state(true);

  const shown = $derived(
    filter === 'failed' ? runs.filter((r) => FAILURES.includes(r.outcome)) : filter ? runs.filter((r) => r.outcome === filter) : runs,
  );
  const today = $derived(totals[0]);
  const period = $derived(
    totals.reduce(
      (acc, d) => ({ runs: acc.runs + d.runs, tokens: acc.tokens + d.tokens, costUsd: acc.costUsd + d.costUsd }),
      { runs: 0, tokens: 0, costUsd: 0 },
    ),
  );

  async function refresh() {
    try {
      // Filtering client-side: a day is at most a few hundred runs for one pipeline, and
      // one fetch keeps the tabs instant instead of a round trip per click.
      const [r, tt] = await Promise.all([api.getRuns({ days, pipeline: pipelineKey, limit: 500 }), api.getTotals(days)]);
      runs = r.runs;
      totals = tt.totals;
      online = true;
    } catch {
      online = false;
    } finally {
      loading = false;
    }
  }

  async function run() {
    const r = await api.runPipeline(pipelineKey);
    if (!r.ok) toast(r.error ?? `${r.run?.outcome ?? 'failed'} — ${r.run?.reason ?? ''}`, 'error');
    await refresh();
  }

  onMount(() => {
    void refresh();
    const unsub = api.subscribeEvents((e) => {
      if (e.kind === 'run' && e.data?.pipeline === pipelineKey) void refresh();
    });
    return unsub;
  });

  const time = (ms: number) => new Date(ms).toLocaleTimeString();
  const day = (ms: number) => new Date(ms).toLocaleDateString();
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const failed = (o: string) => FAILURES.includes(o);
</script>

<PageHeader title={pipelineKey} {online} meta={today ? `${today.runs} ${t('ops.today')}` : ''}>
  <a class="ghost back" href="#/">{t('detail.back')}</a>
  <Button onclick={run}>{t('ops.run')}</Button>
</PageHeader>

<main>
  <section>
    <h2>{t('detail.totals')}</h2>
    <div class="cards">
      <div class="stat"><span class="n">{period.runs}</span><span class="l">{t('detail.runs')} ({days}{t('detail.days')})</span></div>
      <div class="stat"><span class="n">{period.tokens.toLocaleString()}</span><span class="l">{t('detail.tokens')}</span></div>
      <div class="stat"><span class="n">${period.costUsd.toFixed(4)}</span><span class="l">{t('detail.cost')}</span></div>
      <div class="stat"><span class="n">{totals.reduce((a, d) => a + d.failed, 0)}</span><span class="l">{t('detail.failures')}</span></div>
      <div class="stat"><span class="n">{totals.reduce((a, d) => a + d.lowConfidence, 0)}</span><span class="l">{t('detail.held')}</span></div>
    </div>
    <p class="hint">{t('detail.costHint')}</p>
  </section>

  <section>
    <div class="hdr">
      <h2>{t('detail.runsTitle')}</h2>
      <div class="tabs">
        {#each FILTERS as f}
          <button class="tab" class:on={filter === f.key} onclick={() => (filter = f.key)}>{t(f.label)}</button>
        {/each}
        <button class="tab" class:on={filter === 'failed'} onclick={() => (filter = 'failed')}>{t('detail.failed')}</button>
      </div>
    </div>

    {#if !loading && shown.length === 0}
      <p class="dim">{t('detail.none')}</p>
    {:else}
      {#each shown as r (r.id)}
        <div class="run" class:bad={failed(r.outcome)}>
          <span class="when" title={day(r.startedAt)}>{time(r.startedAt)}</span>
          <span class="outcome" class:bad={failed(r.outcome)} class:held={r.outcome === 'reported'}>
            {t(`detail.outcome.${r.outcome}`)}{#if r.stage && failed(r.outcome)}<span class="stage">{r.stage}</span>{/if}
          </span>
          <span class="reason">{r.reason ?? ''}</span>
          <span class="meta">
            {#if r.provider}<span>{r.provider}{#if r.failedOver}<span class="over" title={t('detail.failedOver')}>↷</span>{/if}</span>{/if}
            {#if r.tokens}<span>{r.tokens.toLocaleString()}t</span>{/if}
            <span>{seconds(r.durationMs)}</span>
          </span>
          {#if r.reviewUrl}
            <!-- Their screen, not ours: corral knows which run was doubtful, not what the
                 record means. -->
            <a class="review" href={r.reviewUrl} target="_blank" rel="noreferrer">{t('detail.review')} ↗</a>
          {/if}
        </div>
      {/each}
    {/if}
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
  .hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .hdr h2 {
    margin: 0;
  }
  .back {
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-dim);
    font-size: 12px;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 10px;
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 14px 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .stat .n {
    font-size: 18px;
    color: var(--text);
  }
  .stat .l {
    font-size: 11px;
    color: var(--text-dim);
  }
  .tabs {
    display: flex;
    gap: 4px;
  }
  .tab {
    padding: 3px 10px;
    font-size: 12px;
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
  }
  .tab.on {
    border-color: var(--accent);
    color: var(--text);
  }
  .run {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 6px;
    font-size: 12px;
  }
  .run.bad {
    border-color: color-mix(in srgb, var(--red, #f85149) 45%, var(--border));
  }
  .when {
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .outcome {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--text);
    white-space: nowrap;
  }
  .outcome.bad {
    color: var(--red, #f85149);
  }
  .outcome.held {
    color: var(--amber, #d29922);
  }
  .stage {
    padding: 0 5px;
    border-radius: 4px;
    background: var(--surface-2);
    color: var(--text-dim);
    font-size: 11px;
  }
  .reason {
    flex: 1;
    min-width: 0;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    display: inline-flex;
    gap: 10px;
    color: var(--text-dim);
    white-space: nowrap;
  }
  .over {
    color: var(--amber, #d29922);
    margin-left: 3px;
  }
  .review {
    color: var(--accent);
    white-space: nowrap;
  }
  .dim {
    color: var(--text-dim);
    font-size: 13px;
  }
  .hint {
    color: var(--text-dim);
    font-size: 11px;
    margin: 8px 0 0;
  }
</style>
