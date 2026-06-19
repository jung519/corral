<script lang="ts">
  import { t } from './lib/i18n.svelte';
  import { STAGE_KEYS, stageIndex } from './lib/phase';

  let { phase }: { phase: string } = $props();
  const cur = $derived(stageIndex(phase));
</script>

<div class="bar">
  {#each STAGE_KEYS as key, i}
    {#if i > 0}<span class="sep"></span>{/if}
    <span class="stage" class:done={i < cur} class:active={i === cur}>{i < cur ? '✓ ' : ''}{t(key)}</span>
  {/each}
</div>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
  }
  .stage {
    color: #5f5e5a;
    white-space: nowrap;
  }
  .stage.done {
    color: var(--green);
  }
  .stage.active {
    color: var(--accent-text);
    font-weight: 500;
  }
  .sep {
    width: 14px;
    height: 1px;
    background: var(--border);
  }
</style>
