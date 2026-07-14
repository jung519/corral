<script lang="ts">
  import { onMount } from 'svelte';
  import * as api from './lib/api';
  import Button from './lib/Button.svelte';
  import { t } from './lib/i18n.svelte';

  const hasBridge = typeof window !== 'undefined' && !!window.corral;

  // Global Direction (방향성) — free text persisted to userData/direction.md via the
  // desktop bridge. `dirConsent` is the one-time consent to spend AI on validating the
  // text at issue start (§15). This lives in Setup because Direction is a peer of
  // skills/profile — a "how the agent should work" setting, not a per-user preference.
  let direction = $state('');
  let savedDirection = $state('');
  let dirSaving = $state(false);
  let dirConsent = $state(false);
  const dirDirty = $derived(direction !== savedDirection);

  onMount(async () => {
    if (!hasBridge) return;
    try {
      direction = savedDirection = (await window.corral!.direction.read()) ?? '';
    } catch {
      /* leave empty — the card still renders */
    }
    try {
      dirConsent = (await api.getDirectionConsent()).consent;
    } catch {
      /* core may be unreachable — leave consent off */
    }
  });

  async function toggleConsent(value: boolean) {
    try {
      dirConsent = (await api.setDirectionConsent(value)).consent;
    } catch {
      /* keep the previous state on failure */
    }
  }

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

<div class="card">
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
    <div class="consent">
      <label class="ctoggle">
        <input type="checkbox" checked={dirConsent} onchange={(e) => toggleConsent(e.currentTarget.checked)} />
        <strong>{t('direction.consent')}</strong>
      </label>
      <details class="why">
        <summary>{t('direction.c.summary')}</summary>
        <ul class="cwhy">
          <li><b>{t('direction.c.whyK')}</b> {t('direction.c.whyV')}</li>
          <li><b>{t('direction.c.whenK')}</b> {t('direction.c.whenV')}</li>
          <li><b>{t('direction.c.costK')}</b> {t('direction.c.costV')}</li>
          <li><b>{t('direction.c.offK')}</b> {t('direction.c.offV')}</li>
        </ul>
      </details>
      {#if !dirConsent}<p class="hint warn">{t('direction.notApplied')}</p>{/if}
    </div>

    <textarea rows="12" bind:value={direction} placeholder={t('direction.placeholder')} spellcheck="false"></textarea>
    <div class="actions">
      {#if !direction.trim()}
        <Button onclick={insertTemplate}>{t('direction.insertTemplate')}</Button>
      {/if}
      <span class="spacer"></span>
      {#if savedDirection.trim() && !dirDirty && !dirSaving}<span class="savedTag">{t('direction.saved')}</span>{/if}
      <Button class="primary" onclick={saveDirection} disabled={dirSaving || !dirDirty || !dirConsent}>
        {dirSaving ? t('direction.saving') : t('direction.save')}
      </Button>
    </div>
  {/if}
</div>

<style>
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 18px;
    margin-bottom: 12px;
  }
  h2 {
    font-size: 14px;
    margin: 0 0 4px;
    color: var(--text);
  }
  .opt {
    font-size: 12px;
    font-weight: 400;
    color: var(--text-dim);
  }
  .hint {
    color: var(--text-dim);
    font-size: 12px;
    margin: 0 0 10px;
  }
  .hint.warn {
    color: var(--amber, #d29922);
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
  .consent {
    margin: 4px 0 14px;
  }
  .ctoggle {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 13px;
    margin-bottom: 6px;
  }
  .ctoggle input {
    width: 16px;
    height: 16px;
    cursor: pointer;
  }
  .cwhy {
    margin: 8px 0 0;
    padding-left: 24px;
    color: var(--text-dim);
    font-size: 12.5px;
    line-height: 1.7;
  }
  .cwhy b {
    color: var(--text);
    font-weight: 500;
  }
</style>
