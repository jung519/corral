<script lang="ts">
  import { onMount } from 'svelte';
  import { currentLang, setLang, t } from './lib/i18n.svelte';
  import {
    buildConfigYaml,
    initialState,
    secretsFor,
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

  // Already configured? Then this is a re-run from Settings → allow closing back.
  let canExit = $state(false);
  onMount(() => {
    fetch('/api/status')
      .then((r) => r.json())
      .then((s: { configured: boolean }) => (canExit = s.configured))
      .catch(() => {});
  });

  function next() {
    const e = validateStep(step, s);
    if (e) {
      error = e;
      return;
    }
    error = '';
    if (step < stepKeys.length - 1) step += 1;
  }
  function back() {
    error = '';
    if (step > 0) step -= 1;
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
  async function testGithub() {
    if (!window.corral || !s.githubToken) return;
    test.github = 'pending';
    test.github = await window.corral.validate.github(s.githubToken);
  }
  async function testNotion() {
    if (!window.corral || !s.notionToken) return;
    test.notion = 'pending';
    test.notion = await window.corral.validate.notion(s.notionToken);
  }

  const agentPinged = $derived(typeof test.agent === 'object' && test.agent?.ok === true);
  const helper = $derived(
    `${agentPinged ? `${t('agent.pingOk')} · ` : ''}${t('agent.modelsLabel')}: planning=${s.planningModel}, implementation=${s.implementationModel}`,
  );

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
        for (const sec of secretsFor(s)) await window.corral.secret.set(sec.service, sec.account, sec.value);
        await window.corral.config.write(buildConfigYaml(s));
        await window.corral.startOrchestrator();
      } else {
        const res = await fetch('/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: buildConfigYaml(s), secrets: secretsFor(s) }),
        });
        const out = (await res.json()) as { ok: boolean; message?: string };
        if (!out.ok) {
          error = out.message ?? 'Setup failed.';
          saving = false;
          return;
        }
      }
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
        <li class:active={i === step} class:done={i < step}>
          <span class="ico">{i < step ? '✓' : '▢'}</span>{t(key)}
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
    {#if canExit}
      <button class="close" onclick={() => (location.hash = '#/')}>✕ {t('wizard.exit')}</button>
    {/if}
    {#if step === 0}
      <h1>{t('step.ai')}</h1>
      <p class="subtitle">{t('step0.subtitle')}</p>

      <div class="providers">
        {#each providers as p}
          <button class="provider" class:sel={s.provider === p.id} onclick={() => (s.provider = p.id)}>
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
          <input type="password" bind:value={s.agentKey} placeholder="sk-ant-..." onblur={testAgent} />
          {@render badge(test.agent)}
        </div></label
      >
      <p class="helper">{helper}</p>
    {:else if step === 1}
      <h1>{t('step.repo')}</h1>
      <label class="field"><span>{t('field.repo')}</span><input bind:value={s.repo} placeholder="acme/widgets" /></label>
      <label class="field"
        ><span>{t('field.githubToken')}</span>
        <div class="keyrow">
          <input type="password" bind:value={s.githubToken} onblur={testGithub} />
          {@render badge(test.github)}
        </div></label
      >
      <div class="two">
        <label class="field"><span>{t('field.routingKey')}</span><input bind:value={s.repoKey} /></label>
        <label class="field"><span>{t('field.prodBranch')}</span><input bind:value={s.production} /></label>
      </div>
      <label class="field"><span>{t('field.devBranch')}</span><input bind:value={s.development} /></label>
    {:else if step === 2}
      <h1>{t('step.tracker')}</h1>
      <span class="lbl">{t('tracker.label')}</span>
      <div class="transports">
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
      </div>

      {#if s.trackerKind === 'notion'}
        <label class="field"><span>{t('field.notionDb')}</span><input bind:value={s.notionDb} /></label>
        <label class="field"
          ><span>{t('field.notionToken')}</span>
          <div class="keyrow">
            <input type="password" bind:value={s.notionToken} onblur={testNotion} />
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
      {:else}
        <label class="field"><span>{t('field.issuesRepo')}</span><input bind:value={s.issuesRepo} placeholder={s.repo || 'owner/name'} /></label>
        <div class="two">
          <label class="field"><span>{t('field.scopeLabel')}</span><input bind:value={s.scopeLabel} /></label>
          <label class="field"><span>{t('field.idPrefix')}</span><input bind:value={s.identifierPrefix} /></label>
        </div>
        <p class="helper">{t('tracker.ghHint')}</p>
      {/if}

      <span class="lbl">{s.trackerKind === 'notion' ? t('states.notion') : t('states.github')}</span>
      <div class="states">
        {#each Object.keys(s.states) as k}
          <label><span>{k}</span><input bind:value={s.states[k as keyof WizardState['states']]} /></label>
        {/each}
      </div>
    {:else if step === 3}
      <h1>{t('step.workspace')}</h1>
      <span class="lbl">{t('workspace.backend')}</span>
      <div class="transports">
        {#each ['local', 'docker'] as b}
          <button class="transport" class:sel={s.backend === b} onclick={() => (s.backend = b as WizardState['backend'])}>
            <span class="radio" class:on={s.backend === b}></span>{b}
          </button>
        {/each}
      </div>
      <div class="testrow">
        <button onclick={detectDocker} disabled={!hasBridge}>{t('workspace.detect')}</button>
        {#if docker}<span class="badge" class:bad={!docker.available}>{docker.available ? `✓ ${docker.version}` : t('workspace.dockerNone')}</span>{/if}
      </div>
    {:else if step === 4}
      <h1>{t('step.channel')}</h1>
      <div class="two">
        <label class="field"><span>{t('field.port')}</span><input type="number" bind:value={s.port} /></label>
        <label class="field"><span>{t('field.maxActive')}</span><input type="number" bind:value={s.maxActive} /></label>
      </div>
      <div class="two">
        <label class="field"><span>{t('field.language')}</span><input bind:value={s.language} /></label>
        <label class="field"><span>{t('field.stack')}</span><input bind:value={s.stack} /></label>
      </div>
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
  li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 8px;
    color: var(--text-dim);
    font-size: 14px;
  }
  li .ico {
    font-size: 13px;
    opacity: 0.8;
  }
  li.active {
    background: var(--accent);
    color: var(--accent-text);
  }
  li.done {
    color: var(--green);
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
  .testrow {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 12px;
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
