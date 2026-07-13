<script lang="ts">
  import { onMount } from 'svelte';
  import Button from './lib/Button.svelte';
  import { t } from './lib/i18n.svelte';
  import { prefs, setPref } from './lib/prefs.svelte';

  const hasBridge = typeof window !== 'undefined' && !!window.corral;

  // Global Direction (방향성) — free text persisted to userData/direction.md via the
  // Phase-0 bridge. Loaded on mount; saved explicitly. (Validation is Phase 5.)
  let direction = $state('');
  let savedDirection = $state('');
  let dirSaving = $state(false);
  const dirDirty = $derived(direction !== savedDirection);

  onMount(async () => {
    if (!hasBridge) return;
    try {
      direction = savedDirection = (await window.corral!.direction.read()) ?? '';
    } catch {
      /* leave empty — the section still renders */
    }
  });

  async function saveDirection() {
    if (!hasBridge || dirSaving || !dirDirty) return;
    dirSaving = true;
    try {
      await window.corral!.direction.write(direction);
      savedDirection = direction;
    } finally {
      dirSaving = false;
    }
  }

  function insertTemplate() {
    if (direction.trim()) return;
    direction = t('direction.template');
  }
</script>

<div class="prefs">
  <section>
    <h2>{t('prefs.notifications')}</h2>
    <p class="hint">{t('prefs.notifications.hint')}</p>
    {#if !hasBridge}
      <p class="hint warn">{t('prefs.notifications.browser')}</p>
    {/if}

    <label class="row">
      <span>
        <strong>{t('prefs.notifyApproval')}</strong>
        <span class="sub">{t('prefs.notifyApproval.hint')}</span>
      </span>
      <input type="checkbox" checked={prefs.notifyApproval} onchange={(e) => setPref('notifyApproval', e.currentTarget.checked)} />
    </label>

    <label class="row">
      <span>
        <strong>{t('prefs.notifyError')}</strong>
        <span class="sub">{t('prefs.notifyError.hint')}</span>
      </span>
      <input type="checkbox" checked={prefs.notifyError} onchange={(e) => setPref('notifyError', e.currentTarget.checked)} />
    </label>
  </section>

  <section>
    <h2>{t('direction.title')} <span class="opt">{t('direction.optional')}</span></h2>
    <p class="hint">{t('direction.subtitle')}</p>
    <p class="desc">{t('direction.desc')}</p>

    <details class="why">
      <summary>{t('direction.whyTitle')}</summary>
      <p>{t('direction.why')}</p>
    </details>
    <details class="why">
      <summary>{t('direction.vsSkillsTitle')}</summary>
      <p>{t('direction.vsSkills')}</p>
    </details>
    <p class="contrast">{t('direction.contrast')}</p>

    {#if !hasBridge}
      <p class="hint warn">{t('direction.browserNote')}</p>
    {:else}
      <textarea
        rows="12"
        bind:value={direction}
        placeholder={t('direction.placeholder')}
        spellcheck="false"
      ></textarea>
      <div class="actions">
        {#if !direction.trim()}
          <Button onclick={insertTemplate}>{t('direction.insertTemplate')}</Button>
        {/if}
        <span class="spacer"></span>
        {#if !dirDirty && !dirSaving}<span class="savedTag">{t('direction.saved')}</span>{/if}
        <Button class="primary" onclick={saveDirection} disabled={dirSaving || !dirDirty}>
          {dirSaving ? t('direction.saving') : t('direction.save')}
        </Button>
      </div>
    {/if}
  </section>
</div>

<style>
  .prefs {
    max-width: 720px;
    padding: 24px 28px;
  }
  section {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 18px;
    margin-bottom: 16px;
  }
  h2 {
    font-size: 15px;
    margin: 0 0 4px;
  }
  .hint {
    color: var(--text-dim);
    font-size: 13px;
    margin: 0 0 14px;
  }
  .hint.warn {
    color: var(--amber, #d29922);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 0;
    border-top: 1px solid var(--border);
    cursor: pointer;
  }
  .row span {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .sub {
    color: var(--text-dim);
    font-size: 12px;
  }
  input[type='checkbox'] {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    cursor: pointer;
  }
  .opt {
    font-size: 12px;
    font-weight: 400;
    color: var(--text-dim);
  }
  .desc {
    font-size: 13px;
    line-height: 1.6;
    margin: 0 0 12px;
  }
  details.why {
    margin: 0 0 8px;
    font-size: 13px;
  }
  details.why summary {
    cursor: pointer;
    color: var(--accent-text, var(--accent));
    user-select: none;
  }
  details.why p {
    margin: 8px 0 0;
    color: var(--text-dim);
    line-height: 1.6;
  }
  .contrast {
    font-size: 12.5px;
    color: var(--text-dim);
    margin: 10px 0 14px;
  }
  textarea {
    width: 100%;
    resize: vertical;
    font-family: var(--mono, ui-monospace, Menlo, monospace);
    font-size: 13px;
    line-height: 1.55;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-2, var(--surface));
    color: var(--text);
    box-sizing: border-box;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
  }
  .actions .spacer {
    flex: 1;
  }
  .savedTag {
    font-size: 12px;
    color: var(--green, #3fb950);
  }
</style>
