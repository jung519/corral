<script lang="ts">
  /**
   * Choosing which pillar to work in.
   *
   * Lives inside the app shell rather than replacing it, so this is a screen in Corral
   * rather than a gate in front of it — and so it can be reopened at any time from the
   * sidebar instead of being a thing you see once and never again.
   */
  import { setMode, type Mode } from './lib/mode.svelte';
  import { t } from './lib/i18n.svelte';

  interface Props {
    /** The mode in use, so the current one reads as current. */
    current?: Mode | null;
  }
  let { current = null }: Props = $props();

  const choices: Array<{ mode: Mode; title: string; body: string; points: string[] }> = [
    {
      mode: 'dev',
      title: t('mode.dev'),
      body: t('mode.dev.body'),
      points: [t('mode.dev.p1'), t('mode.dev.p2'), t('mode.dev.p3')],
    },
    {
      mode: 'ops',
      title: t('mode.ops'),
      body: t('mode.ops.body'),
      points: [t('mode.ops.p1'), t('mode.ops.p2'), t('mode.ops.p3')],
    },
  ];

  function choose(mode: Mode) {
    setMode(mode);
    location.hash = '#/';
  }
</script>

<header>
  <h1>Corral</h1>
  <span class="count">{t('mode.pick')}</span>
</header>

<main>
  <div class="cards">
    {#each choices as choice}
      <button class="card" class:current={current === choice.mode} onclick={() => choose(choice.mode)}>
        <span class="head">
          <strong>{choice.title}</strong>
          {#if current === choice.mode}<span class="badge">{t('mode.inUse')}</span>{/if}
        </span>
        <span class="body">{choice.body}</span>
        <ul>
          {#each choice.points as point}
            <li>{point}</li>
          {/each}
        </ul>
      </button>
    {/each}
  </div>
  <p class="hint">{t('mode.pickHint')}</p>
</main>

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
  main {
    padding: 28px 22px;
    max-width: 900px;
  }
  .cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .card {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    text-align: left;
    min-height: 240px;
    padding: 22px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
  }
  .card:hover {
    border-color: var(--accent);
  }
  .card.current {
    border-color: var(--accent);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .head strong {
    font-size: 17px;
    font-weight: 500;
    color: var(--text);
  }
  .badge {
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-text);
  }
  .body {
    font-size: 13px;
    color: var(--text-dim);
    line-height: 1.5;
  }
  ul {
    list-style: none;
    margin: auto 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  li {
    font-size: 12px;
    color: var(--text-dim);
    padding-left: 14px;
    position: relative;
  }
  li::before {
    content: '·';
    position: absolute;
    left: 4px;
    color: var(--accent);
  }
  .hint {
    color: var(--text-dim);
    font-size: 12px;
    margin: 16px 0 0;
  }
  @media (max-width: 720px) {
    .cards {
      grid-template-columns: 1fr;
    }
  }
</style>
