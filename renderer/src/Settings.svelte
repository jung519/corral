<script lang="ts">
  import { onMount } from 'svelte';
  import { currentLang, setLang, t } from './lib/i18n.svelte';
  import * as api from './lib/api';

  let configured = $state<boolean | undefined>(undefined);

  onMount(() => {
    void api
      .getStatus()
      .then((s) => (configured = s.configured))
      .catch(() => (configured = undefined));
  });
</script>

<div class="view">
  <h1>{t('settings.title')}</h1>

  <div class="card">
    <div class="row">
      <span class="k">{t('settings.status')}</span>
      <span class="v" class:ok={configured} class:bad={configured === false}>
        {configured === undefined ? '…' : configured ? t('settings.configured') : t('settings.notConfigured')}
      </span>
    </div>
    <div class="actions">
      <button onclick={() => (location.hash = '#/setup')}>{t('settings.rerun')}</button>
    </div>
  </div>

  <div class="card">
    <div class="row">
      <span class="k">UI</span>
      <span class="lang">
        <button class:on={currentLang() === 'en'} onclick={() => setLang('en')}>EN</button>
        <button class:on={currentLang() === 'ko'} onclick={() => setLang('ko')}>한국어</button>
      </span>
    </div>
    <p class="note">{t('settings.langNote')}</p>
  </div>
</div>

<style>
  .view {
    padding: 24px 28px;
  }
  h1 {
    font-size: 18px;
    margin: 0 0 16px;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 18px;
    margin-bottom: 14px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .k {
    color: var(--text-dim);
  }
  .v.ok {
    color: var(--green);
  }
  .v.bad {
    color: var(--amber);
  }
  .actions {
    margin-top: 14px;
  }
  .lang {
    display: flex;
    gap: 6px;
  }
  .lang button.on {
    border-color: var(--accent);
    color: var(--accent-text);
  }
  .note {
    color: var(--text-dim);
    font-size: 12px;
    margin: 12px 0 0;
  }
</style>
