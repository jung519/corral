<script lang="ts">
  import { onMount } from 'svelte';
  import Dashboard from './Dashboard.svelte';
  import Wizard from './Wizard.svelte';

  let route = $state(location.hash);
  onMount(() => {
    const onHash = () => (route = location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  });
  const isSetup = $derived(route.startsWith('#/setup'));
</script>

{#if isSetup}
  <Wizard />
{:else}
  <Dashboard />
{/if}
