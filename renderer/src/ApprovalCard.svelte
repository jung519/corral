<script lang="ts">
  import type { PendingAction } from './lib/types';

  interface Props {
    action: PendingAction;
    onApprove: (id: string, selection?: string, notes?: string) => void;
    onFeedback: (id: string, text: string) => void;
  }
  let { action, onApprove, onFeedback }: Props = $props();

  let selection: string | undefined = $state(action.options?.[0]);
  let notes = $state('');

  function approve() {
    onApprove(action.id, action.options ? selection : undefined, notes.trim() || undefined);
  }
  function requestChanges() {
    if (!notes.trim()) return;
    onFeedback(action.id, notes.trim());
  }
</script>

<div class="card">
  <div class="head">
    <span class="badge">{action.kind}</span>
    <strong>{action.title}</strong>
    <span class="id">{action.identifier}</span>
  </div>

  <div class="body">{@html action.bodyHtml}</div>

  {#if action.options && action.options.length > 1}
    <div class="options">
      {#each action.options as opt}
        <label class:selected={selection === opt}>
          <input type="radio" name={`opt-${action.id}`} value={opt} bind:group={selection} />
          {opt}
        </label>
      {/each}
    </div>
  {/if}

  <textarea rows="2" placeholder="Notes (optional for approve, required to request changes)" bind:value={notes}></textarea>

  <div class="actions">
    <button class="primary" onclick={approve}>Approve</button>
    <button onclick={requestChanges} disabled={!notes.trim()}>Request changes</button>
  </div>
</div>

<style>
  .card {
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    padding: 14px 16px;
    margin-bottom: 12px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }
  .badge {
    background: var(--accent);
    color: var(--accent-text);
    border-radius: 6px;
    padding: 2px 8px;
    font-size: 12px;
  }
  .id {
    margin-left: auto;
    color: var(--text-dim);
    font-size: 12px;
  }
  .body {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    max-height: 340px;
    overflow: auto;
    margin-bottom: 10px;
  }
  .body :global(pre) {
    overflow: auto;
  }
  .options {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 10px;
  }
  .options label {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 10px;
    cursor: pointer;
  }
  .options label.selected {
    border-color: var(--accent);
    color: var(--accent-text);
  }
  textarea {
    margin-bottom: 10px;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
</style>
