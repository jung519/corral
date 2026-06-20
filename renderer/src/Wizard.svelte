<script lang="ts">
  import { onMount } from 'svelte';
  import { currentLang, setLang, t } from './lib/i18n.svelte';
  import * as api from './lib/api';
  import {
    buildConfigYaml,
    clearDraft,
    CORE_STATE_KEYS,
    defaultModels,
    initialState,
    loadDraft,
    MODELS,
    newRepo,
    OPTIONAL_STATE_KEYS,
    type RepoProvider,
    saveDraft,
    secretRefs,
    secretsFor,
    serviceFor,
    type TrackerKind,
    validateStep,
    type WizardState,
  } from './lib/wizard';

  const stepKeys = ['step.ai', 'step.repo', 'step.tracker', 'step.workspace', 'step.channel'];

  const providers: Array<{ id: WizardState['provider']; name: string; icon: string }> = [
    { id: 'claude', name: 'Claude', icon: '<path d="M12 3v18M3 12h18M6 6l12 12M18 6 6 18"/>' },
    { id: 'gemini', name: 'Gemini', icon: '<path d="M12 3l7 9-7 9-7-9z"/>' },
    { id: 'gpt', name: 'GPT', icon: '<circle cx="12" cy="12" r="8"/>' },
  ];

  let s: WizardState = $state(initialState());
  let step = $state(0);
  let error = $state('');
  let saving = $state(false);
  let docker = $state<{ available: boolean; version?: string } | null>(null);

  const hasBridge = typeof window !== 'undefined' && !!window.corral;

  // Secrets already persisted to the keychain (shown as "saved" so you needn't retype
  // a token after a restart). Keyed "service:account".
  let savedSecrets = $state(new Set<string>());
  const secretKey = (service: string, account: string) => `${service}:${account}`;
  const secretSaved = (service: string, account: string) => savedSecrets.has(secretKey(service, account));

  // Restore the in-progress draft (non-secret fields) + mark which tokens are saved.
  onMount(async () => {
    const draft = loadDraft();
    if (draft) s = draft;
    if (!window.corral) return;
    const found = new Set<string>();
    for (const ref of secretRefs(s)) {
      if (await window.corral.secret.has(ref.service, ref.account)) found.add(secretKey(ref.service, ref.account));
    }
    savedSecrets = found;
  });

  // "Save & next": persist the non-secret draft (localStorage) and any entered tokens
  // (encrypted into the keychain) before moving. Tokens never touch the draft file.
  async function persistStep() {
    saveDraft(s);
    if (!window.corral) return;
    const found = new Set(savedSecrets);
    for (const sec of secretsFor(s)) {
      try {
        await window.corral.secret.set(sec.service, sec.account, sec.value);
        found.add(secretKey(sec.service, sec.account));
      } catch {
        /* surfaced at finish */
      }
    }
    savedSecrets = found;
  }

  // Selecting a provider resets the per-stage models to that provider's defaults
  // (so the model selects always offer valid options for the chosen agent).
  function setProvider(p: WizardState['provider']) {
    s.provider = p;
    const d = defaultModels(p);
    s.planningModel = d.planning;
    s.implementationModel = d.implementation;
    s.reviewModel = d.review;
  }

  // Non-sequential: jump to any step freely; validation is per-item (sidebar ✓) and
  // a full check at Finish (which jumps to the first invalid step).
  function goTo(i: number) {
    error = '';
    void persistStep();
    step = i;
  }
  function next() {
    error = '';
    void persistStep();
    if (step < stepKeys.length - 1) step += 1;
  }
  function back() {
    error = '';
    void persistStep();
    if (step > 0) step -= 1;
  }
  function valid(i: number): boolean {
    return validateStep(i, s) === '';
  }

  async function detectDocker() {
    docker = (await window.corral?.detectDocker()) ?? { available: false };
  }

  type TestState = { ok: boolean; detail?: string } | 'pending' | undefined;
  let test = $state<Record<string, TestState>>({});

  async function testAgent() {
    if (!window.corral || !s.agentKey) return;
    test.agent = 'pending';
    test.agent = await window.corral.validate.agent(s.provider, s.agentKey);
  }
  async function testGithub(i: number, token: string) {
    if (!window.corral || !token) return;
    test[`gh-${i}`] = 'pending';
    test[`gh-${i}`] = await window.corral.validate.github(token);
  }

  function addRepo() {
    s.repos = [...s.repos, newRepo()];
  }
  function removeRepo(i: number) {
    s.repos = s.repos.filter((_, j) => j !== i);
  }
  async function testNotion() {
    if (!window.corral || !s.notionToken) return;
    test.notion = 'pending';
    test.notion = await window.corral.validate.notion(s.notionToken);
  }

  const agentPinged = $derived(typeof test.agent === 'object' && test.agent?.ok === true);

  async function finish() {
    for (let i = 0; i < stepKeys.length; i++) {
      const e = validateStep(i, s);
      if (e) {
        step = i;
        error = e;
        return;
      }
    }
    saving = true;
    try {
      if (window.corral) {
        // Write the config first so it always lands, even if a later step throws.
        await window.corral.config.write(buildConfigYaml(s));
        for (const sec of secretsFor(s)) await window.corral.secret.set(sec.service, sec.account, sec.value);
        await window.corral.startOrchestrator();
      } else {
        const out = await api.setup({ config: buildConfigYaml(s), secrets: secretsFor(s) });
        if (!out.ok) {
          error = out.message ?? 'Setup failed.';
          saving = false;
          return;
        }
      }
      clearDraft();
      location.hash = '#/';
      location.reload();
    } catch (err) {
      error = `Save failed: ${err instanceof Error ? err.message : String(err)}`;
      saving = false;
    }
  }
</script>

{#snippet badge(state: TestState)}
  {#if state === 'pending'}
    <span class="badge">{t('status.testing')}</span>
  {:else if state}
    <span class="badge" class:bad={!state.ok}>{state.ok ? `✓ ${t('status.validated')}` : `✗ ${state.detail ?? t('status.failed')}`}</span>
  {/if}
{/snippet}

<div class="wizard">
  <aside>
    <p class="brand">{t('wizard.sidebar')}</p>
    <ol>
      {#each stepKeys as key, i}
        <li>
          <button class="step" class:active={i === step} class:done={valid(i)} onclick={() => goTo(i)}>
            <span class="ico">{valid(i) ? '✓' : '▢'}</span>{t(key)}
          </button>
        </li>
      {/each}
    </ol>
    <div class="progress">
      <span>{currentLang() === 'ko' ? '진행률' : 'Step'} {step + 1} / {stepKeys.length}</span>
      <div class="bar"><div style:width={`${((step + 1) / stepKeys.length) * 100}%`}></div></div>
    </div>
    <div class="lang">
      <button class:on={currentLang() === 'en'} onclick={() => setLang('en')}>EN</button>
      <button class:on={currentLang() === 'ko'} onclick={() => setLang('ko')}>한국어</button>
    </div>
  </aside>

  <section>
    <button class="close" onclick={() => (location.hash = '#/')}>✕ {t('wizard.exit')}</button>
    {#if step === 0}
      <h1>{t('step.ai')}</h1>
      <p class="subtitle">{t('step0.subtitle')}</p>

      <div class="providers">
        {#each providers as p}
          <button class="provider" class:sel={s.provider === p.id} onclick={() => setProvider(p.id)}>
            <svg class="picon" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">{@html p.icon}</svg>
            <span class="pname">{p.name}</span>
          </button>
        {/each}
      </div>

      <div class="transports">
        <button class="transport" class:sel={s.transport === 'api'} onclick={() => (s.transport = 'api')}>
          <span class="radio" class:on={s.transport === 'api'}></span>{t('transport.api')}
        </button>
        <button class="transport" class:sel={s.transport === 'cli'} onclick={() => (s.transport = 'cli')}>
          <span class="radio" class:on={s.transport === 'cli'}></span>{t('transport.cli')}
        </button>
      </div>

      <label class="field"
        ><span>{t('field.apiKey')}{s.transport === 'cli' ? t('field.apiKey.optionalCli') : ''}</span>
        <div class="keyrow">
          <input
            type="password"
            bind:value={s.agentKey}
            placeholder={!s.agentKey && secretSaved(serviceFor(s.provider), 'default') ? t('field.secretSaved') : 'sk-ant-...'}
            onblur={testAgent}
          />
          {@render badge(test.agent)}
        </div></label
      >
      {#if s.transport === 'cli'}<p class="hint">{t('cli.hint')}</p>{/if}
      {#if agentPinged}<p class="helper">{t('agent.pingOk')}</p>{/if}

      <span class="lbl">{t('agent.modelsLabel')}</span>
      <div class="three">
        <label class="field"
          ><span>{t('field.planningModel')}</span>
          <select bind:value={s.planningModel}>
            {#each MODELS[s.provider] as m}<option value={m}>{m}</option>{/each}
          </select></label
        >
        <label class="field"
          ><span>{t('field.implModel')}</span>
          <select bind:value={s.implementationModel}>
            {#each MODELS[s.provider] as m}<option value={m}>{m}</option>{/each}
          </select></label
        >
        <label class="field"
          ><span>{t('field.reviewModel')}</span>
          <select bind:value={s.reviewModel}>
            {#each MODELS[s.provider] as m}<option value={m}>{m}</option>{/each}
          </select></label
        >
      </div>
    {:else if step === 1}
      <h1>{t('step.repo')}</h1>
      <p class="subtitle">{t('repo.multiHint')}</p>
      {#each s.repos as r, i (i)}
        <div class="repo-card">
          <div class="repo-head">
            <span class="repo-num">{r.key || `#${i + 1}`}</span>
            {#if s.repos.length > 1}
              <button class="ghost-x" onclick={() => removeRepo(i)} title={t('repo.remove')}>✕</button>
            {/if}
          </div>
          <div class="transports tri">
            {#each ['github', 'gitlab', 'bitbucket'] as p}
              <button class="transport" class:sel={r.provider === p} onclick={() => (r.provider = p as RepoProvider)}>
                <span class="radio" class:on={r.provider === p}></span>{p}
              </button>
            {/each}
          </div>
          {#if r.provider === 'gitlab'}
            <label class="field"><span>{t('field.gitlabHost')}</span><input bind:value={r.gitlabHost} /></label>
          {:else if r.provider === 'bitbucket'}
            <label class="field"><span>{t('field.bitbucketUser')}</span><input bind:value={r.bitbucketUser} /></label>
          {/if}
          <div class="two">
            <label class="field"
              ><span>{t('field.repo')}</span>
              <input bind:value={r.repo} placeholder={r.provider === 'bitbucket' ? 'workspace/slug' : 'acme/widgets'} /></label
            >
            <label class="field"><span>{t('field.repoKey')}</span><input bind:value={r.key} placeholder="server" /></label>
          </div>
          <label class="field"
            ><span>{t('field.repoDesc')}</span>
            <input bind:value={r.description} placeholder={t('field.repoDescPlaceholder')} /></label
          >
          <label class="field"
            ><span>{t('field.repoToken')}</span>
            <div class="keyrow">
              <input
                type="password"
                bind:value={r.token}
                placeholder={!r.token && secretSaved(r.provider, r.key) ? t('field.secretSaved') : ''}
                onblur={() => (r.provider === 'github' ? testGithub(i, r.token) : undefined)}
              />
              {#if r.provider === 'github'}{@render badge(test[`gh-${i}`])}{/if}
            </div></label
          >
          <div class="two">
            <label class="field"><span>{t('field.prodBranch')}</span><input bind:value={r.production} /></label>
            <label class="field"><span>{t('field.devBranch')}</span><input bind:value={r.development} /></label>
          </div>
        </div>
      {/each}
      <button class="add-repo" onclick={addRepo}>{t('repo.add')}</button>
    {:else if step === 2}
      <h1>{t('step.tracker')}</h1>
      <span class="lbl">{t('tracker.label')}</span>
      <div class="transports tri">
        <button class="transport" class:sel={s.trackerKind === 'notion'} onclick={() => (s.trackerKind = 'notion' as TrackerKind)}>
          <span class="radio" class:on={s.trackerKind === 'notion'}></span>Notion
        </button>
        <button
          class="transport"
          class:sel={s.trackerKind === 'github_issues'}
          onclick={() => (s.trackerKind = 'github_issues' as TrackerKind)}
        >
          <span class="radio" class:on={s.trackerKind === 'github_issues'}></span>GitHub Issues
        </button>
        <button class="transport" class:sel={s.trackerKind === 'jira'} onclick={() => (s.trackerKind = 'jira' as TrackerKind)}>
          <span class="radio" class:on={s.trackerKind === 'jira'}></span>Jira
        </button>
      </div>

      {#if s.trackerKind === 'notion'}
        <label class="field"><span>{t('field.notionDb')}</span><input bind:value={s.notionDb} /></label>
        <label class="field"
          ><span>{t('field.notionToken')}</span>
          <div class="keyrow">
            <input
              type="password"
              bind:value={s.notionToken}
              placeholder={!s.notionToken && secretSaved('notion', 'default') ? t('field.secretSaved') : ''}
              onblur={testNotion}
            />
            {@render badge(test.notion)}
          </div></label
        >
        <div class="two">
          <label class="field"><span>{t('field.statusProp')}</span><input bind:value={s.statusProp} /></label>
          <label class="field"><span>{t('field.idProp')}</span><input bind:value={s.idProp} /></label>
        </div>
        <div class="two">
          <label class="field"><span>{t('field.repoProp')}</span><input bind:value={s.repoProp} /></label>
          <label class="field"><span>{t('field.scopeProp')}</span><input bind:value={s.scopeProp} /></label>
        </div>
      {:else if s.trackerKind === 'github_issues'}
        <label class="field"><span>{t('field.issuesRepo')}</span><input bind:value={s.issuesRepo} placeholder={s.repos[0]?.repo || 'owner/name'} /></label>
        <div class="two">
          <label class="field"><span>{t('field.scopeLabel')}</span><input bind:value={s.scopeLabel} /></label>
          <label class="field"><span>{t('field.idPrefix')}</span><input bind:value={s.identifierPrefix} /></label>
        </div>
        <p class="helper">{t('tracker.ghHint')}</p>
      {:else}
        <label class="field"><span>{t('field.jiraHost')}</span><input bind:value={s.jiraHost} placeholder="https://team.atlassian.net" /></label>
        <div class="two">
          <label class="field"><span>{t('field.jiraProject')}</span><input bind:value={s.jiraProject} /></label>
          <label class="field"><span>{t('field.jiraEmail')}</span><input bind:value={s.jiraEmail} /></label>
        </div>
        <label class="field"
          ><span>{t('field.jiraToken')}</span><input
            type="password"
            bind:value={s.jiraToken}
            placeholder={!s.jiraToken && secretSaved('jira', 'default') ? t('field.secretSaved') : ''}
          /></label
        >
      {/if}

      <span class="lbl"
        >{s.trackerKind === 'notion' ? t('states.notion') : s.trackerKind === 'jira' ? t('states.jira') : t('states.github')}</span
      >
      <div class="states">
        {#each CORE_STATE_KEYS as k}
          <label><span>{t(`state.${k}`)}</span><input bind:value={s.states[k]} /></label>
        {/each}
        {#if s.detailedStates}
          {#each OPTIONAL_STATE_KEYS as k}
            <label><span>{t(`state.${k}`)}</span><input bind:value={s.states[k]} /></label>
          {/each}
        {/if}
      </div>
      <label class="check">
        <input type="checkbox" bind:checked={s.detailedStates} />
        <span>{t('states.detailToggle')}</span>
      </label>
      <p class="hint">{t('states.detailHint')}</p>
    {:else if step === 3}
      <h1>{t('step.workspace')}</h1>
      <p class="subtitle">{t('workspace.desc')}</p>
      <span class="lbl">{t('workspace.backend')}</span>
      <div class="transports">
        <button class="transport" class:sel={s.backend === 'local'} onclick={() => (s.backend = 'local')}>
          <span class="radio" class:on={s.backend === 'local'}></span>{t('workspace.local')}
        </button>
        <button class="transport" class:sel={s.backend === 'docker'} onclick={() => (s.backend = 'docker')}>
          <span class="radio" class:on={s.backend === 'docker'}></span>{t('workspace.docker')}
        </button>
      </div>
      <div class="testrow">
        <button onclick={detectDocker} disabled={!hasBridge}>{t('workspace.detect')}</button>
        {#if docker}<span class="badge" class:bad={!docker.available}>{docker.available ? `✓ ${docker.version}` : t('workspace.dockerNone')}</span>{/if}
      </div>
    {:else if step === 4}
      <h1>{t('step.channel')}</h1>
      <div class="two">
        {#if !hasBridge}
          <label class="field"><span>{t('field.port')}</span><input type="number" bind:value={s.port} /></label>
        {/if}
        <label class="field"
          ><span>{t('field.maxActive')}</span>
          <select bind:value={s.maxActive}>
            {#each [1, 2, 3, 4, 5, 6, 8, 10] as n}<option value={n}>{n}</option>{/each}
          </select></label
        >
      </div>
      <div class="two">
        <label class="field"
          ><span>{t('field.language')}</span>
          <select bind:value={s.language}>
            <option value="en">English</option>
            <option value="ko">한국어</option>
          </select></label
        >
        <label class="field"
          ><span>{t('field.stack')}</span>
          <select bind:value={s.stack}>
            <option value="generic">generic</option>
            <option value="nestjs">nestjs</option>
            <option value="flutter">flutter</option>
          </select></label
        >
      </div>
      <p class="hint">{t('field.stackDesc')}</p>
    {/if}

    {#if error}<p class="error">{error}</p>{/if}
    {#if !hasBridge}<p class="preview">{t('wizard.browserPreview')}</p>{/if}

    <footer>
      <button onclick={back} disabled={step === 0}>{t('wizard.back')}</button>
      {#if step < stepKeys.length - 1}
        <button class="primary" onclick={next}>{t('wizard.next')} · {t(stepKeys[step + 1])}</button>
      {:else}
        <button class="primary" onclick={finish} disabled={saving}>{saving ? t('wizard.saving') : t('wizard.finish')}</button>
      {/if}
    </footer>
  </section>
</div>

<style>
  .wizard {
    display: grid;
    grid-template-columns: 240px 1fr;
    min-height: 100vh;
  }
  aside {
    background: var(--surface);
    border-right: 1px solid var(--border);
    padding: 22px 16px;
    display: flex;
    flex-direction: column;
  }
  .brand {
    color: var(--text-dim);
    font-size: 13px;
    margin: 0 0 14px;
    padding-left: 6px;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .step {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 8px;
    border: none;
    background: transparent;
    color: var(--text-dim);
    font-size: 14px;
    text-align: left;
    cursor: pointer;
  }
  .step:hover {
    background: var(--surface-2);
  }
  .step .ico {
    font-size: 13px;
    opacity: 0.8;
  }
  .step.done {
    color: var(--green);
  }
  .step.active {
    background: var(--accent);
    color: var(--accent-text);
  }
  .progress {
    margin-top: 20px;
    padding-left: 6px;
  }
  .progress span {
    font-size: 12px;
    color: var(--text-dim);
  }
  .progress .bar {
    height: 4px;
    background: var(--surface-2);
    border-radius: 4px;
    margin-top: 6px;
    overflow: hidden;
  }
  .progress .bar div {
    height: 4px;
    background: var(--accent);
  }
  .lang {
    margin-top: auto;
    display: flex;
    gap: 6px;
    padding-top: 16px;
  }
  .lang button {
    flex: 1;
    font-size: 12px;
    padding: 5px 0;
  }
  .lang button.on {
    border-color: var(--accent);
    color: var(--accent-text);
  }
  section {
    position: relative;
    padding: 30px 36px;
    max-width: 860px;
  }
  .close {
    position: absolute;
    top: 22px;
    right: 28px;
    font-size: 13px;
    padding: 5px 12px;
  }
  h1 {
    font-size: 22px;
    margin: 0 0 6px;
  }
  .subtitle {
    color: var(--text-dim);
    margin: 0 0 22px;
  }
  .providers {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    margin-bottom: 14px;
  }
  .provider {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 22px 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-dim);
  }
  .provider.sel {
    border: 2px solid var(--accent);
    color: var(--text);
  }
  .provider .pname {
    font-size: 15px;
    font-weight: 500;
  }
  .transports {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 18px;
  }
  .transports.tri {
    grid-template-columns: 1fr 1fr 1fr;
  }
  .transport {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-dim);
    text-align: left;
  }
  .transport.sel {
    border-color: var(--accent);
    color: var(--text);
  }
  .radio {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 1px solid var(--border);
    flex-shrink: 0;
  }
  .radio.on {
    border: 5px solid var(--accent);
  }
  .lbl {
    display: block;
    font-size: 13px;
    color: var(--text-dim);
    margin: 14px 0 8px;
  }
  .field {
    display: block;
    margin-top: 16px;
  }
  .field > span {
    display: block;
    font-size: 13px;
    color: var(--text-dim);
    margin-bottom: 6px;
  }
  .keyrow {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .keyrow input {
    flex: 1;
  }
  .badge {
    font-size: 13px;
    color: var(--green);
    white-space: nowrap;
  }
  .badge.bad {
    color: var(--red);
  }
  .helper {
    color: var(--text-dim);
    font-size: 13px;
    margin: 10px 0 0;
  }
  .two {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }
  .three {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 14px;
  }
  .states {
    display: grid;
    gap: 8px;
  }
  .states label {
    display: grid;
    grid-template-columns: 130px 1fr;
    align-items: center;
    gap: 10px;
  }
  .states span {
    font-size: 13px;
    color: var(--text-dim);
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 14px;
    font-size: 13px;
    cursor: pointer;
  }
  .check input {
    width: auto;
    margin: 0;
  }
  .testrow {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 12px;
  }
  .repo-card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 16px 18px;
    margin-bottom: 14px;
    background: var(--surface);
  }
  .repo-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 8px 0 12px;
  }
  .repo-num {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }
  .ghost-x {
    border: none;
    background: transparent;
    color: var(--text-dim);
    font-size: 14px;
    cursor: pointer;
    padding: 2px 6px;
  }
  .ghost-x:hover {
    color: var(--red);
  }
  .add-repo {
    width: 100%;
    padding: 11px 0;
    border: 1px dashed var(--border);
    border-radius: var(--radius);
    color: var(--text-dim);
    background: transparent;
    cursor: pointer;
  }
  .add-repo:hover {
    border-color: var(--accent);
    color: var(--text);
  }
  .repo-card .transports {
    margin-bottom: 0;
  }
  .error {
    color: var(--red);
    font-size: 13px;
    margin-top: 16px;
  }
  .preview {
    color: var(--amber);
    font-size: 12px;
    margin-top: 12px;
  }
  footer {
    display: flex;
    justify-content: space-between;
    margin-top: 28px;
    border-top: 1px solid var(--border);
    padding-top: 20px;
  }
</style>
