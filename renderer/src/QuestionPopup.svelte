<script lang="ts">
  import { t } from './lib/i18n.svelte';
  import * as api from './lib/api';
  import Button from './lib/Button.svelte';
  import type { PendingAction } from './lib/types';

  interface Props {
    action: PendingAction;
    /** The plan option currently selected on the card (carried into "approve with notes"). */
    selection?: string;
    onClose: () => void;
    onFeedback: (id: string, text: string) => unknown | Promise<unknown>;
    onApprove: (id: string, selection?: string, notes?: string) => unknown | Promise<unknown>;
  }
  let { action, selection, onClose, onFeedback, onApprove }: Props = $props();

  // Agent-question cards: the popup ANSWERS the agent (feedback). Plan/review cards: the
  // popup asks the agent read-only questions and routes change-requests / approve-with-
  // instructions to the agent. Approve-with-notes only matters on plan-like cards.
  const isQuestion = $derived(action.kind === 'question');
  const isPlan = $derived(['plan', 'pr_plan', 'fix_plan'].includes(action.kind));

  // `html` is set for agent answers (markdown rendered by the core); rendered via {@html}.
  type Msg = { role: 'you' | 'agent'; text: string; html?: string };
  let thread = $state<Msg[]>([]);
  let input = $state('');
  let busy = $state(false);

  async function ask() {
    const q = input.trim();
    if (!q || busy) return;
    thread = [...thread, { role: 'you', text: q }];
    input = '';
    busy = true;
    try {
      const r = await api.ask(action.identifier, q);
      if (r.ok) thread = [...thread, { role: 'agent', text: r.answer ?? '', html: r.answerHtml }];
      else thread = [...thread, { role: 'agent', text: `⚠ ${r.message ?? 'failed'}` }];
    } catch (e) {
      thread = [...thread, { role: 'agent', text: `⚠ ${String(e)}` }];
    } finally {
      busy = false;
    }
  }

  async function sendAnswer() {
    const txt = input.trim();
    if (!txt || busy) return;
    busy = true;
    try {
      await onFeedback(action.id, txt);
      onClose();
    } finally {
      busy = false;
    }
  }

  // Send the composer text as a change request → the agent re-reviews / re-plans.
  async function requestChanges() {
    const txt = input.trim();
    if (!txt || busy) return;
    busy = true;
    try {
      await onFeedback(action.id, txt);
      onClose();
    } finally {
      busy = false;
    }
  }

  // Approve, passing the composer text as extra instructions (plan-like cards).
  async function approveWithNotes() {
    if (busy) return;
    busy = true;
    try {
      await onApprove(action.id, action.options ? selection : undefined, input.trim() || undefined);
      onClose();
    } finally {
      busy = false;
    }
  }

  function onKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (isQuestion) void sendAnswer();
      else void ask();
    }
  }
</script>

<div class="overlay" onclick={onClose} role="presentation">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
    <div class="phead">
      <strong>{isQuestion ? t('qa.answerTitle') : t('qa.title')}</strong>
      <span class="id">{action.identifier}</span>
      <button class="x" onclick={onClose} aria-label={t('qa.close')}>✕</button>
    </div>
    <p class="hint">{isQuestion ? t('qa.answerHint') : t('qa.hint')}</p>

    {#if thread.length}
      <div class="thread">
        {#each thread as m, i (i)}
          <div class="msg {m.role}">
            <span class="who">{m.role === 'you' ? t('qa.you') : t('qa.agent')}</span>
            {#if m.html}
              <div class="txt md">{@html m.html}</div>
            {:else}
              <div class="txt">{m.text}</div>
            {/if}
          </div>
        {/each}
        {#if busy}<div class="msg agent"><span class="who">{t('qa.agent')}</span><div class="txt dim">{t('qa.asking')}</div></div>{/if}
      </div>
    {/if}

    <textarea
      rows="3"
      bind:value={input}
      onkeydown={onKey}
      placeholder={isQuestion ? t('qa.answerPlaceholder') : t('qa.placeholder')}
    ></textarea>

    <div class="pactions">
      {#if isQuestion}
        <Button class="primary" onclick={sendAnswer} disabled={busy || !input.trim()}>{t('qa.sendAnswer')}</Button>
      {:else}
        <Button class="primary" onclick={ask} disabled={busy || !input.trim()}>{busy ? t('qa.asking') : t('qa.ask')}</Button>
        <Button onclick={requestChanges} disabled={busy || !input.trim()}>{t('qa.requestChanges')}</Button>
        {#if isPlan}<Button onclick={approveWithNotes} disabled={busy}>{t('qa.approveWithNotes')}</Button>{/if}
      {/if}
      <Button onclick={onClose}>{t('qa.close')}</Button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 24px;
  }
  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    width: min(620px, 100%);
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    padding: 16px 18px;
  }
  .phead {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 4px;
  }
  .phead strong {
    font-size: 15px;
  }
  .id {
    font-size: 12px;
    color: var(--text-dim);
  }
  .x {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 14px;
  }
  .hint {
    font-size: 12px;
    color: var(--text-dim);
    margin: 0 0 12px;
  }
  .thread {
    flex: 1;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-bottom: 12px;
  }
  .msg {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .who {
    font-size: 11px;
    color: var(--text-dim);
  }
  .msg.you .txt {
    background: var(--surface-2);
    border-radius: 8px;
    padding: 8px 10px;
  }
  .txt {
    font-size: 13.5px;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .txt.dim {
    color: var(--text-dim);
  }
  /* Rendered markdown answer (@html) — real block structure instead of pre-wrap. */
  .txt.md {
    white-space: normal;
  }
  .txt.md :global(> :first-child) {
    margin-top: 0;
  }
  .txt.md :global(> :last-child) {
    margin-bottom: 0;
  }
  .txt.md :global(p) {
    margin: 0 0 8px;
  }
  .txt.md :global(h1),
  .txt.md :global(h2),
  .txt.md :global(h3),
  .txt.md :global(h4) {
    margin: 12px 0 6px;
    font-size: 14px;
    font-weight: 500;
    line-height: 1.3;
  }
  .txt.md :global(h2) {
    padding-bottom: 3px;
    border-bottom: 1px solid var(--border);
  }
  .txt.md :global(h3) {
    border-left: 3px solid var(--accent);
    padding-left: 8px;
  }
  .txt.md :global(ul),
  .txt.md :global(ol) {
    margin: 0 0 10px;
    padding-left: 20px;
  }
  .txt.md :global(li) {
    margin: 4px 0;
    line-height: 1.55;
  }
  .txt.md :global(code) {
    font-family: var(--mono, ui-monospace, Menlo, monospace);
    font-size: 0.86em;
    background: var(--surface-2);
    border-radius: 4px;
    padding: 1px 5px;
    overflow-wrap: anywhere;
  }
  .txt.md :global(pre) {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 12px;
    overflow: auto;
    margin: 0 0 10px;
  }
  .txt.md :global(pre code) {
    background: none;
    padding: 0;
  }
  .txt.md :global(strong) {
    font-weight: 500;
  }
  textarea {
    width: 100%;
    resize: vertical;
  }
  .pactions {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }
</style>
