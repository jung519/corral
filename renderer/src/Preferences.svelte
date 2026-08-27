<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from './lib/i18n.svelte';
  import { prefs, setPref } from './lib/prefs.svelte';

  const hasBridge = typeof window !== 'undefined' && !!window.corral;

  // Planning shape lives in the core's config, not in local prefs — it changes how runs
  // work, not how this window looks.
  let specMode = $state<'single' | 'split'>('single');
  let specBusy = $state(false);
  let specError = $state('');

  onMount(async () => {
    const got = await window.corral?.config.parsed();
    const c = got?.config as { spec_mode?: string } | undefined;
    if (c?.spec_mode === 'split') specMode = 'split';
  });

  async function setSpecMode(mode: 'single' | 'split') {
    if (specBusy || mode === specMode) return;
    specBusy = true;
    specError = '';
    const res = await window.corral?.config.specMode(mode);
    if (res && !res.ok) specError = res.error ?? '';
    else specMode = mode;
    specBusy = false;
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

  {#if hasBridge}
    <section>
      <h2>{t('prefs.specMode')}</h2>
      <p class="hint">{t('prefs.specMode.hint')}</p>

      <label class="row">
        <span>
          <strong>{t('prefs.specMode.single')}</strong>
          <span class="sub">{t('prefs.specMode.single.hint')}</span>
        </span>
        <input type="radio" name="spec-mode" checked={specMode === 'single'} disabled={specBusy} onchange={() => setSpecMode('single')} />
      </label>

      <label class="row">
        <span>
          <strong>{t('prefs.specMode.split')}</strong>
          <!-- The cost is the reason the default is `single`; someone turning it on
               should read it here rather than discover it in a bill (CRL-101). -->
          <span class="sub">{t('prefs.specMode.split.hint')}</span>
        </span>
        <input type="radio" name="spec-mode" checked={specMode === 'split'} disabled={specBusy} onchange={() => setSpecMode('split')} />
      </label>

      {#if specError}<p class="hint warn">{specError}</p>{/if}
    </section>
  {/if}
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
</style>
