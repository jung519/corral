<script lang="ts">
  /**
   * One credential slot, with its name on it.
   *
   * A provider card used to hold a single unlabelled password box while the config
   * underneath it had two slots — an API key and a subscription credential. Whoever had a
   * token in hand put it in the only box there was, which saved it to the wrong slot and
   * failed at the first agent turn, minutes or (under docker) an hour later. Naming both
   * slots and marking which one the current settings will actually read is the whole fix
   * (CRL-85).
   *
   * The value is never shown. It arrives by copy from a console page or a terminal, so a
   * paste button is the entire interaction; `warning` is for the caller to say when what
   * arrived looks like it belongs somewhere else.
   */
  import type { Snippet } from 'svelte';
  import PasteButton from './PasteButton.svelte';
  import { t } from './i18n.svelte';

  interface Props {
    /** Name of this slot, already translated. */
    label: string;
    value: string;
    placeholder: string;
    /** The slot the configured run will read. Marked so two boxes are never a coin toss. */
    active?: boolean;
    /** Held in the credential store already — the field stays empty and keeps it. */
    saved?: boolean;
    disabled?: boolean;
    /** Translated sentence naming what looks wrong with `value`. Advisory, never blocking. */
    warning?: string;
    /** Buttons belonging to this slot (fetch it automatically, import an existing login). */
    children?: Snippet;
  }
  let {
    label,
    value = $bindable(),
    placeholder,
    active = false,
    saved = false,
    disabled = false,
    warning = '',
    children,
  }: Props = $props();

  const hasBridge = typeof window !== 'undefined' && !!window.corral;
</script>

<div class="slot" class:disabled>
  <div class="slot-head">
    <span class="slot-label">{label}</span>
    {#if active}<span class="slot-tag">{t('account.slotActive')}</span>{/if}
  </div>
  <div class="slot-row">
    <input
      type="password"
      spellcheck="false"
      {disabled}
      bind:value
      placeholder={!value && saved ? t('field.secretSaved') : placeholder}
    />
    {#if hasBridge && !disabled}<PasteButton onpaste={(v) => (value = v)} />{/if}
  </div>
  {#if warning}<p class="slot-warn">{warning}</p>{/if}
  {#if children}<div class="slot-btns">{@render children()}</div>{/if}
</div>

<style>
  .slot {
    margin-bottom: 10px;
  }
  .slot.disabled {
    opacity: 0.6;
  }
  .slot-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }
  .slot-label {
    font-size: 12px;
    color: var(--text-dim);
  }
  .slot-tag {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 20px;
    white-space: nowrap;
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 16%, transparent);
  }
  .slot-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .slot-row input {
    flex: 1;
    min-width: 0;
  }
  .slot-warn {
    margin: 6px 0 0;
    font-size: 11px;
    color: var(--warning);
  }
  .slot-btns {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
</style>
