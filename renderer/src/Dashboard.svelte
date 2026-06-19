<script lang="ts">
  import { onMount } from 'svelte';
  import ApprovalCard from './ApprovalCard.svelte';
  import * as api from './lib/api';
  import type { Candidate, CorralEvent, StateResponse } from './lib/types';

  // NOTE: never name a reactive variable `state` — `$state` would be parsed as a
  // store auto-subscription. Use `view` for the dashboard snapshot.
  let view: StateResponse = $state({ issues: [], pending: [], events: [] });
  let live: CorralEvent[] = $state([]);
  let candidates: Candidate[] = $state([]);
  let showCandidates = $state(false);
  let online = $state(false);

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
    const unsub = api.subscribeEvents(() => void refresh());
    const poll = setInterval(() => void refresh(), 15000);
    return () => {
      unsub();
      clearInterval(poll);
    };
  });

  async function openCandidates() {
    candidates = await api.getCandidates();
    showCandidates = true;
  }
  async function start(id: string) {
    const r = await api.startIssue(id);
    if (!r.ok && r.message) alert(r.message);
    showCandidates = false;
    void refresh();
  }
  async function complete(id: string) {
    const r = await api.completeIssue(id);
    if (!r.ok && r.message) alert(r.message);
    void refresh();
  }
  async function retry(id: string) {
    await api.retryIssue(id);
    void refresh();
  }
  function onApprove(id: string, selection?: string, notes?: string) {
    void api.approve(id, selection, notes).then(refresh);
  }
  function onFeedback(id: string, text: string) {
    void api.feedback(id, text).then(refresh);
  }
</script>

<header>
  <span class="dot" class:on={online}></span>
  <h1>Corral</h1>
  <span class="count">{view.issues.length} issue(s)</span>
  <button class="primary" onclick={openCandidates}>+ Import issues</button>
</header>

<main>
  {#if view.pending.length > 0}
    <section>
      <h2>Action needed</h2>
      {#each view.pending as action (action.id)}
        <ApprovalCard {action} {onApprove} {onFeedback} />
      {/each}
    </section>
  {/if}

  <section>
    <h2>Issues</h2>
    {#if view.issues.length === 0}
      <p class="dim">No issues in flight. Import one to begin.</p>
    {/if}
    {#each view.issues as issue (issue.identifier)}
      <div class="issue">
        <div class="issue-head">
          <strong>{issue.identifier}</strong>
          <span class="title">{issue.title ?? ''}</span>
          <span class="phase">{issue.phase}</span>
          <span class="cost">${issue.cost.toFixed(4)}</span>
        </div>
        <div class="issue-actions">
          {#if issue.url}<a href={issue.url} target="_blank" rel="noreferrer">tracker</a>{/if}
          {#if issue.pr?.url}<a href={issue.pr.url} target="_blank" rel="noreferrer">PR #{issue.pr.number}</a>{/if}
          {#if issue.pr}<button onclick={() => complete(issue.identifier)}>Complete</button>{/if}
          {#if issue.stuck}<button onclick={() => retry(issue.identifier)}>Retry</button>{/if}
        </div>
      </div>
    {/each}
  </section>

  <section>
    <h2>Timeline</h2>
    <div class="timeline">
      {#each live.slice().reverse() as e}
        <div class="event"><span class="ev-id">{e.identifier}</span> {e.label}</div>
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
      <h2>Candidate issues</h2>
      {#if candidates.length === 0}<p class="dim">None available.</p>{/if}
      {#each candidates as c (c.identifier)}
        <div class="candidate">
          <span><strong>{c.identifier}</strong> {c.title}</span>
          {#if c.inFlight}
            <span class="dim">in flight</span>
          {:else}
            <button class="primary" onclick={() => start(c.identifier)}>Start</button>
          {/if}
        </div>
      {/each}
      <button onclick={() => (showCandidates = false)}>Close</button>
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
  header .primary {
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
    max-width: 900px;
    margin: 0 auto;
    padding: 20px;
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
    font-size: 12px;
  }
  .cost {
    color: var(--text-dim);
    font-size: 12px;
  }
  .issue-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 8px;
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
  .candidate {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
</style>
