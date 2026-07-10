<script lang="ts">
  import { onMount, tick } from 'svelte';
  import ApprovalCard from './ApprovalCard.svelte';
  import PhaseBar from './PhaseBar.svelte';
  import PipelineSummary from './PipelineSummary.svelte';
  import Button from './lib/Button.svelte';
  import { t } from './lib/i18n.svelte';
  import * as api from './lib/api';
  import { phaseActivity, phaseColor, phaseLabelKey } from './lib/phase';
  import { toast } from './lib/toast.svelte';
  import type { Candidate, CorralEvent, StateResponse } from './lib/types';
  import { loadDraft, type WizardState } from './lib/wizard';

  let view: StateResponse = $state({ issues: [], pending: [], events: [] });
  let live: CorralEvent[] = $state([]);
  let candidates: Candidate[] = $state([]);
  let candCursor = $state<string | undefined>(undefined);
  let candLoading = $state(false);
  let candListEl = $state<HTMLElement | undefined>(undefined);
  let showCandidates = $state(false);
  let online = $state(false);
  let configured = $state<boolean | undefined>(undefined);
  let draft = $state<WizardState | null>(null);

  async function refresh() {
    try {
      view = await api.getState();
      live = view.events.slice(-200);
      online = true;
    } catch {
      online = false;
    }
  }

  onMount(() => {
    void refresh();
    void api.isConfigured().then((c) => (configured = c));
    void loadDraft().then((d) => (draft = d));
    const unsub = api.subscribeEvents(() => void refresh());
    const poll = setInterval(() => void refresh(), 15000);
    return () => {
      unsub();
      clearInterval(poll);
    };
  });

  async function openCandidates() {
    if (configured === false) {
      toast(t('dash.setupNeeded'), 'error');
      location.hash = '#/setup';
      return;
    }
    const r = await api.getCandidates();
    candidates = r.candidates;
    candCursor = r.nextCursor;
    showCandidates = true;
    void fillIfNeeded();
  }
  // Infinite scroll: fetch the next ID-ascending page and append (deduped).
  async function loadMoreCandidates() {
    if (!candCursor || candLoading) return;
    candLoading = true;
    try {
      const r = await api.getCandidates(candCursor);
      const seen = new Set(candidates.map((c) => c.identifier));
      candidates = [...candidates, ...r.candidates.filter((c) => !seen.has(c.identifier))];
      candCursor = r.nextCursor;
    } finally {
      candLoading = false;
    }
  }
  // If a page doesn't overflow the list, there's no scrollbar to trigger more — keep
  // pulling pages until the list is scrollable or the tracker is exhausted.
  async function fillIfNeeded() {
    await tick();
    if (candListEl && candCursor && !candLoading && candListEl.scrollHeight <= candListEl.clientHeight + 4) {
      await loadMoreCandidates();
      await fillIfNeeded();
    }
  }
  async function onCandScroll(e: Event) {
    const el = e.currentTarget as HTMLElement;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) {
      await loadMoreCandidates();
      await fillIfNeeded();
    }
  }
  async function start(id: string) {
    const r = await api.startIssue(id);
    if (!r.ok && r.message) toast(r.message, 'error');
    showCandidates = false;
    void refresh();
  }
  async function complete(id: string) {
    const r = await api.completeIssue(id);
    if (r.ok) toast(`${id} — done`, 'success');
    else if (r.message) toast(r.message, 'error');
    void refresh();
  }
  async function retry(id: string) {
    await api.retryIssue(id);
    void refresh();
  }
  async function remove(id: string) {
    if (!confirm(t('dash.removeConfirm').replace('{id}', id))) return;
    const r = await api.removeIssue(id);
    if (r.ok) toast(`${id} — removed`, 'success');
    else if (r.message) toast(r.message, 'error');
    void refresh();
  }
  async function restart(id: string) {
    if (!confirm(t('dash.restartConfirm').replace('{id}', id))) return;
    const r = await api.restartIssue(id);
    if (!r.ok && r.message) toast(r.message, 'error');
    void refresh();
  }
  function onApprove(id: string, selection?: string, notes?: string) {
    return api.approve(id, selection, notes).then(refresh);
  }
  function onFeedback(id: string, text: string) {
    return api.feedback(id, text).then(refresh);
  }
</script>

<header>
  <span class="dot" class:on={online}></span>
  <h1>Corral</h1>
  <span class="count">{view.issues.length} {t('dash.count')}</span>
  <Button class="primary" onclick={openCandidates}>{t('dash.import')}</Button>
</header>

<main>
  {#if configured === false}
    <div class="setup-banner">
      <span>{t('dash.setupNeeded')}</span>
      <button class="primary" onclick={() => (location.hash = '#/setup')}>{t('dash.setupBtn')}</button>
    </div>
  {:else if draft}
    <PipelineSummary s={draft} />
  {/if}

  {#if view.pending.length > 0}
    <section>
      <h2>{t('dash.actionNeeded')}</h2>
      {#each view.pending as action (action.id)}
        <ApprovalCard {action} {onApprove} {onFeedback} />
      {/each}
    </section>
  {/if}

  <section>
    <h2>{t('dash.issues')}</h2>
    {#if view.issues.length === 0}
      <p class="dim">{t('dash.empty')}</p>
    {/if}
    {#each view.issues as issue (issue.identifier)}
      <div class="issue">
        <div class="issue-head">
          <strong>{issue.identifier}</strong>
          <span class="title">{issue.title ?? ''}</span>
          {#if !issue.stuck && phaseActivity(issue.phase) === 'working'}
            <span class="working" title={t('dash.working')}><span class="spin" aria-hidden="true"></span>{t('dash.working')}</span>
          {:else if !issue.stuck && phaseActivity(issue.phase) === 'waiting'}
            <span class="waiting" title={t('dash.waiting')}><span class="pulse" aria-hidden="true"></span>{t('dash.waiting')}</span>
          {/if}
          <span class="phase" style:color={phaseColor(issue.phase)}>{t(phaseLabelKey(issue.phase))}</span>
          <span class="cost">${issue.cost.toFixed(4)}</span>
        </div>
        <div class="bar-row"><PhaseBar phase={issue.phase} /></div>
        <div class="issue-actions">
          {#if issue.url}<a href={issue.url} target="_blank" rel="noreferrer">{t('dash.tracker')} ↗</a>{/if}
          {#each issue.prs ?? [] as pr}
            {#if pr.url}<a href={pr.url} target="_blank" rel="noreferrer">PR #{pr.number} ({pr.repoKey}) ↗</a>{/if}
          {/each}
          {#if issue.prs?.length}<Button onclick={() => complete(issue.identifier)}>{t('dash.complete')}</Button>{/if}
          {#if issue.stuck}<Button onclick={() => retry(issue.identifier)}>{t('dash.retry')}</Button>{/if}
          <Button onclick={() => restart(issue.identifier)}>{t('dash.restart')}</Button>
          <Button onclick={() => remove(issue.identifier)}>{t('dash.remove')}</Button>
        </div>
      </div>
    {/each}
  </section>

  <section>
    <h2>{t('dash.timeline')}</h2>
    <div class="timeline">
      {#each live.slice().reverse() as e}
        <div class="event" title={e.label}><span class="ev-id">{e.identifier}</span> {e.label}</div>
      {/each}
    </div>
  </section>
</main>

{#if showCandidates}
  <div
    class="overlay"
    role="presentation"
    onclick={() => (showCandidates = false)}
    onkeydown={(e) => {
      if (e.key === 'Escape') showCandidates = false;
    }}
  >
    <div class="modal" role="dialog" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
      <h2>{t('dash.candidates')}</h2>
      {#if candidates.length === 0 && !candLoading}<p class="dim">{t('dash.none')}</p>{/if}
      <div class="cand-list" bind:this={candListEl} onscroll={onCandScroll}>
        {#each candidates as c (c.identifier)}
          <div class="candidate">
            <span><strong>{c.identifier}</strong> {c.title}</span>
            {#if c.inFlight}
              <span class="dim">{t('dash.inFlight')}</span>
            {:else}
              <Button class="primary" onclick={() => start(c.identifier)}>{t('dash.start')}</Button>
            {/if}
          </div>
        {/each}
        {#if candLoading}<p class="dim center">{t('dash.loadingMore')}</p>{/if}
      </div>
      <button onclick={() => (showCandidates = false)}>{t('dash.close')}</button>
    </div>
  </div>
{/if}

<style>
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 22px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  header h1 {
    font-size: 18px;
    margin: 0;
  }
  .count {
    color: var(--text-dim);
  }
  header :global(button.primary) {
    margin-left: auto;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--red);
  }
  .dot.on {
    background: var(--green);
  }
  main {
    padding: 20px 28px;
  }
  .setup-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    background: var(--surface);
    border: 1px solid var(--amber);
    border-radius: var(--radius);
    padding: 12px 16px;
    margin-top: 4px;
    color: var(--amber);
  }
  h2 {
    font-size: 14px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: 20px 0 10px;
  }
  .dim {
    color: var(--text-dim);
  }
  .issue {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 14px;
    margin-bottom: 10px;
  }
  .issue-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .issue-head .title {
    flex: 1;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .phase {
    background: var(--surface-2);
    border-radius: 6px;
    padding: 2px 8px;
    font-size: 11px;
  }
  .working {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--accent-text);
    font-size: 11px;
  }
  .spin {
    width: 11px;
    height: 11px;
    flex-shrink: 0;
    border-radius: 50%;
    border: 2px solid currentColor;
    border-top-color: transparent;
    animation: corral-spin 0.6s linear infinite;
  }
  @keyframes corral-spin {
    to {
      transform: rotate(360deg);
    }
  }
  /* Awaiting a human/external action — still in flight, but not the agent working. */
  .waiting {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--amber, #d29922);
    font-size: 11px;
  }
  .pulse {
    width: 9px;
    height: 9px;
    flex-shrink: 0;
    border-radius: 50%;
    background: currentColor;
    animation: corral-pulse 1.1s ease-in-out infinite;
  }
  @keyframes corral-pulse {
    0%,
    100% {
      opacity: 0.35;
      transform: scale(0.85);
    }
    50% {
      opacity: 1;
      transform: scale(1.1);
    }
  }
  .cost {
    color: var(--text-dim);
    font-size: 12px;
  }
  .bar-row {
    margin: 10px 0;
  }
  .issue-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .timeline {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 14px;
    max-height: 280px;
    overflow: auto;
  }
  .event {
    font-size: 13px;
    padding: 2px 0;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis; /* widen the window → more text shows; hover for full */
  }
  .ev-id {
    color: var(--text-dim);
    margin-right: 8px;
  }
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px 20px;
    width: 560px;
    max-height: 70vh;
    overflow: auto;
  }
  .cand-list {
    max-height: 55vh;
    overflow-y: auto;
  }
  .center {
    text-align: center;
    padding: 8px 0;
  }
  .candidate {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
</style>
