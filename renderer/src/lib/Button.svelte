<script lang="ts">
  /**
   * Action button with a built-in double-click guard: while its (possibly async)
   * onclick runs, it disables itself and shows a spinner. Use for any button that
   * triggers a side effect (network, build, save) so a second click can't fire.
   */
  import type { Snippet } from 'svelte';

  interface Props {
    onclick?: () => unknown | Promise<unknown>;
    disabled?: boolean;
    class?: string;
    title?: string;
    type?: 'button' | 'submit';
    children: Snippet;
  }

  let { onclick, disabled = false, class: cls = '', title, type = 'button', children }: Props = $props();

  let pending = $state(false);

  async function handle() {
    if (pending || disabled) return; // ignore re-clicks while in flight
    pending = true;
    try {
      await onclick?.();
    } finally {
      pending = false;
    }
  }
</script>

<button {type} {title} class={cls} class:pending disabled={disabled || pending} onclick={handle}>
  {#if pending}<span class="spinner" aria-hidden="true"></span>{/if}
  {@render children()}
</button>

<style>
  button {
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }
  button.pending {
    cursor: progress;
  }
  .spinner {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
    border-radius: 50%;
    border: 2px solid currentColor;
    border-top-color: transparent;
    opacity: 0.75;
    animation: corral-spin 0.6s linear infinite;
  }
  @keyframes corral-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
