<script lang="ts">
  import { onMount } from 'svelte';
  import About from './About.svelte';
  import Preferences from './Preferences.svelte';
  import Setup from './Setup.svelte';
  import { t } from './lib/i18n.svelte';

  // Sub-routing inside Settings: #/settings (셋업), #/settings/prefs, #/settings/info.
  let hash = $state(location.hash);
  onMount(() => {
    const on = () => (hash = location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  });
  const sub = $derived(hash.replace(/^#\/settings\/?/, '') || 'setup');

  const tabs = [
    { key: 'setup', hash: '#/settings', label: 'settings.tab.setup' },
    { key: 'prefs', hash: '#/settings/prefs', label: 'settings.tab.prefs' },
    { key: 'info', hash: '#/settings/info', label: 'settings.tab.info' },
  ];
</script>

<div class="shell">
  <aside class="subnav">
    {#each tabs as tab}
      <a href={tab.hash} class:active={sub === tab.key}>{t(tab.label)}</a>
    {/each}
  </aside>
  <div class="pane">
    {#if sub === 'prefs'}
      <Preferences />
    {:else if sub === 'info'}
      <About />
    {:else}
      <Setup />
    {/if}
  </div>
</div>

<style>
  /* No content padding here — each pane (Setup/Preferences/About) pads itself. */
  .shell {
    display: grid;
    grid-template-columns: 190px 1fr;
    align-items: start;
  }
  .subnav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    position: sticky;
    top: 0;
    padding: 24px 0 0 20px;
  }
  .subnav a {
    display: block;
    padding: 8px 12px;
    border-radius: 8px;
    color: var(--text-dim);
    text-decoration: none;
    font-size: 14px;
  }
  .subnav a:hover {
    background: var(--surface-2);
  }
  .subnav a.active {
    background: var(--accent);
    color: var(--accent-text);
  }
  .pane {
    min-width: 0;
  }
</style>
