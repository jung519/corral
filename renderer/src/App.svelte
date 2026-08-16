<script lang="ts">
  import { onMount } from 'svelte';
  import Dashboard from './Dashboard.svelte';
  import History from './History.svelte';
  import Logs from './Logs.svelte';
  import ModePicker from './ModePicker.svelte';
  import PipelineDetail from './PipelineDetail.svelte';
  import Pipelines from './Pipelines.svelte';
  import Settings from './Settings.svelte';
  import Toast from './Toast.svelte';
  import Wizard from './Wizard.svelte';
  import * as api from './lib/api';
  import { t } from './lib/i18n.svelte';
  import { modeState, setMode } from './lib/mode.svelte';
  import { prefs } from './lib/prefs.svelte';

  let route = $state(location.hash);

  onMount(() => {
    const onHash = () => (route = location.hash);
    window.addEventListener('hashchange', onHash);
    // First run lands on the wizard ONCE — but never traps: the user can close it
    // (→ dashboard, which shows a "set up" banner). We don't force the wizard.
    void api.isConfigured().then((configured) => {
      if (!configured && !location.hash.startsWith('#/setup')) location.hash = '#/setup';
    });

    // OS notifications when a human action is needed — fired app-wide (any tab) so a
    // pending approval doesn't sit unseen for hours. The main process suppresses these
    // while the window is focused. `approval` = decision needed; `error` = needs a look.
    const unsubNotify = api.subscribeEvents((e) => {
      if (!window.corral) return;
      if (e.kind === 'approval' && prefs.notifyApproval) {
        void window.corral.notify(`🔔 ${t('notify.actionNeeded')}`, `${e.identifier}`);
      } else if (e.kind === 'error' && prefs.notifyError) {
        void window.corral.notify(`⚠️ ${t('notify.error')}`, `${e.identifier} — ${e.label}`);
      }
    });

    return () => {
      window.removeEventListener('hashchange', onHash);
      unsubNotify();
    };
  });

  /**
   * Two pillars, so "switch" is unambiguous and one click is what the word promises.
   * The picker stays for the first visit, where the choice still needs explaining.
   */
  function switchMode(): void {
    setMode(modeState.current === 'ops' ? 'dev' : 'ops');
    // The route you were on belongs to the pillar you just left, and its screen may not
    // even be in the new sidebar. Land on the new mode's home instead of a page that has
    // no way back.
    location.hash = '#/';
  }

  const isSetup = $derived(route.startsWith('#/setup'));
  /** null until the user has chosen once. */
  const mode = $derived(modeState.current);
  // The picker is a screen inside the app, not a gate in front of it: shown when nothing
  // has been chosen yet, and reachable from the sidebar afterwards.
  const picking = $derived(!mode || route.startsWith('#/mode'));
  /** `#/pipeline/<key>` — the detail screen for one pipeline. */
  const detailKey = $derived(route.startsWith('#/pipeline/') ? decodeURIComponent(route.slice('#/pipeline/'.length)) : '');

  // Settings is in both lists on purpose: the provider, the models and the token ceiling
  // are one setup shared by both pillars (D24). Two settings screens would imply two.
  const DEV_NAV = [
    { hash: '#/', key: 'nav.dashboard' },
    { hash: '#/history', key: 'nav.history' },
    { hash: '#/logs', key: 'nav.logs' },
    { hash: '#/settings', key: 'nav.settings' },
  ];
  const OPS_NAV = [
    { hash: '#/', key: 'nav.pipelines' },
    { hash: '#/logs', key: 'nav.logs' },
    { hash: '#/settings', key: 'nav.settings' },
  ];
  // Nothing to navigate to before a mode is chosen — an empty sidebar is honest here.
  const nav = $derived(!mode ? [] : mode === 'ops' ? OPS_NAV : DEV_NAV);
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
      {#if mode}
        <!-- Spelled out, not an icon: which pillar you are looking at decides what every
             screen below means, and an icon would make that a guess. -->
        <div class="mode">
          <span class="label">{t('mode.current')}</span>
          <strong>{t(mode === 'ops' ? 'mode.ops' : 'mode.dev')}</strong>
          <button class="switch" onclick={switchMode}>{t('mode.switch')}</button>
        </div>
      {/if}
      <ul>
        {#each nav as item}
          <li><a href={item.hash} class:active={active(item.hash)}>{t(item.key)}</a></li>
        {/each}
      </ul>
    </nav>
    <div class="content">
      {#if picking}
        <ModePicker current={mode} />
      {:else if detailKey}
        {#key detailKey}
          <PipelineDetail pipelineKey={detailKey} />
        {/key}
      {:else if route.startsWith('#/history')}
        <History />
      {:else if route.startsWith('#/logs')}
        <Logs />
      {:else if route.startsWith('#/settings')}
        <Settings />
      {:else if mode === 'ops'}
        <Pipelines />
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
    margin: 0 0 10px;
    padding-left: 8px;
  }
  .mode {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 0 8px 12px;
    margin-bottom: 8px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
  }
  .mode .label {
    color: var(--text-dim);
  }
  .mode strong {
    flex: 1;
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
  }
  .mode .switch {
    font-size: 11px;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-dim);
    white-space: nowrap;
  }
  .mode .switch:hover {
    background: var(--surface-2);
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
