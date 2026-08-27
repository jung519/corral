<script lang="ts">
  /**
   * The event a manual run stands in for.
   *
   * A trigger arrives carrying something — a queue message with an identifier, a schedule
   * with its timestamp. Pressing "run" is standing in for that trigger, so the same thing
   * has to come from somewhere, and the only somewhere is here.
   *
   * `opsRun` always took an `input`; both screens that call it passed nothing, so it was
   * always `{}`. For a pipeline whose fetch reads `/records/{{id}}` that renders as
   * `/records/`, the required fields come back empty and the run ends `skipped` — every
   * time, by construction. The toast on the screen next to it said "try it with a run"
   * (CRL-72).
   *
   * Shown only when the definition needs it. A pipeline with a fixed URL is complete on
   * its own, and stopping to ask would put a dialog in front of the one-click run that
   * already worked.
   */
  import { t } from './lib/i18n.svelte';
  import Button from './lib/Button.svelte';

  interface Props {
    pipelineKey: string;
    /** Names the fetch will substitute. Empty when the input kind has none to name. */
    fields: string[];
    onclose: () => void;
    onrun: (input: unknown) => unknown | Promise<unknown>;
  }
  let { pipelineKey, fields, onclose, onrun }: Props = $props();

  /**
   * Prefilled with the names, not with an empty object.
   *
   * The names are the whole answer to "what does this want" — asked for as a skeleton, the
   * reader fills in values instead of first working out which keys exist. No invented
   * values: a made-up `"1"` is a value, and a value that came from us is the kind that gets
   * run by accident.
   *
   * `null` rather than `""` for the same reason. An empty string IS a value, and a request
   * is sent with it (see `refuseHoles`) — so a skeleton run unchanged would fetch
   * `/records/` and end in a puzzling skip. `null` is the absence the run then names out
   * loud: "the url needs \"id\"" (CRL-74).
   */
  // Read once on purpose — after this the text belongs to whoever is typing it, and
  // re-deriving it from the prop would wipe what they wrote. A different pipeline arrives
  // as a new component, because closing clears `asking` before the next one is set.
  // svelte-ignore state_referenced_locally
  let text = $state(skeleton(fields));

  function skeleton(names: string[]): string {
    return names.length ? `{\n${names.map((n) => `  "${n}": null`).join(',\n')}\n}` : '{\n  \n}';
  }
  let error = $state('');
  let busy = $state(false);

  async function go(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Refused here rather than sent: a body the core cannot read would come back as a
      // failed run in the history, which is a worse place to learn about a typo.
      error = t('run.badJson');
      return;
    }
    error = '';
    busy = true;
    try {
      await onrun(parsed);
      onclose();
    } finally {
      busy = false;
    }
  }
</script>

<div class="overlay" onclick={onclose} role="presentation">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
    <div class="phead">
      <strong>{t('run.title')}</strong>
      <span class="id">{pipelineKey}</span>
      <button class="x" onclick={onclose} aria-label={t('run.title')}>✕</button>
    </div>
    <p class="hint">{t('run.hint')}</p>
    {#if fields.length}
      <p class="hint">{t('run.fields')} <code>{fields.join(', ')}</code></p>
    {:else}
      <p class="hint">{t('run.noFields')}</p>
    {/if}

    <label class="field"
      ><span>{t('run.body')}</span>
      <textarea class="mono" rows="6" bind:value={text} spellcheck="false"></textarea></label
    >
    {#if error}<p class="err">{error}</p>{/if}

    <div class="pactions">
      <Button class="primary" onclick={go} disabled={busy}>{t('run.go')}</Button>
      <Button onclick={onclose}>{t('editor.cancel')}</Button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 24px;
  }
  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    width: min(560px, 100%);
    padding: 16px 18px;
  }
  .phead {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .id {
    color: var(--text-dim);
    font-size: 12px;
  }
  .x {
    margin-left: auto;
    background: none;
    border: 0;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 14px;
  }
  .hint {
    color: var(--text-dim);
    font-size: 12px;
    margin: 0 0 8px;
  }
  code {
    color: var(--text);
  }
  .field {
    display: block;
  }
  .field span {
    display: block;
    color: var(--text-dim);
    font-size: 12px;
    margin-bottom: 4px;
  }
  textarea {
    width: 100%;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px;
    resize: vertical;
  }
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  .err {
    color: var(--danger);
    font-size: 12px;
    margin: 6px 0 0;
  }
  .pactions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 12px;
  }
</style>
