<script lang="ts">
  import { onMount } from 'svelte';
  import Dashboard from './Dashboard.svelte';
  import Wizard from './Wizard.svelte';

  let route = $state(location.hash);
  // undefined = unknown yet; false = not configured (force the wizard).
  let configured = $state<boolean | undefined>(undefined);

  onMount(() => {
    const onHash = () => (route = location.hash);
    window.addEventListener('hashchange', onHash);
    // Ask the control plane whether setup is needed (browser/headless path). If the
    // server isn't up yet (e.g. Electron first run), fall back to the hash route.
    fetch('/api/status')
      .then((r) => r.json())
      .then((s: { configured: boolean }) => (configured = s.configured))
      .catch(() => (configured = undefined));
    return () => window.removeEventListener('hashchange', onHash);
  });

  const isSetup = $derived(route.startsWith('#/setup') || configured === false);
</script>

{#if isSetup}
  <Wizard />
{:else}
  <Dashboard />
{/if}
