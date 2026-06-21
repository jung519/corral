<script lang="ts">
  import { onMount } from 'svelte';
  import { currentLang, setLang, t } from './lib/i18n.svelte';
  import * as api from './lib/api';
  import Wizard from './Wizard.svelte';
  import { CORE_STATE_KEYS, loadDraft, OPTIONAL_STATE_KEYS, secretRefs, serviceFor, type WizardState } from './lib/wizard';

  let configured = $state<boolean | undefined>(undefined);
  let s = $state<WizardState | null>(null);
  let savedSecrets = $state(new Set<string>());
  let editing = $state<string | null>(null);

  const isSaved = (service: string, account: string) => savedSecrets.has(`${service}:${account}`);
  const secret = (service: string, account: string) =>
    isSaved(service, account) ? `●●●● ${t('settings.saved')}` : t('settings.notSet');
  const langLabel = (c: string) => (c === 'ko' ? '한국어' : c === 'en' ? 'English' : c);

  async function refresh() {
    const draft = await loadDraft();
    s = draft;
    if (draft && window.corral) {
      const found = new Set<string>();
      for (const ref of secretRefs(draft)) {
        if (await window.corral.secret.has(ref.service, ref.account)) found.add(`${ref.service}:${ref.account}`);
      }
      savedSecrets = found;
    }
  }

  function onDone() {
    editing = null;
    void refresh();
  }

  onMount(() => {
    void api
      .getStatus()
      .then((r) => (configured = r.configured))
      .catch(() => (configured = undefined));
    void refresh();
  });
</script>

{#snippet row(label: string, value: string)}
  <div class="row"><span class="k">{label}</span><span class="v">{value}</span></div>
{/snippet}

{#snippet head(title: string, section: string)}
  <div class="hdr">
    <h2>{title}</h2>
    {#if editing !== section}<button class="edit" onclick={() => (editing = section)}>{t('settings.edit')}</button>{/if}
  </div>
{/snippet}

<div class="view">
  <h1>{t('settings.title')}</h1>

  {#if configured === false}
    <div class="card">
      <p class="note">{t('settings.notConfigured')}</p>
      <div class="actions"><button class="primary" onclick={() => (location.hash = '#/setup')}>{t('settings.setup')}</button></div>
    </div>
  {:else if s}
    <p class="hint">{t('settings.summaryHint')}</p>

    <div class="card">
      {@render head(t('step.ai'), 'ai')}
      {#if editing === 'ai'}
        <Wizard embedded section="ai" {onDone} />
      {:else}
        {@render row(t('repo.provider'), s.provider)}
        {@render row('Transport', s.transport)}
        {@render row(t('field.language'), langLabel(s.language))}
        {@render row(t('agent.modelsLabel'), `${s.planningModel} · ${s.implementationModel} · ${s.reviewModel}`)}
        {@render row(t('field.apiKey'), secret(serviceFor(s.provider), 'default'))}
        {#if s.provider === 'claude'}{@render row(t('field.oauthToken'), secret(serviceFor(s.provider), 'oauth'))}{/if}
      {/if}
    </div>

    <div class="card">
      {@render head(t('step.repo'), 'repo')}
      {#if editing === 'repo'}
        <Wizard embedded section="repo" {onDone} />
      {:else}
        {#each s.repos as r}
          {@render row(r.key || '—', `${r.provider} · ${r.repo}  (${r.production}/${r.development})`)}
          {#if r.description.trim()}{@render row(`  ${t('field.repoDesc')}`, r.description)}{/if}
          {@render row(`  ${t('field.repoToken')}`, secret(r.provider, r.key))}
        {/each}
        {@render row(t('field.referenceRepo'), s.referenceRepo.trim() || t('settings.none'))}
        {#if s.referenceRepo.trim()}{@render row(`  ${t('field.referenceRepo.token')}`, secret('reference', 'default'))}{/if}
      {/if}
    </div>

    <div class="card">
      {@render head(t('step.tracker'), 'tracker')}
      {#if editing === 'tracker'}
        <Wizard embedded section="tracker" {onDone} />
      {:else}
        {@render row(t('tracker.label'), s.trackerKind)}
        {#if s.trackerKind === 'notion'}
          {@render row(t('field.notionDb'), s.notionDb || '—')}
          {@render row(t('field.statusProp'), s.statusProp || '—')}
          {@render row(t('field.notionToken'), secret('notion', 'default'))}
        {:else if s.trackerKind === 'github_issues'}
          {@render row(t('field.issuesRepo'), s.issuesRepo || s.repos.find((r) => r.provider === 'github')?.repo || '—')}
          {@render row(t('field.scopeLabel'), s.scopeLabel || '—')}
        {:else}
          {@render row(t('field.jiraHost'), s.jiraHost || '—')}
          {@render row(t('field.jiraProject'), s.jiraProject || '—')}
          {@render row(t('field.jiraEmail'), s.jiraEmail || '—')}
          {@render row(t('field.jiraToken'), secret('jira', 'default'))}
        {/if}
        {@render row(
          t('states.notion'),
          [...CORE_STATE_KEYS, ...(s.detailedStates ? OPTIONAL_STATE_KEYS : [])]
            .map((k) => s!.states[k])
            .filter(Boolean)
            .join(' / '),
        )}
      {/if}
    </div>

    <div class="card">
      {@render head(t('step.workspace'), 'workspace')}
      {#if editing === 'workspace'}
        <Wizard embedded section="workspace" {onDone} />
      {:else}
        {@render row(t('workspace.backend'), s.backend === 'docker' ? t('workspace.docker') : t('workspace.local'))}
        {#if s.backend === 'docker'}{@render row(t('workspace.mountLogin'), s.dockerMountLogin ? 'on' : 'off')}{/if}
      {/if}
    </div>

    <div class="card">
      {@render head(t('step.channel'), 'channel')}
      {#if editing === 'channel'}
        <Wizard embedded section="channel" {onDone} />
      {:else}
        {@render row(t('field.maxActive'), String(s.maxActive))}
        {@render row(t('field.language'), langLabel(s.language))}
        {@render row(t('field.stack'), s.stack)}
      {/if}
    </div>
  {/if}

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
    max-width: 820px;
  }
  h1 {
    font-size: 18px;
    margin: 0 0 6px;
  }
  h2 {
    font-size: 14px;
    margin: 0;
    color: var(--text);
  }
  .hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .edit {
    font-size: 12px;
    padding: 3px 10px;
  }
  .hint {
    color: var(--text-dim);
    font-size: 12px;
    margin: 0 0 14px;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 18px;
    margin-bottom: 12px;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 3px 0;
  }
  .k {
    color: var(--text-dim);
    font-size: 13px;
    min-width: 200px;
    white-space: pre;
  }
  .v {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    word-break: break-word;
  }
  .actions {
    margin-top: 12px;
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
