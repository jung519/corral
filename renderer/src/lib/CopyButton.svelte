<script lang="ts">
  /**
   * Hands a value to the clipboard on one click.
   *
   * Anything the user would otherwise select by hand — a command to run in a terminal, a
   * sign-in URL, a pairing code — gets one of these instead of being printed in full. A
   * wall of monospace text is not an instruction; it is work handed back to the reader.
   *
   * The value stays hidden by default. It is shown only when copying is impossible (no
   * bridge, or the clipboard refused), because then reading it off the screen is the
   * remaining way through — the same rule the rest of the app follows: try, and when it
   * cannot work, name the alternative.
   */
  import Button from './Button.svelte';
  import { t } from './i18n.svelte';

  interface Props {
    /** What lands on the clipboard. */
    value: string;
    /** Button text. Defaults to a plain "copy". */
    label?: string;
    /** Show the value beside the button even when copying works — for a short code the
     *  user may want to read back. Long values (URLs, tokens) leave this off. */
    reveal?: boolean;
  }
  let { value, label, reveal = false }: Props = $props();

  let state = $state<'idle' | 'done' | 'failed'>('idle');
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function copy(): Promise<void> {
    clearTimeout(timer);
    const bridge = typeof window !== 'undefined' ? window.corral : undefined;
    if (!bridge) {
      state = 'failed';
      return;
    }
    try {
      await bridge.clipboard.write(value);
      state = 'done';
      // Long enough to notice, short enough that the button does not look stuck.
      timer = setTimeout(() => (state = 'idle'), 2000);
    } catch {
      state = 'failed';
    }
  }
</script>

<span class="wrap">
  <Button onclick={copy}>{state === 'done' ? t('copy.done') : (label ?? t('copy.do'))}</Button>
  {#if reveal || state === 'failed'}
    <code class="val">{value}</code>
  {/if}
  {#if state === 'failed'}
    <span class="err">{t('copy.failed')}</span>
  {/if}
</span>

<style>
  .wrap {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .val {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 3px 6px;
    word-break: break-all;
    user-select: text;
  }
  .err {
    font-size: 11px;
    color: var(--warning);
  }
</style>
