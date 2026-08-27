<script lang="ts">
  /**
   * The other direction: clipboard → a field.
   *
   * The pairing code, the OAuth code, a token — the user has just copied it somewhere else
   * and the next act is always the same. One click beats a focus-and-⌘V, and it means the
   * field never has to be the thing they hunt for.
   *
   * Silent when there is nothing to paste; `onerror` is for the caller to say why in its
   * own words if it wants to.
   */
  import Button from './Button.svelte';
  import { t } from './i18n.svelte';

  interface Props {
    /** Receives the clipboard text. Trimmed — a copied line usually carries a newline. */
    onpaste: (text: string) => void;
    label?: string;
  }
  let { onpaste, label }: Props = $props();

  let empty = $state(false);

  async function paste(): Promise<void> {
    empty = false;
    const bridge = typeof window !== 'undefined' ? window.corral : undefined;
    if (!bridge) return;
    try {
      const r = await bridge.clipboard.read();
      const text = (r.text ?? '').trim();
      if (!text) {
        empty = true;
        return;
      }
      onpaste(text);
    } catch {
      empty = true;
    }
  }
</script>

<span class="wrap">
  <Button onclick={paste}>{label ?? t('paste.do')}</Button>
  {#if empty}<span class="err">{t('paste.empty')}</span>{/if}
</span>

<style>
  .wrap {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .err {
    font-size: 11px;
    color: var(--warning);
  }
</style>
