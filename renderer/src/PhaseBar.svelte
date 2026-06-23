<script lang="ts">
  import { t } from './lib/i18n.svelte';
  import { phaseActivity, STAGE_KEYS, stageIndex } from './lib/phase';

  let { phase }: { phase: string } = $props();
  const cur = $derived(stageIndex(phase));
  const activity = $derived(phaseActivity(phase));
</script>

<div class="bar">
  {#each STAGE_KEYS as key, i}
    {#if i > 0}<span class="sep"></span>{/if}
    <span class="stage" class:done={i < cur} class:active={i === cur}>
      {#if i < cur}<span class="check">✓</span>{/if}
      {#if i === cur && activity === 'working'}<span class="ind spin" title={t('dash.working')}></span>{/if}
      {#if i === cur && activity === 'waiting'}<span class="ind pulse" title={t('dash.waiting')}></span>{/if}
      {#if i === cur && activity === 'error'}<span class="ind err" title={t('phase.error')}></span>{/if}
      {t(key)}
    </span>
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
    display: inline-flex;
    align-items: center;
    gap: 4px;
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
  .check {
    color: var(--green);
  }
  /* In-progress indicator on the active stage. */
  .ind {
    display: inline-block;
    width: 9px;
    height: 9px;
    flex: 0 0 auto;
  }
  /* working: agent is running → spinner */
  .ind.spin {
    border: 2px solid color-mix(in srgb, var(--accent-text) 35%, transparent);
    border-top-color: var(--accent-text);
    border-radius: 50%;
    animation: phasebar-spin 0.6s linear infinite;
  }
  /* waiting: paused on a human/external action → pulsing dot (still in flight) */
  .ind.pulse {
    border-radius: 50%;
    background: var(--amber, #d29922);
    animation: phasebar-pulse 1.1s ease-in-out infinite;
  }
  /* error: needs attention → steady red dot */
  .ind.err {
    border-radius: 50%;
    background: var(--red, #f85149);
  }
  @keyframes phasebar-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes phasebar-pulse {
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
</style>
