<script lang="ts">
  import { onMount } from 'svelte';
  import About from './About.svelte';
  import Dashboard from './Dashboard.svelte';
  import History from './History.svelte';
  import Logs from './Logs.svelte';
  import Settings from './Settings.svelte';
  import Toast from './Toast.svelte';
  import Wizard from './Wizard.svelte';
  import * as api from './lib/api';
  import { t } from './lib/i18n.svelte';

  let route = $state(location.hash);

  onMount(() => {
    const onHash = () => (route = location.hash);
    window.addEventListener('hashchange', onHash);
    // First run lands on the wizard ONCE — but never traps: the user can close it
    // (→ dashboard, which shows a "set up" banner). We don't force the wizard.
    api
      .getStatus()
      .then((s) => {
        if (!s.configured && !location.hash.startsWith('#/setup')) location.hash = '#/setup';
      })
      .catch(() => {});
    return () => window.removeEventListener('hashchange', onHash);
  });

  const isSetup = $derived(route.startsWith('#/setup'));

  const nav = [
    { hash: '#/', key: 'nav.dashboard' },
    { hash: '#/history', key: 'nav.history' },
    { hash: '#/logs', key: 'nav.logs' },
    { hash: '#/settings', key: 'nav.settings' },
    { hash: '#/about', key: 'nav.about' },
  ];
  function active(hash: string): boolean {
    if (hash === '#/') return route === '' || route === '#/' || route === '#';
    return route.startsWith(hash);
  }
</script>

<Toast />

{#if isSetup}
  <Wizard />
{:else}
  <div class="shell">
    <nav>
      <p class="brand">Corral</p>
      <ul>
        {#each nav as item}
          <li><a href={item.hash} class:active={active(item.hash)}>{t(item.key)}</a></li>
        {/each}
      </ul>
    </nav>
    <div class="content">
      {#if route.startsWith('#/history')}
        <History />
      {:else if route.startsWith('#/logs')}
        <Logs />
      {:else if route.startsWith('#/settings')}
        <Settings />
      {:else if route.startsWith('#/about')}
        <About />
      {:else}
        <Dashboard />
      {/if}
    </div>
  </div>
{/if}

<style>
  .shell {
    display: grid;
    grid-template-columns: 200px 1fr;
    min-height: 100vh;
  }
  nav {
    background: var(--surface);
    border-right: 1px solid var(--border);
    padding: 18px 12px;
  }
  .brand {
    font-size: 16px;
    font-weight: 500;
    margin: 0 0 16px;
    padding-left: 8px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  a {
    display: block;
    padding: 8px 10px;
    border-radius: 8px;
    color: var(--text-dim);
    text-decoration: none;
    font-size: 14px;
  }
  a:hover {
    background: var(--surface-2);
  }
  a.active {
    background: var(--accent);
    color: var(--accent-text);
  }
  .content {
    overflow: auto;
  }
</style>
