<script lang="ts">
  import { t } from './lib/i18n.svelte';
</script>

<div class="view">
  <h1>Corral</h1>
  <p class="tagline">{t('about.tagline')}</p>
  <p class="byok">{t('about.byok')}</p>

  <dl>
    <dt>{t('about.license')}</dt>
    <dd>Apache-2.0</dd>
    <dt>{t('about.repo')}</dt>
    <dd><a href="https://github.com/jung519/corral" target="_blank" rel="noreferrer">github.com/jung519/corral</a></dd>
  </dl>
</div>

<style>
  .view {
    padding: 24px 28px;
  }
  h1 {
    font-size: 22px;
    margin: 0 0 6px;
  }
  .tagline {
    color: var(--text);
    margin: 0 0 6px;
  }
  .byok {
    color: var(--text-dim);
    font-size: 13px;
    margin: 0 0 20px;
  }
  dl {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 8px 12px;
    font-size: 14px;
  }
  dt {
    color: var(--text-dim);
  }
</style>
