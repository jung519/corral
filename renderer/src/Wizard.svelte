<script lang="ts">
  import {
    buildConfigYaml,
    initialState,
    secretsFor,
    type TrackerKind,
    validateStep,
    type WizardState,
  } from './lib/wizard';

  const steps = ['AI provider', 'Repository', 'Tracker', 'Workspace', 'Channel & budget'];

  let s: WizardState = $state(initialState());
  let step = $state(0);
  let error = $state('');
  let saving = $state(false);
  let docker = $state<{ available: boolean; version?: string } | null>(null);

  const hasBridge = typeof window !== 'undefined' && !!window.corral;

  function next() {
    const e = validateStep(step, s);
    if (e) {
      error = e;
      return;
    }
    error = '';
    if (step < steps.length - 1) step += 1;
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
    if (!window.corral) return;
    test.agent = 'pending';
    test.agent = await window.corral.validate.agent(s.provider, s.agentKey);
  }
  async function testGithub() {
    if (!window.corral) return;
    test.github = 'pending';
    test.github = await window.corral.validate.github(s.githubToken);
  }
  async function testNotion() {
    if (!window.corral) return;
    test.notion = 'pending';
    test.notion = await window.corral.validate.notion(s.notionToken);
  }

  async function finish() {
    for (let i = 0; i < steps.length; i++) {
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

{#snippet result(t: TestState)}
  {#if t === 'pending'}
    <span class="t">testing…</span>
  {:else if t}
    <span class="t" class:bad={!t.ok}>{t.ok ? '✓ ok' : `✗ ${t.detail ?? 'failed'}`}</span>
  {/if}
{/snippet}

<div class="wizard">
  <aside>
    <p class="brand">Corral setup</p>
    <ol>
      {#each steps as label, i}
        <li class:active={i === step} class:done={i < step}>{label}</li>
      {/each}
    </ol>
    {#if !hasBridge}<p class="warn">Browser preview — saving requires the desktop app.</p>{/if}
  </aside>

  <section>
    <h1>{steps[step]}</h1>

    {#if step === 0}
      <span class="lbl">Provider</span>
      <div class="row">
        {#each ['claude', 'gemini', 'gpt'] as p}
          <button class:sel={s.provider === p} onclick={() => (s.provider = p as WizardState['provider'])}>{p}</button>
        {/each}
      </div>
      <span class="lbl">Transport</span>
      <div class="row">
        {#each ['cli', 'api'] as t}
          <button class:sel={s.transport === t} onclick={() => (s.transport = t as WizardState['transport'])}>{t}</button>
        {/each}
      </div>
      <label class="field"
        ><span>API key (BYOK — stored in the OS keychain){s.transport === 'cli' ? ' · optional for cli' : ''}</span>
        <input type="password" bind:value={s.agentKey} placeholder="sk-..." /></label
      >
      <div class="testrow">
        <button onclick={testAgent} disabled={!hasBridge || !s.agentKey}>Test key</button>
        {@render result(test.agent)}
      </div>
      <div class="two">
        <label class="field"><span>Planning model</span><input bind:value={s.planningModel} /></label>
        <label class="field"><span>Implementation model</span><input bind:value={s.implementationModel} /></label>
      </div>
    {:else if step === 1}
      <label class="field"><span>Repository (owner/name)</span><input bind:value={s.repo} placeholder="acme/widgets" /></label>
      <label class="field"><span>GitHub token (keychain)</span><input type="password" bind:value={s.githubToken} /></label>
      <div class="testrow">
        <button onclick={testGithub} disabled={!hasBridge || !s.githubToken}>Test token</button>
        {@render result(test.github)}
      </div>
      <div class="two">
        <label class="field"><span>Routing key</span><input bind:value={s.repoKey} /></label>
        <label class="field"><span>Production branch</span><input bind:value={s.production} /></label>
      </div>
      <label class="field"><span>Development branch</span><input bind:value={s.development} /></label>
    {:else if step === 2}
      <span class="lbl">Tracker (where issues come from — not limited to Notion)</span>
      <div class="row">
        <button class:sel={s.trackerKind === 'notion'} onclick={() => (s.trackerKind = 'notion' as TrackerKind)}>Notion</button>
        <button class:sel={s.trackerKind === 'github_issues'} onclick={() => (s.trackerKind = 'github_issues' as TrackerKind)}
          >GitHub Issues</button
        >
      </div>

      {#if s.trackerKind === 'notion'}
        <label class="field"><span>Notion database id</span><input bind:value={s.notionDb} /></label>
        <label class="field"><span>Notion token (keychain)</span><input type="password" bind:value={s.notionToken} /></label>
        <div class="testrow">
          <button onclick={testNotion} disabled={!hasBridge || !s.notionToken}>Test token</button>
          {@render result(test.notion)}
        </div>
        <div class="two">
          <label class="field"><span>Status property</span><input bind:value={s.statusProp} /></label>
          <label class="field"><span>ID property</span><input bind:value={s.idProp} /></label>
        </div>
        <div class="two">
          <label class="field"><span>Repo property (optional)</span><input bind:value={s.repoProp} /></label>
          <label class="field"><span>Scope checkbox (optional)</span><input bind:value={s.scopeProp} /></label>
        </div>
      {:else}
        <label class="field"
          ><span>Issues repo (blank = work repo{s.repo ? ` ${s.repo}` : ''})</span>
          <input bind:value={s.issuesRepo} placeholder={s.repo || 'owner/name'} /></label
        >
        <div class="two">
          <label class="field"><span>Scope label (optional gate)</span><input bind:value={s.scopeLabel} /></label>
          <label class="field"><span>Identifier prefix</span><input bind:value={s.identifierPrefix} /></label>
        </div>
        <p class="hint">Uses your GitHub token. Semantic states map to issue labels below.</p>
      {/if}

      <span class="lbl">{s.trackerKind === 'notion' ? 'State → Notion status' : 'State → GitHub label'}</span>
      <div class="states">
        {#each Object.keys(s.states) as k}
          <label><span>{k}</span><input bind:value={s.states[k as keyof WizardState['states']]} /></label>
        {/each}
      </div>
    {:else if step === 3}
      <span class="lbl">Workspace backend</span>
      <div class="row">
        {#each ['local', 'docker'] as b}
          <button class:sel={s.backend === b} onclick={() => (s.backend = b as WizardState['backend'])}>{b}</button>
        {/each}
      </div>
      <button onclick={detectDocker} disabled={!hasBridge}>Detect Docker</button>
      {#if docker}<p class="hint">{docker.available ? `✓ ${docker.version}` : '✗ Docker not found — use local'}</p>{/if}
    {:else if step === 4}
      <div class="two">
        <label class="field"><span>Control-plane port</span><input type="number" bind:value={s.port} /></label>
        <label class="field"><span>Max active issues</span><input type="number" bind:value={s.maxActive} /></label>
      </div>
      <div class="two">
        <label class="field"><span>Language</span><input bind:value={s.language} /></label>
        <label class="field"><span>Stack profile</span><input bind:value={s.stack} /></label>
      </div>
    {/if}

    {#if error}<p class="error">{error}</p>{/if}

    <footer>
      <button onclick={back} disabled={step === 0}>Back</button>
      {#if step < steps.length - 1}
        <button class="primary" onclick={next}>Next</button>
      {:else}
        <button class="primary" onclick={finish} disabled={saving}>{saving ? 'Saving…' : 'Finish & start'}</button>
      {/if}
    </footer>
  </section>
</div>

<style>
  .wizard {
    display: grid;
    grid-template-columns: 220px 1fr;
    min-height: 100vh;
  }
  aside {
    background: var(--surface);
    border-right: 1px solid var(--border);
    padding: 20px 16px;
  }
  .brand {
    color: var(--text-dim);
    font-size: 13px;
    margin: 0 0 16px;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  li {
    padding: 8px 10px;
    border-radius: 8px;
    color: var(--text-dim);
    font-size: 13px;
  }
  li.active {
    background: var(--accent);
    color: var(--accent-text);
  }
  li.done {
    color: var(--green);
  }
  .warn {
    margin-top: 18px;
    color: var(--amber);
    font-size: 12px;
  }
  section {
    padding: 28px 32px;
    max-width: 560px;
  }
  h1 {
    font-size: 20px;
    margin: 0 0 20px;
  }
  .lbl {
    display: block;
    font-size: 13px;
    color: var(--text-dim);
    margin: 14px 0 6px;
  }
  .field {
    display: block;
    margin-top: 14px;
  }
  .field > span {
    display: block;
    font-size: 13px;
    color: var(--text-dim);
    margin-bottom: 6px;
  }
  .row {
    display: flex;
    gap: 8px;
  }
  .row button.sel {
    border-color: var(--accent);
    color: var(--accent-text);
  }
  .two {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .states {
    display: grid;
    gap: 6px;
  }
  .states label {
    display: grid;
    grid-template-columns: 120px 1fr;
    align-items: center;
    gap: 8px;
  }
  .states span {
    font-size: 13px;
    color: var(--text-dim);
  }
  .hint {
    color: var(--text-dim);
    font-size: 13px;
  }
  .testrow {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 8px;
  }
  .t {
    font-size: 13px;
    color: var(--green);
  }
  .t.bad {
    color: var(--red);
  }
  .error {
    color: var(--red);
    font-size: 13px;
    margin-top: 14px;
  }
  footer {
    display: flex;
    justify-content: space-between;
    margin-top: 26px;
    border-top: 1px solid var(--border);
    padding-top: 18px;
  }
</style>
