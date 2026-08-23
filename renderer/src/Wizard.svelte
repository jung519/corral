<script lang="ts">
  import { onMount } from 'svelte';
  import Button from './lib/Button.svelte';
  import ModelPicker from './lib/ModelPicker.svelte';
  import ClaudeTokenDialog from './ClaudeTokenDialog.svelte';
  import CopyButton from './lib/CopyButton.svelte';
  import CredentialField from './lib/CredentialField.svelte';
  import PasteButton from './lib/PasteButton.svelte';
  import { currentLang, setLang, t } from './lib/i18n.svelte';
  import {
    activeSlot,
    apiSupported,
    buildConfigYaml,
    configured,
    CORE_STATE_KEYS,
    firstApiProvider,
    defaultModels,
    type FallbackEntry,
    hasCred,
    initialState,
    loadDraft,
    stateFromConfig,
    newFallback,
    newRepo,
    oauthSlot,
    OPTIONAL_STATE_KEYS,
    type Provider,
    PROVIDER_NAMES,
    type RepoProvider,
    runnableInBackend,
    saveDraft,
    secretRefs,
    secretsFor,
    serviceFor,
    slotComplaint,
    type TrackerKind,
    unrunnableAssigned,
    validateStep,
    type WizardState,
  } from './lib/wizard';

  // Embedded mode: render a single section inline (e.g. inside the Settings tab) with
  // no stepper/nav — just that section's form + Save/Cancel. onDone fires after a save.
  let { embedded = false, section = '', onDone }: { embedded?: boolean; section?: string; onDone?: () => void } = $props();

  const stepKeys = ['step.ai', 'step.repo', 'step.tracker', 'step.workspace', 'step.channel'];

  // Deep-link: #/setup/<section> opens directly on that section (Settings "Edit").
  const SECTION_STEP: Record<string, number> = { ai: 0, repo: 1, tracker: 2, workspace: 3, channel: 4 };
  function initialStep(): number {
    if (embedded && section in SECTION_STEP) return SECTION_STEP[section]!;
    const m = (typeof location !== 'undefined' ? location.hash : '').match(/^#\/setup\/(\w+)/);
    return (m && SECTION_STEP[m[1] ?? '']) ?? 0;
  }

  // claude / gemini / gpt(codex) transports are all implemented. `soon` gates a provider
  // whose adapter isn't ready yet (none currently).
  const providers: Array<{ id: WizardState['provider']; name: string; icon: string; soon?: boolean }> = [
    { id: 'claude', name: PROVIDER_NAMES.claude, icon: '<path d="M12 3v18M3 12h18M6 6l12 12M18 6 6 18"/>' },
    { id: 'gemini', name: PROVIDER_NAMES.gemini, icon: '<path d="M12 3l7 9-7 9-7-9z"/>' },
    { id: 'gpt', name: PROVIDER_NAMES.gpt, icon: '<circle cx="12" cy="12" r="8"/>' },
  ];

  let s: WizardState = $state(initialState());
  let step = $state(initialStep());
  let error = $state('');
  let saving = $state(false);

  const hasBridge = typeof window !== 'undefined' && !!window.corral;

  // Secrets already persisted to the keychain (shown as "saved" so you needn't retype
  // a token after a restart). Keyed "service:account".
  let savedSecrets = $state(new Set<string>());
  const secretKey = (service: string, account: string) => `${service}:${account}`;
  const secretSaved = (service: string, account: string) => savedSecrets.has(secretKey(service, account));

  /** The core runs on another machine, so "installed" and "logged in" are answers about
   *  that machine — worth saying out loud when a probe comes back empty. */
  let remoteCore = $state(false);

  /**
   * Where the form starts from.
   *
   * The config file, when there is one. The draft was documented as "the last-applied
   * state so re-opening pre-fills" — a mirror of the config, kept by this component — and
   * everything depended on that mirror existing. With no draft, an inline edit of one
   * section started from `initialState()` and `buildConfigYaml` wrote the **whole**
   * document from it, replacing a working config with defaults (CRL-77).
   *
   * Reading the config removes the dependence on the mirror. The draft is still the
   * fallback, for the case it is the only thing there: a first run that was started and
   * not finished, so no config exists yet.
   */
  onMount(async () => {
    const got: { config?: unknown; raw?: unknown } = window.corral
      ? await window.corral.config.parsed().catch(() => ({}))
      : {};
    const parsed = got.config;
    const draft = parsed ? null : await loadDraft();
    if (parsed) s = stateFromConfig(parsed, got.raw);
    else if (draft) s = draft;
    // Coerce any still-gated provider a stale draft/config might hold back to a working one.
    if (providers.find((p) => p.id === s.provider)?.soon) setProvider('claude');
    // API transport only has a claude adapter — fall back to its CLI if a non-claude
    // agent was somehow left on API.
    if (s.transport === 'api' && !apiSupported(s.provider)) s.transport = 'cli';
    // Host-login mount doesn't work on macOS (login is in the Keychain, not ~/.claude),
    // so a fresh macOS setup defaults to the API-key path instead.
    // Only for a genuinely fresh start. A config that says otherwise has already been
    // decided by whoever wrote it.
    if (!draft && !parsed && window.corral?.platform === 'darwin') s.dockerMountLogin = false;
    if (!window.corral) return;
    remoteCore = (await window.corral.remote.get().catch(() => ({ mode: 'local' as const }))).mode === 'remote';
    const found = new Set<string>();
    for (const ref of secretRefs(s)) {
      if (await window.corral.secret.has(ref.service, ref.account)) found.add(secretKey(ref.service, ref.account));
    }
    savedSecrets = found;
  });

  // "Save & next": persist the non-secret draft (localStorage) and any entered tokens
  // (encrypted into the keychain) before moving. Tokens never touch the draft file.
  async function persistStep() {
    await saveDraft(s);
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

  // ── Fallback agents (failover order) ──────────────────────────────────────
  function addFallback() {
    // Default a new fallback to a provider valid for the current backend.
    s.fallbacks = [...s.fallbacks, newFallback(s.backend === 'docker' ? 'claude' : 'gemini')];
  }
  function removeFallback(i: number) {
    s.fallbacks = s.fallbacks.filter((_, j) => j !== i);
  }
  function moveFallback(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= s.fallbacks.length) return;
    const next = [...s.fallbacks];
    [next[i], next[j]] = [next[j], next[i]];
    s.fallbacks = next;
  }
  function setFallbackProvider(f: FallbackEntry, p: Provider) {
    f.provider = p;
    const d = defaultModels(p);
    f.planningModel = d.planning;
    f.implementationModel = d.implementation;
    f.reviewModel = d.review;
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

  type TestState = { ok: boolean; detail?: string } | 'pending' | undefined;
  let test = $state<Record<string, TestState>>({});

  // ── Per-stage agents ──────────────────────────────────────────────────────
  const STAGES = [
    { key: 'planning', label: 'pipe.plan' },
    { key: 'implementation', label: 'pipe.build' },
    { key: 'review', label: 'pipe.review' },
  ] as const;
  const providerName = (p: Provider) => providers.find((x) => x.id === p)?.name ?? p;
  // A provider may be assigned to a role only if it has a usable auth path.
  const isConfigured = (p: Provider) => configured(s, p, secretSaved);

  function setStageProvider(stage: (typeof STAGES)[number]['key'], p: Provider) {
    s.stages[stage].provider = p;
    s.stages[stage].model = defaultModels(p)[stage];
  }

  // ── Per-account credentials ───────────────────────────────────────────────
  // Per-account status line (CLI check result / oauth import result), keyed by provider.
  let acctMsg = $state<Record<string, string>>({});
  /** The codex login could not be read — offer the command that creates it. */
  let codexMissing = $state(false);

  // Import codex's existing login (~/.codex/auth.json) into the gpt account. No CLI is
  // driven here — the file is already on disk — so this one is a single call.
  async function importOauth(p: 'gpt') {
    if (!window.corral) return;
    acctMsg[p] = t('codex.importing');
    try {
      const r = await window.corral.codexImportAuth();
      if (r.ok && r.b64) {
        s.accounts[p].oauth = r.b64;
        acctMsg[p] = t('codex.importOk');
        codexMissing = false;
      } else {
        acctMsg[p] = `✗ ${r.error ?? ''}`.trim();
        // Nothing to import means nothing is logged in yet — say what to run.
        codexMissing = true;
      }
    } catch (e) {
      acctMsg[p] = `✗ ${String(e)}`.trim();
    }
  }

  /**
   * The subscription-token flow lives in its own dialog (`ClaudeTokenDialog`).
   *
   * It used to be inline in this card, which is a third of a row wide — too narrow for a
   * three-step task, and the reason its buttons broke and its URL buried the instruction.
   * The card keeps one button; the dialog holds the steps and every failure route
   * (CRL-84).
   */
  let tokenDialog = $state<'off' | 'auto' | 'manual'>('off');

  function tokenReceived(token: string): void {
    s.accounts.claude.oauth = token;
    acctMsg.claude = t('oauth.setupOk');
  }

  /**
   * Is the provider's official CLI installed where the agent will run?
   *
   * Asked only on the local backend — that is the one place a PATH is the answer. Under
   * docker the CLI comes from the worker image and the turn is `docker exec … claude`, so
   * the button is not offered at all (see the account card).
   *
   * Install-only: login is provider-specific and not reliably checkable without a billed
   * turn. Nothing is granted by passing — under docker a logged-in host CLI belongs to a
   * machine the container cannot see, and counting it let a credential-less setup through
   * (CRL-78).
   */
  async function testCli(p: Provider) {
    if (!window.corral) return;
    acctMsg[p] = t('status.testing');
    cliMissing = { ...cliMissing, [p]: false };
    const r = await window.corral.detectCli(p);
    // Which machine's PATH this was — the core's disk is not this one's in remote mode.
    acctMsg[p] = r.installed
      ? `✓ ${r.version ?? t('cli.installed')}`
      : `✗ ${t(remoteCore ? 'cli.notInstalledCore' : 'cli.notInstalled')}`;
    // "Install it" is not an instruction without the command. Offer it to the clipboard.
    if (!r.installed) cliMissing = { ...cliMissing, [p]: true };
  }

  /** npm package per provider — the install command the failure message needs. */
  const CLI_PACKAGE: Record<Provider, string> = {
    claude: '@anthropic-ai/claude-code',
    gemini: '@google/gemini-cli',
    gpt: '@openai/codex',
  };
  let cliMissing = $state<Partial<Record<Provider, boolean>>>({});
  // Full connection test for one repo (checks the actual repo is reachable, not just the token).
  async function testRepo(i: number) {
    const r = s.repos[i];
    if (!window.corral || !r) return;
    test[`repo-${i}`] = 'pending';
    test[`repo-${i}`] = await window.corral.test.repo({
      kind: r.provider,
      repo: r.repo.trim(),
      token: r.token.trim(),
      host: r.gitlabHost.trim(),
      username: r.bitbucketUser.trim(),
    });
  }

  // Connection test for the skills/reference repo (GitHub owner/name or URL).
  async function testReference() {
    if (!window.corral || !s.referenceRepo.trim()) return;
    test.reference = 'pending';
    test.reference = await window.corral.test.reference(s.referenceRepo.trim(), s.referenceToken.trim());
  }

  // Full connection test for the tracker (DB / issues repo / Jira project reachable).
  async function testTracker() {
    if (!window.corral) return;
    const githubRepo = s.repos.find((r) => r.provider === 'github');
    test.tracker = 'pending';
    test.tracker = await window.corral.test.tracker({
      kind: s.trackerKind,
      token: (s.trackerKind === 'notion' ? s.notionToken : s.trackerKind === 'jira' ? s.jiraToken : (githubRepo?.token ?? '')).trim(),
      databaseId: s.notionDb.trim(),
      repo: (s.issuesRepo.trim() || githubRepo?.repo || '').trim(),
      host: s.jiraHost.trim(),
      email: s.jiraEmail.trim(),
      project: s.jiraProject.trim(),
    });
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

  const keyHint = (p: Provider) => (p === 'gemini' ? 'AIza…' : p === 'gpt' ? 'sk-…' : 'sk-ant-api…');

  /**
   * What is wrong with what was just pasted, in a sentence, or nothing.
   *
   * Checked as it is typed rather than on save: the two claude credentials differ by
   * prefix, so a token in the wrong box is knowable immediately, and knowing it later
   * costs a container build and an agent turn to find out (CRL-85).
   */
  function complaint(p: Provider, kind: 'key' | 'oauth'): string {
    const c = slotComplaint(p, kind, kind === 'key' ? s.accounts[p].key : s.accounts[p].oauth);
    return c ? t(`account.${c}`) : '';
  }

  /** codex's login is present — imported this session or already in the store. */
  const codexHeld = $derived(!!s.accounts.gpt.oauth.trim() || secretSaved(serviceFor('gpt'), 'oauth'));

  // Notion schema → property/option dropdowns (no manual name typing).
  type NotionProp = { name: string; type: string; options: string[] };
  let notionProps = $state<NotionProp[] | null>(null);
  let schemaError = $state('');

  const notionPropsByType = (types: string[]): NotionProp[] => (notionProps ?? []).filter((p) => types.includes(p.type));
  const statusOptions = $derived((notionProps ?? []).find((p) => p.name === s.statusProp)?.options ?? []);

  async function loadNotionSchema() {
    if (!window.corral || !s.notionDb.trim() || !s.notionToken.trim()) {
      schemaError = t('notion.loadNeedsToken');
      return;
    }
    schemaError = '';
    try {
      const res = await window.corral.notion.schema(s.notionToken.trim(), s.notionDb.trim());
      if (res.ok && res.properties) {
        notionProps = res.properties;
        // Auto-pick a sensible property if the current value isn't a real one.
        const status = res.properties.filter((p) => p.type === 'status' || p.type === 'select');
        if (status.length && !status.some((p) => p.name === s.statusProp)) s.statusProp = status[0]!.name;
        const ids = res.properties.filter((p) => p.type === 'unique_id');
        if (ids.length && !ids.some((p) => p.name === s.idProp)) s.idProp = ids[0]!.name;
      } else {
        schemaError = res.detail ?? t('notion.loadFailed');
      }
    } catch (err) {
      schemaError = err instanceof Error ? err.message : String(err);
    }
  }

  async function finish() {
    const isSaved = (service: string, account: string) => savedSecrets.has(secretKey(service, account));
    if (embedded) {
      // Inline edit: validate only the section being edited (other sections keep their
      // saved config/keys — don't force re-entering them).
      const e = validateStep(step, s, isSaved);
      if (e) {
        error = e;
        return;
      }
    } else {
      for (let i = 0; i < stepKeys.length; i++) {
        const e = validateStep(i, s, isSaved);
        if (e) {
          step = i;
          error = e;
          return;
        }
      }
    }
    saving = true;
    try {
      if (!window.corral) throw new Error('Corral desktop bridge unavailable');
      // Secrets before config. Saving the config is what brings a remote core up on it,
      // and it resolves credentials while doing so — they have to already be there.
      for (const sec of secretsFor(s)) await window.corral.secret.set(sec.service, sec.account, sec.value);
      const saved = await window.corral.config.write(buildConfigYaml(s, currentLang()));
      if (!saved.ok) throw new Error(saved.error ?? 'the core could not start on this config');
      // First-run brings the orchestrator up; an inline edit just persists config.
      if (!embedded) await window.corral.startOrchestrator();
      // Keep the (non-secret) draft as the last-applied state so re-opening pre-fills.
      await saveDraft(s);
      if (embedded) {
        saving = false;
        onDone?.();
      } else {
        location.hash = '#/settings';
        location.reload();
      }
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
    <span class="badge" class:bad={!state.ok}>{state.ok ? `✓ ${state.detail ?? t('status.validated')}` : `✗ ${state.detail ?? t('status.failed')}`}</span>
  {/if}
{/snippet}

<div class="wizard" class:embedded>
  {#if !embedded}
  <aside>
    <p class="brand">{t('wizard.sidebar')}</p>
    <ol>
      {#each stepKeys as key, i}
        <li>
          <button class="step" class:active={i === step} onclick={() => goTo(i)}>
            <span class="ico">{i + 1}</span>{t(key)}
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
  {/if}

  <section>
    {#if !embedded}<button class="close" onclick={() => (location.hash = '#/')}>✕ {t('wizard.exit')}</button>{/if}
    {#if step === 0}
      <h1>{t('step.ai')}</h1>
      <p class="subtitle">{t('step0.subtitle')}</p>

      <!-- ── 1 · transport ── -->
      <div class="sec-head"><span class="sec-no">1</span> {t('transport.title')}</div>
      <div class="transports">
        <button
          class="transport"
          class:sel={s.transport === 'api'}
          onclick={() => {
            s.transport = 'api';
            if (!apiSupported(s.provider)) setProvider(firstApiProvider());
          }}
        >
          <span class="radio" class:on={s.transport === 'api'}></span>{t('transport.api')}
        </button>
        <button class="transport" class:sel={s.transport === 'cli'} onclick={() => (s.transport = 'cli')}>
          <span class="radio" class:on={s.transport === 'cli'}></span>{t('transport.cli')}
        </button>
      </div>
      {#if s.transport === 'api'}<p class="hint">{t('transport.apiNote')}</p>{/if}
      {#if s.transport === 'api' && s.backend === 'local'}<p class="run-warn">⚠ {t('transport.apiLocalWarn')}</p>{/if}

      <!-- ── 2 · accounts (independent per-provider credentials) ── -->
      <div class="sec-head"><span class="sec-no">2</span> {t('account.title')}</div>
      <p class="hint">{t('account.hint')}</p>
      <div class="acct-grid">
        {#each providers as p}
          {@const apiUnsupported = s.transport === 'api' && !apiSupported(p.id)}
          <div class="acct-card" class:dim={!runnableInBackend(s, p.id) || apiUnsupported}>
            <div class="acct-head">
              <span class="acct-name">
                <svg class="picon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">{@html p.icon}</svg>
                {p.name}
              </span>
              {#if apiUnsupported}
                <span class="tag muted">{t('account.apiNo')}</span>
              {:else if !runnableInBackend(s, p.id)}
                <span class="tag warn">{t('account.dockerNoRun')}</span>
              {:else if hasCred(s, p.id, secretSaved)}
                <span class="tag ok">✓ {t('account.set')}</span>
              {:else if isConfigured(p.id)}
                <span class="tag muted">{t('account.cliLogin')}</span>
              {:else}
                <span class="tag muted">{t('account.unset')}</span>
              {/if}
            </div>
            <!-- Both slots the config has, each with its name on it, and the one this
                 configuration will actually read marked. A single unlabelled box over two
                 slots is what made this card unusable (CRL-85). -->
            <CredentialField
              label={t('account.slotKey')}
              bind:value={s.accounts[p.id].key}
              placeholder={keyHint(p.id)}
              active={activeSlot(s, p.id, secretSaved) === 'key'}
              saved={secretSaved(serviceFor(p.id), 'default')}
              disabled={apiUnsupported}
              warning={complaint(p.id, 'key')}
            />

            {#if oauthSlot(p.id) === 'subscription'}
              <CredentialField
                label={t('account.slotOauth')}
                bind:value={s.accounts[p.id].oauth}
                placeholder="sk-ant-oat…"
                active={activeSlot(s, p.id, secretSaved) === 'oauth'}
                saved={secretSaved(serviceFor(p.id), 'oauth')}
                warning={complaint(p.id, 'oauth')}
              >
                {#if hasBridge}
                  <!-- The attempt sits beside the field it fills rather than in place of
                       it. However it ends, the box is already there and the command that
                       prints the token is one click from the clipboard — nobody has to
                       fail into the manual route to find it (CRL-85). -->
                  <Button onclick={() => (tokenDialog = 'auto')}>{t('oauth.setupBtn')}</Button>
                  <CopyButton value="claude setup-token" label={t('oauth.copyCommand')} />
                {/if}
              </CredentialField>
            {:else if oauthSlot(p.id) === 'codex'}
              <!-- Not a field: codex's auth.json is a base64 blob, imported whole. Nobody
                   types it, so offering a box to type it in would be a lie. -->
              <div class="slot-import">
                <span class="slot-label">{t('account.slotCodex')}</span>
                {#if codexHeld}<span class="tag ok">✓ {t('account.set')}</span>{/if}
                {#if hasBridge}<Button onclick={() => importOauth('gpt')}>{t('codex.importBtn')}</Button>{/if}
              </div>
            {/if}

            <!-- No install check under docker. The CLI that runs comes from the worker
                 image, so a host probe answers about the wrong machine — and a button
                 that can only ever say "not found, install it" about a machine nothing
                 runs on is worse than no button (CRL-78). -->
            {#if hasBridge && s.transport === 'cli' && s.backend !== 'docker'}
              <div class="acct-btns"><Button onclick={() => testCli(p.id)}>{t('cli.check')}</Button></div>
            {/if}
            {#if apiUnsupported}
              <p class="helper warn-text">{t('account.apiNoHint')}</p>
            {:else}
              {#if !runnableInBackend(s, p.id)}<p class="helper warn-text">{t('account.dockerNoRunHint')}</p>
              {:else if s.backend === 'docker' && s.transport === 'cli'}
                <!-- Where this agent's credential comes from once it runs in a container. -->
                <p class="helper">{t(p.id === 'claude' && s.dockerMountLogin ? 'cli.inImageMount' : 'cli.inImage')}</p>
              {/if}
              {#if acctMsg[p.id]}<p class="helper">{acctMsg[p.id]}</p>{/if}
              <!-- A failure that names no next step is a dead end. Both of these hand over
                   the command that fixes it, one click away. -->
              {#if cliMissing[p.id]}
                <div class="fallback">
                  <p class="helper">{t('cli.installHint')}</p>
                  <CopyButton value={`npm install -g ${CLI_PACKAGE[p.id]}`} label={t('cli.copyInstall')} />
                </div>
              {/if}
              {#if p.id === 'gpt' && codexMissing}
                <div class="fallback">
                  <p class="helper">{t('codex.loginHint')}</p>
                  <CopyButton value="codex login" label={t('oauth.copyCommand')} reveal />
                </div>
              {/if}
            {/if}
          </div>
        {/each}
      </div>

      <!-- ── 3 · assignment (pick from configured agents) ── -->
      <div class="sec-head"><span class="sec-no">3</span> {t('assign.title')}</div>
      <label class="check"><input type="checkbox" bind:checked={s.perStageAgents} /> {t('stage.toggle')}</label>
      <p class="hint">{t('stage.toggleHint')}</p>

      {#if !s.perStageAgents}
        <div class="stage-row">
          <span class="stage-name">{t('assign.agent')}</span>
          <select value={s.provider} onchange={(e) => setProvider(e.currentTarget.value as Provider)}>
            {#each providers as p}<option value={p.id} disabled={!isConfigured(p.id)}>{p.name}{isConfigured(p.id) ? '' : ` · ${t('account.unset')}`}</option>{/each}
          </select>
        </div>
        <div class="three">
          <label class="field"
            ><span>{t('field.planningModel')}</span>
            <ModelPicker bind:value={s.planningModel} provider={s.provider} transport={s.transport} id="plan" /></label
          >
          <label class="field"
            ><span>{t('field.implModel')}</span>
            <ModelPicker bind:value={s.implementationModel} provider={s.provider} transport={s.transport} id="impl" /></label
          >
          <label class="field"
            ><span>{t('field.reviewModel')}</span>
            <ModelPicker bind:value={s.reviewModel} provider={s.provider} transport={s.transport} id="review" /></label
          >
        </div>
      {:else}
        {#each STAGES as st}
          <div class="stage-row">
            <span class="stage-name">{t(st.label)}</span>
            <select value={s.stages[st.key].provider} onchange={(e) => setStageProvider(st.key, e.currentTarget.value as Provider)}>
              {#each providers as p}<option value={p.id} disabled={!isConfigured(p.id)}>{p.name}{isConfigured(p.id) ? '' : ` · ${t('account.unset')}`}</option>{/each}
            </select>
            <ModelPicker
              bind:value={s.stages[st.key].model}
              provider={s.stages[st.key].provider}
              transport={s.transport}
              id={`stage-${st.key}`}
            />
          </div>
        {/each}
      {/if}

      {#if unrunnableAssigned(s).length}
        <p class="run-warn">⚠ {t('assign.runWarn').replace('{p}', unrunnableAssigned(s).map(providerName).join(', '))}</p>
      {/if}

      {#if s.transport === 'cli'}
        <!-- ── 4 · fallbacks ── -->
        <div class="sec-head"><span class="sec-no">4</span> {t('agent.fallbackLabel')}</div>
        <p class="hint">{t('agent.fallbackHint')}</p>
        {#each s.fallbacks as f, i (i)}
          <div class="repo-card">
            <div class="repo-head">
              <span class="repo-num">#{i + 2} · {providerName(f.provider)}</span>
              <div class="reorder">
                <button class="ghost-x" onclick={() => moveFallback(i, -1)} disabled={i === 0} title="↑">↑</button>
                <button class="ghost-x" onclick={() => moveFallback(i, 1)} disabled={i === s.fallbacks.length - 1} title="↓">↓</button>
                <button class="ghost-x" onclick={() => removeFallback(i)} title={t('repo.remove')}>✕</button>
              </div>
            </div>
            <div class="stage-row">
              <span class="stage-name">{t('assign.agent')}</span>
              <select value={f.provider} onchange={(e) => setFallbackProvider(f, e.currentTarget.value as Provider)}>
                {#each providers as p}<option value={p.id} disabled={!isConfigured(p.id)}>{p.name}{isConfigured(p.id) ? '' : ` · ${t('account.unset')}`}</option>{/each}
              </select>
            </div>
            <div class="three">
              <label class="field"
                ><span>{t('field.planningModel')}</span>
                <ModelPicker bind:value={f.planningModel} provider={f.provider} transport={s.transport} id={`fb${i}-plan`} /></label
              >
              <label class="field"
                ><span>{t('field.implModel')}</span>
                <ModelPicker bind:value={f.implementationModel} provider={f.provider} transport={s.transport} id={`fb${i}-impl`} /></label
              >
              <label class="field"
                ><span>{t('field.reviewModel')}</span>
                <ModelPicker bind:value={f.reviewModel} provider={f.provider} transport={s.transport} id={`fb${i}-review`} /></label
              >
            </div>
            {#if !runnableInBackend(s, f.provider)}<p class="helper warn-text">{t('account.dockerNoRunHint')}</p>{/if}
          </div>
        {/each}
        <button class="add-repo" onclick={addFallback}>{t('agent.fallbackAdd')}</button>
      {/if}
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
              />
              {#if hasBridge}<PasteButton onpaste={(v) => (r.token = v)} />{/if}
            </div></label
          >
          <div class="two">
            <label class="field"><span>{t('field.prodBranch')}</span><input bind:value={r.production} /></label>
            <label class="field"><span>{t('field.devBranch')}</span><input bind:value={r.development} /></label>
          </div>
          {#if hasBridge}
            <div class="testrow">
              <Button onclick={() => testRepo(i)} disabled={!r.repo.trim() || !r.token.trim()}>{t('test.connection')}</Button>
              {@render badge(test[`repo-${i}`])}
            </div>
          {/if}
        </div>
      {/each}
      <button class="add-repo" onclick={addRepo}>{t('repo.add')}</button>

      <span class="lbl">{t('field.referenceRepo')}</span>
      <label class="field"
        ><span>{t('field.referenceRepo.repo')}</span>
        <input bind:value={s.referenceRepo} placeholder="acme/skills" /></label
      >
      {#if s.referenceRepo.trim()}
        <label class="field"
          ><span>{t('field.referenceRepo.token')}</span>
          <div class="keyrow">
            <input
              type="password"
              bind:value={s.referenceToken}
              placeholder={!s.referenceToken && secretSaved('reference', 'default') ? t('field.secretSaved') : ''}
            />
            {#if hasBridge}<PasteButton onpaste={(v) => (s.referenceToken = v)} />{/if}
          </div></label
        >
        {#if hasBridge}
          <div class="testrow">
            <Button onclick={testReference}>{t('test.connection')}</Button>
            {@render badge(test.reference)}
          </div>
        {/if}
      {/if}
      <p class="hint">{t('field.referenceRepo.hint')}</p>
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
            {#if hasBridge}<PasteButton onpaste={(v) => ((s.notionToken = v), testNotion())} />{/if}
            {@render badge(test.notion)}
          </div></label
        >
        {#if hasBridge}
          <div class="testrow">
            <Button onclick={loadNotionSchema} disabled={!s.notionDb.trim() || !s.notionToken.trim()}>
              {t('notion.load')}
            </Button>
            {#if notionProps}<span class="badge">✓ {notionProps.length} {t('notion.propsLoaded')}</span>{/if}
            {#if schemaError}<span class="badge bad">{schemaError}</span>{/if}
          </div>
          <p class="hint">{t('notion.loadHint')}</p>
        {/if}
        <div class="two">
          <label class="field"
            ><span>{t('field.statusProp')}</span>
            {#if notionProps}
              <select bind:value={s.statusProp}>
                {#each notionPropsByType(['status', 'select']) as p}<option value={p.name}>{p.name}</option>{/each}
              </select>
            {:else}<input bind:value={s.statusProp} />{/if}
          </label>
          <label class="field"
            ><span>{t('field.idProp')}</span>
            {#if notionProps}
              <select bind:value={s.idProp}>
                {#each notionPropsByType(['unique_id']) as p}<option value={p.name}>{p.name}</option>{/each}
              </select>
            {:else}<input bind:value={s.idProp} />{/if}
          </label>
        </div>
        <div class="two">
          <label class="field"
            ><span>{t('field.repoProp')}</span>
            {#if notionProps}
              <select bind:value={s.repoProp}>
                <option value="">{t('notion.none')}</option>
                {#each notionPropsByType(['select', 'multi_select']) as p}<option value={p.name}>{p.name}</option>{/each}
              </select>
            {:else}<input bind:value={s.repoProp} />{/if}
          </label>
          <label class="field"
            ><span>{t('field.scopeProp')}</span>
            {#if notionProps}
              <select bind:value={s.scopeProp}>
                <option value="">{t('notion.none')}</option>
                {#each notionPropsByType(['checkbox']) as p}<option value={p.name}>{p.name}</option>{/each}
              </select>
            {:else}<input bind:value={s.scopeProp} />{/if}
          </label>
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
          ><span>{t('field.jiraToken')}</span>
          <div class="keyrow">
            <input
              type="password"
              bind:value={s.jiraToken}
              placeholder={!s.jiraToken && secretSaved('jira', 'default') ? t('field.secretSaved') : ''}
            />
            {#if hasBridge}<PasteButton onpaste={(v) => (s.jiraToken = v)} />{/if}
          </div></label
        >
      {/if}

      {#if hasBridge}
        <div class="testrow">
          <Button onclick={testTracker}>{t('test.connection')}</Button>
          {@render badge(test.tracker)}
        </div>
      {/if}

      <span class="lbl"
        >{s.trackerKind === 'notion' ? t('states.notion') : s.trackerKind === 'jira' ? t('states.jira') : t('states.github')}</span
      >
      <div class="states">
        {#each CORE_STATE_KEYS as k}
          <label
            ><span>{t(`state.${k}`)}</span>
            {#if s.trackerKind === 'notion' && statusOptions.length}
              <select bind:value={s.states[k]}>
                <option value="">{t('notion.none')}</option>
                {#each statusOptions as o}<option value={o}>{o}</option>{/each}
              </select>
            {:else}<input bind:value={s.states[k]} />{/if}
          </label>
        {/each}
        {#if s.detailedStates}
          {#each OPTIONAL_STATE_KEYS as k}
            <label
              ><span>{t(`state.${k}`)}</span>
              {#if s.trackerKind === 'notion' && statusOptions.length}
                <select bind:value={s.states[k]}>
                  <option value="">{t('notion.none')}</option>
                  {#each statusOptions as o}<option value={o}>{o}</option>{/each}
                </select>
              {:else}<input bind:value={s.states[k]} />{/if}
            </label>
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
      <p class="hint">{s.backend === 'docker' ? t('workspace.dockerNote') : t('workspace.localNote')}</p>
      {#if s.backend === 'docker'}
        <!-- Said here because step 1 came first: whoever passed the agent cards was still
             on the local default and read advice about a host that will not run them. -->
        <p class="hint">{t('workspace.dockerCliNote')}</p>
        <label class="check">
          <input type="checkbox" bind:checked={s.dockerMountLogin} />
          <span>{t('workspace.mountLogin')}</span>
        </label>
        <p class="hint">{s.dockerMountLogin ? t('workspace.mountLoginOn') : t('workspace.mountLoginOff')}</p>
        <div class="two">
          <label class="field"
            ><span>{t('workspace.memory')}</span>
            <input bind:value={s.dockerMemory} placeholder="1g" spellcheck="false" /></label
          >
          <label class="field"
            ><span>{t('workspace.cpus')}</span>
            <input bind:value={s.dockerCpus} placeholder="1.5" spellcheck="false" /></label
          >
        </div>
        <p class="hint">{t('workspace.capsHint')}</p>
      {/if}
    {:else if step === 4}
      <h1>{t('step.channel')}</h1>
      <div class="two">
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
            <option value="auto">{t('field.language.auto')}</option>
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

      <h2 class="sub">{t('field.limits')}</h2>
      <div class="two">
        <!-- Text, not number. A number input binds a number, and blank has to stay
             distinguishable from 0 — one means no ceiling, the other stops every call. -->
        <label class="field"
          ><span>{t('field.dailyInput')}</span>
          <input inputmode="numeric" bind:value={s.dailyInputTokens} placeholder="2000000" spellcheck="false" /></label
        >
        <label class="field"
          ><span>{t('field.dailyOutput')}</span>
          <input inputmode="numeric" bind:value={s.dailyOutputTokens} placeholder="100000" spellcheck="false" /></label
        >
      </div>
      <p class="hint">{t('field.limitsHint')}</p>
    {/if}

    {#if error}<p class="error">{error}</p>{/if}
    {#if !hasBridge}<p class="preview">{t('wizard.browserPreview')}</p>{/if}

    <footer>
      {#if embedded}
        <button onclick={() => onDone?.()}>{t('settings.cancel')}</button>
        <button class="primary" onclick={finish} disabled={saving}>{saving ? t('wizard.saving') : t('settings.save')}</button>
      {:else}
        <button onclick={back} disabled={step === 0}>{t('wizard.back')}</button>
        {#if step < stepKeys.length - 1}
          <button class="primary" onclick={next}>{t('wizard.next')} · {t(stepKeys[step + 1])}</button>
        {:else}
          <button class="primary" onclick={finish} disabled={saving}>{saving ? t('wizard.saving') : t('wizard.finish')}</button>
        {/if}
      {/if}
    </footer>
  </section>
</div>

{#if tokenDialog !== 'off'}
  <ClaudeTokenDialog
    manual={tokenDialog === 'manual'}
    ontoken={tokenReceived}
    onclose={() => (tokenDialog = 'off')}
  />
{/if}

<style>
  .sub {
    font-size: 13px;
    font-weight: 600;
    margin: 20px 0 8px;
  }
  .wizard {
    display: grid;
    grid-template-columns: 240px 1fr;
    min-height: 100vh;
  }
  .wizard.embedded {
    grid-template-columns: 1fr;
    min-height: auto;
  }
  .wizard.embedded section {
    padding: 4px 0 0;
    max-width: none;
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
  /* The field takes the room; the paste button keeps its label. */
  .keyrow input {
    flex: 1;
    min-width: 0;
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
  .stage-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }
  .stage-name {
    width: 64px;
    flex: 0 0 auto;
    font-size: 13px;
    color: var(--text-dim);
  }
  /* `:global` because the model control moved into ModelPicker — scoped selectors do not
     reach a child component's elements, and without this the row's widths went lopsided. */
  .stage-row :global(select),
  .stage-row :global(input) {
    flex: 1;
    min-width: 0;
  }
  .sec-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 15px;
    font-weight: 500;
    margin: 22px 0 4px;
  }
  .sec-no {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--accent-text);
    font-size: 12px;
  }
  .acct-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
    margin: 10px 0 4px;
  }
  .acct-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px;
  }
  .acct-card.dim {
    opacity: 0.85;
  }
  .acct-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
    gap: 6px;
  }
  .acct-name {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 500;
  }
  /* codex's slot: a label, whether it is held, and the button that fetches it. No input,
     because the value is a base64 blob nobody types (CRL-85). */
  .slot-import {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }
  .slot-label {
    font-size: 12px;
    color: var(--text-dim);
  }
  .acct-btns {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .fallback {
    margin-top: 6px;
  }
  .tag {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 20px;
    white-space: nowrap;
  }
  .tag.ok {
    color: var(--success);
    background: color-mix(in srgb, var(--success) 16%, transparent);
  }
  .tag.warn {
    color: var(--warning);
    background: color-mix(in srgb, var(--warning) 16%, transparent);
  }
  .tag.muted {
    color: var(--text-dim);
    border: 1px solid var(--border);
  }
  .warn-text {
    color: var(--warning);
  }
  .run-warn {
    font-size: 12px;
    color: var(--warning);
    background: color-mix(in srgb, var(--warning) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--warning) 40%, transparent);
    border-radius: var(--radius);
    padding: 8px 10px;
    margin: 4px 0 10px;
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
  .ghost-x:hover:not(:disabled) {
    color: var(--red);
  }
  .ghost-x:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .reorder {
    display: flex;
    gap: 2px;
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
