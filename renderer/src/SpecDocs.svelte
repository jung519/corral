<script lang="ts">
  import { getSpecDocs } from './lib/api';
  import { t } from './lib/i18n.svelte';
  import Button from './lib/Button.svelte';
  import type { SpecDoc } from './lib/types';

  let { identifier, onClose }: { identifier: string; onClose: () => void } = $props();

  let docs = $state<SpecDoc[] | null>(null);
  let active = $state(0);

  // Reload when the issue changes — reading `identifier` once would leave the previous
  // issue's documents on screen under a new heading.
  // The core renders the markdown; the window has no parser, and keeping it that way is a
  // boundary this repo maintains deliberately.
  $effect(() => {
    const id = identifier;
    docs = null;
    active = 0;
    let live = true;
    void getSpecDocs(id).then((d) => {
      if (live) docs = d;
    });
    return () => {
      live = false;
    };
  });
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onClose()} />

<div class="backdrop" onclick={onClose} role="presentation">
  <!-- The stop is what keeps a click inside the panel from closing it; the panel itself is
       not interactive, so it carries no handler of its own. -->
  <div class="panel" onclick={(e) => e.stopPropagation()} role="presentation">
    <div class="head">
      <strong>{t('spec.title')}</strong>
      <span class="id">{identifier}</span>
      <Button onclick={onClose}>{t('spec.close')}</Button>
    </div>

    {#if docs === null}
      <p class="hint">{t('spec.loading')}</p>
    {:else if docs.length === 0}
      <!-- Not an error: an issue planned before spec mode, or one still on its first gate. -->
      <p class="hint">{t('spec.none')}</p>
    {:else}
      <div class="tabs">
        {#each docs as doc, i}
          <button class:active={i === active} onclick={() => (active = i)}>{t(`kind.${doc.stage}`)}</button>
        {/each}
      </div>
      <div class="body">{@html docs[active]!.html}</div>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
  }
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    width: min(820px, 92vw);
    max-height: 84vh;
    display: flex;
    flex-direction: column;
    padding: 16px 18px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }
  .head .id {
    color: var(--text-dim);
    font-size: 12px;
    margin-right: auto;
  }
  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 10px;
  }
  .tabs button {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-dim);
    padding: 6px 10px;
    font-size: 13px;
    cursor: pointer;
  }
  .tabs button.active {
    color: var(--accent-text);
    border-bottom-color: var(--accent);
  }
  .body {
    overflow-y: auto;
    font-size: 13px;
    line-height: 1.6;
  }
  .hint {
    color: var(--text-dim);
    font-size: 13px;
  }
</style>
