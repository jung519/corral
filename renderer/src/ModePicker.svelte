<script lang="ts">
  import { setMode, type Mode } from './lib/mode.svelte';
  import { t } from './lib/i18n.svelte';

  const choices: Array<{ mode: Mode; title: string; body: string }> = [
    { mode: 'dev', title: t('mode.dev'), body: t('mode.dev.body') },
    { mode: 'ops', title: t('mode.ops'), body: t('mode.ops.body') },
  ];
</script>

<div class="view">
  <h1>{t('mode.pick')}</h1>
  <p class="hint">{t('mode.pickHint')}</p>

  <div class="choices">
    {#each choices as choice}
      <button class="choice" onclick={() => setMode(choice.mode)}>
        <strong>{choice.title}</strong>
        <span>{choice.body}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .view {
    max-width: 620px;
    margin: 12vh auto;
    padding: 0 24px;
  }
  h1 {
    font-size: 20px;
    margin: 0 0 6px;
  }
  .hint {
    color: var(--text-dim);
    font-size: 13px;
    margin: 0 0 24px;
  }
  .choices {
    display: grid;
    gap: 12px;
  }
  .choice {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    text-align: left;
    padding: 16px 18px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
  }
  .choice:hover {
    border-color: var(--accent);
  }
  .choice strong {
    font-size: 15px;
    color: var(--text);
  }
  .choice span {
    font-size: 13px;
    color: var(--text-dim);
  }
</style>
