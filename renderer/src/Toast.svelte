<script lang="ts">
  import { dismiss, toasts } from './lib/toast.svelte';
</script>

<div class="toasts">
  {#each toasts() as item (item.id)}
    <button class="toast {item.kind}" onclick={() => dismiss(item.id)} title="dismiss">{item.message}</button>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    right: 18px;
    bottom: 18px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 1000;
    max-width: 380px;
  }
  .toast {
    text-align: left;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-left: 3px solid var(--text-dim);
    border-radius: 8px;
    padding: 10px 14px;
    color: var(--text);
    font-size: 13px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    cursor: pointer;
  }
  .toast.error {
    border-left-color: var(--red);
  }
  .toast.success {
    border-left-color: var(--green);
  }
  .toast.info {
    border-left-color: var(--accent);
  }
</style>
