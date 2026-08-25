<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from './lib/i18n.svelte';

  let version = $state('');
  onMount(async () => {
    try {
      version = (await window.corral?.appVersion()) ?? '';
    } catch {
      /* browser preview — no bridge */
    }
  });

  // The attribution list, loaded when asked for. It is ~900 lines, so it stays out of the
  // way until someone opens it — but it has to be reachable, which is the point: `NOTICE`
  // named this screen before the screen existed (CRL-118).
  let licenses = $state<string | null | undefined>(undefined);
  let loading = $state(false);
  async function loadLicenses() {
    if (licenses !== undefined || loading) return;
    loading = true;
    try {
      licenses = (await window.corral?.thirdPartyLicenses()) ?? null;
    } catch {
      licenses = null;
    } finally {
      loading = false;
    }
  }
</script>

<div class="view">
  <h1>Corral</h1>
  <p class="tagline">{t('about.tagline')}</p>

  <!-- The same words the mode picker uses. Two places describing the two pillars in two
       wordings is two places to drift. -->
  <ul class="pillars">
    <li><strong>{t('mode.dev')}</strong> — {t('mode.dev.body')}</li>
    <li><strong>{t('mode.ops')}</strong> — {t('mode.ops.body')}</li>
  </ul>

  <p class="byok">{t('about.byok')}</p>

  <dl>
    {#if version}
      <dt>{t('about.version')}</dt>
      <dd>v{version}</dd>
    {/if}
    <dt>{t('about.license')}</dt>
    <dd>Apache-2.0</dd>
    <dt>{t('about.repo')}</dt>
    <dd><a href="https://github.com/jung519/corral" target="_blank" rel="noreferrer">github.com/jung519/corral</a></dd>
  </dl>

  <details class="oss" ontoggle={loadLicenses}>
    <summary>{t('about.oss')}</summary>
    {#if loading}
      <p class="hint">{t('about.ossLoading')}</p>
    {:else if licenses}
      <pre>{licenses}</pre>
    {:else if licenses === null}
      <p class="hint warn">{t('about.ossMissing')}</p>
    {/if}
  </details>
</div>

<style>
  .view {
    padding: 24px 28px;
  }
  .oss {
    margin-top: 18px;
    font-size: 13px;
  }
  .oss summary {
    cursor: pointer;
    color: var(--text-dim);
  }
  /* Long, pre-formatted, and not something to reflow — let it scroll in its own box
     rather than stretching the page. */
  .oss pre {
    margin: 10px 0 0;
    max-height: 320px;
    overflow: auto;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    font-size: 11px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .hint {
    color: var(--text-dim);
    font-size: 12px;
    margin: 10px 0 0;
  }
  .hint.warn {
    color: var(--warning, #d29922);
  }
  h1 {
    font-size: 22px;
    margin: 0 0 6px;
  }
  .tagline {
    color: var(--text);
    margin: 0 0 6px;
  }
  .pillars {
    list-style: none;
    margin: 12px 0 16px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: var(--text-dim);
    max-width: 640px;
  }
  .pillars strong {
    color: var(--text);
    font-weight: 500;
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
