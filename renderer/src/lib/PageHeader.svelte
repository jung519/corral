<script lang="ts">
  /**
   * The bar at the top of every screen.
   *
   * There used to be four different top areas — the dashboard and the pipelines list each
   * defined their own `<header>` (identical markup and CSS, copied), while history, logs
   * and settings had none at all. Moving between them made the bar appear and disappear,
   * which is most of why the two modes felt like different products.
   *
   * One definition, used by every screen. What varies is what a screen has to say:
   *
   *   dot     live connection to the core, where a screen is showing live data
   *   title   which screen you are on — the brand is in the sidebar, so repeating it
   *           here would spend the most prominent line in the app on something the
   *           user already knows
   *   meta    a count or a one-line subtitle
   *   actions the screen's own primary action, passed as children because a button
   *           belongs to whoever handles the click
   */
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    /** Omit entirely on screens that aren't reading from the core. */
    online?: boolean;
    meta?: string;
    children?: Snippet;
  }

  let { title, online, meta, children }: Props = $props();
</script>

<header>
  {#if online !== undefined}
    <span class="dot" class:on={online}></span>
  {/if}
  <h1>{title}</h1>
  {#if meta}<span class="meta">{meta}</span>{/if}
  <span class="spacer"></span>
  {#if children}{@render children()}{/if}
</header>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 22px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  h1 {
    font-size: 18px;
    margin: 0;
    white-space: nowrap;
  }
  .meta {
    color: var(--text-dim);
    font-size: 13px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .spacer {
    flex: 1;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-dim);
    flex: none;
  }
  .dot.on {
    background: var(--green, #3fb950);
  }
</style>
