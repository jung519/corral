<script lang="ts">
  import { t } from './lib/i18n.svelte';
  import { prefs, setPref } from './lib/prefs.svelte';

  const hasBridge = typeof window !== 'undefined' && !!window.corral;
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
