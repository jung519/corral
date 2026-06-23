<script lang="ts">
  import { t } from './lib/i18n.svelte';
  import Button from './lib/Button.svelte';
  import type { PendingAction } from './lib/types';

  interface Props {
    action: PendingAction;
    onApprove: (id: string, selection?: string, notes?: string) => unknown | Promise<unknown>;
    onFeedback: (id: string, text: string) => unknown | Promise<unknown>;
  }
  let { action, onApprove, onFeedback }: Props = $props();

  // `chosen` overrides the derived default; reading the prop here (not in a $state
  // initializer) avoids the state_referenced_locally warning.
  let chosen = $state<string | undefined>(undefined);
  const selection = $derived(chosen ?? action.options?.[0]);
  let notes = $state('');

  function approve() {
    return onApprove(action.id, action.options ? selection : undefined, notes.trim() || undefined);
  }
  function requestChanges() {
    if (!notes.trim()) return;
    return onFeedback(action.id, notes.trim());
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
          <input
            type="radio"
            name={`opt-${action.id}`}
            value={opt}
            checked={selection === opt}
            onchange={() => (chosen = opt)}
          />
          {opt}
        </label>
      {/each}
    </div>
  {/if}

  <textarea rows="2" placeholder={t('card.notes')} bind:value={notes}></textarea>

  <div class="actions">
    <Button class="primary" onclick={approve}>{t('card.approve')}</Button>
    <Button onclick={requestChanges} disabled={!notes.trim()}>{t('card.requestChanges')}</Button>
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
    padding: 12px 14px;
    max-height: 460px;
    overflow: auto;
    margin-bottom: 10px;
    font-size: 13.5px;
    line-height: 1.65; /* breathing room for dense review prose */
  }
  /* The body is injected markdown (@html), so its elements must be styled via :global. */
  .body > :global(:first-child) {
    margin-top: 0;
  }
  .body > :global(:last-child) {
    margin-bottom: 0;
  }
  .body :global(p) {
    margin: 0 0 10px;
  }
  .body :global(h1),
  .body :global(h2),
  .body :global(h3),
  .body :global(h4) {
    margin: 16px 0 6px;
    line-height: 1.3;
    font-weight: 600;
  }
  .body :global(h1) {
    font-size: 16px;
  }
  .body :global(h2) {
    font-size: 15px;
  }
  .body :global(h3) {
    font-size: 14px;
  }
  .body :global(h4) {
    font-size: 13.5px;
    color: var(--text-dim);
  }
  .body :global(ul),
  .body :global(ol) {
    margin: 0 0 10px;
    padding-left: 20px;
  }
  .body :global(li) {
    margin: 4px 0;
  }
  .body :global(li > p) {
    margin: 0;
  }
  /* Inline code (file paths, symbols): wrap long tokens instead of running on. */
  .body :global(code) {
    font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 0.86em;
    background: var(--surface-2);
    border-radius: 4px;
    padding: 1px 5px;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .body :global(pre) {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 12px;
    overflow: auto;
    margin: 0 0 10px;
  }
  .body :global(pre code) {
    background: none;
    padding: 0;
    font-size: 12.5px;
    overflow-wrap: normal;
    word-break: normal;
  }
  .body :global(a) {
    color: var(--accent);
  }
  .body :global(strong) {
    font-weight: 600;
  }
  .body :global(hr) {
    border: none;
    border-top: 1px solid var(--border);
    margin: 14px 0;
  }
  .body :global(blockquote) {
    margin: 0 0 10px;
    padding-left: 12px;
    border-left: 3px solid var(--border);
    color: var(--text-dim);
  }
  .body :global(table) {
    border-collapse: collapse;
    margin: 0 0 10px;
    font-size: 12.5px;
  }
  .body :global(th),
  .body :global(td) {
    border: 1px solid var(--border);
    padding: 4px 8px;
    text-align: left;
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
