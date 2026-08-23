/** Setup-wizard state → corral.yaml + the secret writes. Secrets never go into the
 * config — only CredentialRef pointers do. Repositories are a list (multi-repo);
 * each repo has its own key + description + credential (account = key).
 *
 * Credential model: every provider has ONE account (key + oauth) stored at
 * `serviceFor(provider):default` / `:oauth`. Accounts are configured independently in
 * the "에이전트 계정" panel; assignment (single agent / per-stage / fallbacks) only
 * *references* a configured provider — it never carries its own credentials. */
import { t } from './i18n.svelte';

export type RepoProvider = 'github' | 'gitlab' | 'bitbucket';
export type TrackerKind = 'notion' | 'github_issues' | 'jira';
export type Provider = 'claude' | 'gemini' | 'gpt';

/** Functionally required tracker stages (entry / working / terminal). */
export const CORE_STATE_KEYS = ['planning', 'in_progress', 'done'] as const;
/** Optional refinements; omitted → they collapse onto a core column (see schema). */
export const OPTIONAL_STATE_KEYS = ['plan_review', 'in_review'] as const;

export const PROVIDERS: Provider[] = ['claude', 'gemini', 'gpt'];

/** How each provider is written for a reader. Lives here rather than beside the picker's
 *  icons so a message built in this file can use the same words the screen does. */
export const PROVIDER_NAMES: Record<Provider, string> = { claude: 'Claude', gemini: 'Gemini', gpt: 'GPT' };

export interface RepoEntry {
  provider: RepoProvider;
  repo: string; // owner/name (github/gitlab) or workspace/slug (bitbucket)
  key: string; // stable id (workspace subdir, per-repo PR tracking)
  /** Which stored credential this repo uses. Blank = the key, which is what the wizard
   *  creates. Kept so a config pointing somewhere else survives a save: rewriting it to
   *  the key would aim the repo at a credential that does not exist (CRL-77). */
  credentialAccount: string;
  description: string; // role — the agent uses this to pick which repo an issue touches
  production: string;
  development: string;
  token: string;
  gitlabHost: string;
  bitbucketUser: string;
}

export function newRepo(): RepoEntry {
  return {
    provider: 'github',
    repo: '',
    key: '',
    credentialAccount: '',
    description: '',
    production: 'main',
    development: 'develop',
    token: '',
    gitlabHost: 'https://gitlab.com',
    bitbucketUser: '',
  };
}

/** One provider's independent account. `key` = API key (BYOK); `oauth` = subscription
 *  token (claude setup-token) or base64 codex auth (gpt). Empty = rely on the CLI's own
 *  login (local) or claude host-login mount (docker). Persisted to the keychain only. */
export interface AccountCred {
  key: string;
  oauth: string;
}

/**
 * How a turn reaches its model.
 *
 * Per entry, not per app. The schema and the runtime have always allowed a mix — a
 * fallback or a stage carries its own `transport` and `bootstrap.ts` honours it — but the
 * wizard used to push one global choice into every entry, so the one combination the
 * operational AI actually needs (claude on `cli` for the subscription token, gemini on
 * `api` because its CLI cannot be run without tools) could not be expressed (CRL-94).
 */
export type Transport = 'api' | 'cli';

/** One stage's agent in per-stage mode: provider + transport + the model for that stage. */
export interface StageAgent {
  provider: Provider;
  transport: Transport;
  model: string;
}

/** A fallback agent: tried (in list order) when the agent above it is out of capacity.
 *  References a configured provider (credentials come from that provider's account). */
export interface FallbackEntry {
  provider: Provider;
  transport: Transport;
  planningModel: string;
  implementationModel: string;
  reviewModel: string;
}

export interface WizardState {
  provider: Provider;
  transport: Transport;
  /** Independent per-provider accounts (credentials). Keyed by provider. */
  accounts: Record<Provider, AccountCred>;
  planningModel: string;
  implementationModel: string;
  reviewModel: string;
  /** Ordered fallback agents (failover when the one above is out of capacity). */
  fallbacks: FallbackEntry[];
  /** When on, each stage (plan/build/review) uses its own provider + model. Off → the
   *  single provider above runs every stage (with the per-stage models). */
  perStageAgents: boolean;
  stages: { planning: StageAgent; implementation: StageAgent; review: StageAgent };
  repos: RepoEntry[];
  trackerKind: TrackerKind;
  notionDb: string;
  notionToken: string;
  statusProp: string;
  idProp: string;
  repoProp: string;
  scopeProp: string;
  issuesRepo: string;
  scopeLabel: string;
  identifierPrefix: string;
  jiraHost: string;
  jiraProject: string;
  jiraEmail: string;
  jiraToken: string;
  states: { planning: string; plan_review: string; in_progress: string; in_review: string; done: string };
  /** When false, only the 3 core stages are collected (coarse board); the optional
   * two collapse onto a core column server-side. */
  detailedStates: boolean;
  backend: 'local' | 'docker';
  /** Docker: mount the host ~/.claude login so the CLI auths without an API key. */
  dockerMountLogin: boolean;
  /** Docker: hard caps on one worker container. Blank = uncapped, which is what the
   *  daemon does by default. Text rather than numbers because blank and 0 are different
   *  answers and a number input cannot hold the first one. */
  dockerMemory: string;
  dockerCpus: string;
  maxActive: number;
  /** Daily token ceiling, shared by the development and operational AI. Blank = no
   *  ceiling; `0` would be a ceiling of zero, which is a different thing to say. */
  dailyInputTokens: string;
  dailyOutputTokens: string;
  /** Agent output language: `'auto'` (follow the UI language until explicitly pinned),
   *  or a concrete code like `'en'`/`'ko'`. `buildConfigYaml` resolves `'auto'` to the
   *  current UI language, so config always stores a concrete code. */
  language: string;
  stack: string;
  /** Optional read-only conventions/skills repo ("owner/name" or https URL). */
  referenceRepo: string;
  /** Token for a private reference repo (kept in the keychain, never in config). */
  referenceToken: string;
}

function emptyAccounts(): Record<Provider, AccountCred> {
  return { claude: { key: '', oauth: '' }, gemini: { key: '', oauth: '' }, gpt: { key: '', oauth: '' } };
}

export function initialState(): WizardState {
  return {
    provider: 'claude',
    transport: 'cli',
    accounts: emptyAccounts(),
    planningModel: 'opus',
    implementationModel: 'sonnet',
    reviewModel: 'opus',
    fallbacks: [],
    perStageAgents: false,
    stages: {
      planning: { provider: 'claude', transport: 'cli', model: 'opus' },
      implementation: { provider: 'claude', transport: 'cli', model: 'sonnet' },
      review: { provider: 'claude', transport: 'cli', model: 'opus' },
    },
    repos: [{ ...newRepo(), key: 'main' }],
    trackerKind: 'notion',
    notionDb: '',
    notionToken: '',
    statusProp: 'Status',
    idProp: 'ID',
    repoProp: '',
    scopeProp: '',
    issuesRepo: '',
    scopeLabel: 'corral',
    identifierPrefix: 'issue-',
    jiraHost: '',
    jiraProject: '',
    jiraEmail: '',
    jiraToken: '',
    states: { planning: '', plan_review: '', in_progress: '', in_review: '', done: '' },
    detailedStates: false,
    backend: 'local',
    dockerMountLogin: true,
    dockerMemory: '',
    dockerCpus: '',
    maxActive: 3,
    dailyInputTokens: '',
    dailyOutputTokens: '',
    language: 'auto',
    stack: 'generic',
    referenceRepo: '',
    referenceToken: '',
  };
}

export function serviceFor(provider: Provider): string {
  return { claude: 'anthropic', gemini: 'google', gpt: 'openai' }[provider];
}

// Use the CLIs' own version-agnostic tier aliases, never concrete version numbers
// (those churn constantly and would go stale). Each CLI resolves the alias to its
// current model: claude opus/sonnet/haiku, gemini pro/flash/flash-lite (also `auto`).
export const MODELS: Record<Provider, string[]> = {
  claude: ['opus', 'sonnet', 'haiku'],
  gemini: ['pro', 'flash', 'flash-lite'],
  gpt: ['gpt-5', 'gpt-5-mini', 'o4-mini'],
};

export function defaultModels(provider: Provider): {
  planning: string;
  implementation: string;
  review: string;
} {
  const m = MODELS[provider];
  const first = m[0] ?? '';
  return { planning: first, implementation: m[1] ?? first, review: first };
}

/** A new fallback entry defaulting to the given provider's models.
 *
 *  `transport` starts from whatever the primary agent is on: a fallback added without a
 *  thought behaves the way it did before entries could differ, and changing it is a
 *  deliberate act rather than something to discover. */
export function newFallback(provider: Provider = 'gemini', transport: Transport = 'cli'): FallbackEntry {
  const d = defaultModels(provider);
  return {
    provider,
    transport,
    planningModel: d.planning,
    implementationModel: d.implementation,
    reviewModel: d.review,
  };
}

const OWNER_NAME = /^[^/\s]+\/[^/\s]+$/;

function firstGithub(s: WizardState): RepoEntry | undefined {
  return s.repos.find((r) => r.provider === 'github');
}

/** Localized validation message; `key` interpolates {key}, `k` interpolates {k}. */
function vt(id: string, vars?: Record<string, string>): string {
  let out = t(id);
  if (vars) for (const [name, val] of Object.entries(vars)) out = out.replace(`{${name}}`, val);
  return out;
}

/** Whether a secret (service/account) is already stored — a blank field is then OK
 * (editing keeps the saved key). Default: nothing saved (first-run requires keys). */
export type SecretSavedFn = (service: string, account: string) => boolean;

// ───────────────────────────────────────── account / capability helpers
//
// "configured"  = the agent has a usable auth path → may be assigned to a role.
// "runnable"    = the agent can actually execute under the *current backend*. Gemini
//                 can be configured but never runs under docker (no in-container auth);
//                 this is enforced at RUN time (warned in the UI, blocked in the core),
//                 never by hiding the option.

/** Gemini's CLI cannot run under the docker backend: nothing collected here ends up as a
 *  gemini login inside the image (claude has the oauth token / mount, gpt the imported
 *  codex auth). The API transport never enters the container — the core holds the key and
 *  calls out over HTTPS — so `gemini:api` is fine there, and blocking it left Gemini
 *  unusable on every VM setup (CRL-80). Mirror of `src/agent/backend-compat.ts`. */
export function dockerBlocked(provider: Provider, transport: WizardState['transport']): boolean {
  return provider === 'gemini' && transport === 'cli';
}

/** Providers with a working API (BYOK) transport. All three run the shared agentic loop
 *  (api-loop.ts) directly. (Mirror of the agentTransports registry.) */
const API_PROVIDERS = new Set<Provider>(['claude', 'gemini', 'gpt']);
export function apiSupported(provider: Provider): boolean {
  return API_PROVIDERS.has(provider);
}
/** First provider that supports the API transport (for coercing on transport switch). */
export function firstApiProvider(): Provider {
  return PROVIDERS.find((p) => apiSupported(p)) ?? 'claude';
}

/**
 * Whether this provider can execute under the current backend + transport.
 *
 * `transport` defaults to the primary agent's, which is what a caller asking about the
 * account cards means. A fallback or a stage passes its own — the same provider can be
 * blocked in one entry and fine in the next, which is the whole point of letting entries
 * differ (CRL-94).
 */
export function runnableInBackend(s: WizardState, provider: Provider, transport: Transport = s.transport): boolean {
  return !(s.backend === 'docker' && dockerBlocked(provider, transport));
}

/**
 * The second credential slot, when a provider has one.
 *
 * Every provider stores an API key at `<service>:default`. Two of them also have a
 * *subscription* credential at `<service>:oauth`, and it is a different kind of thing:
 * claude's is a token the CLI prints (`claude setup-token`) and a person pastes; gpt's is
 * codex's own `auth.json`, imported wholesale rather than typed. Gemini has no second
 * slot, so its card stays one field.
 *
 * The card has to know this, because a provider with two slots and one visible field is
 * what made the screen unusable — the visible field was the API key, and a subscription
 * token typed into it saved fine and then failed at the first agent turn (CRL-85).
 */
export function oauthSlot(p: Provider): 'subscription' | 'codex' | null {
  if (p === 'claude') return 'subscription';
  if (p === 'gpt') return 'codex';
  return null;
}

/**
 * Which of the two slots the configured run will actually read.
 *
 * Read off the runtime rather than guessed: the API transport sends the key as
 * `x-api-key` and never looks at the OAuth slot (`claude-api.ts`), while the CLI transport
 * prefers the OAuth token when there is one and falls back to the key (`claude-cli.ts`,
 * resolved in `bootstrap.ts`). Marking the live slot on the card is the point — two
 * password fields with nothing to tell them apart is the problem being fixed.
 */
export function activeSlot(s: WizardState, p: Provider, isSaved: SecretSavedFn = () => false): 'key' | 'oauth' {
  if (s.transport === 'api' || !oauthSlot(p)) return 'key';
  const svc = serviceFor(p);
  return !!s.accounts[p].oauth.trim() || isSaved(svc, 'oauth') ? 'oauth' : 'key';
}

/** What is wrong with a value, when it is decidable from the value alone. */
export type SlotComplaint = 'oauthInKey' | 'keyInOauth' | 'oauthShape';

/**
 * A value that plainly belongs in the other slot, or in neither.
 *
 * Only claude has two fields a person types into, and its two credentials are told apart
 * by prefix: `sk-ant-api…` is a console key, `sk-ant-oat…` is a subscription token. That
 * makes both directions of the mix-up decidable before saving, and it makes a third case
 * decidable too — a token that starts with neither, which is what a truncated paste looks
 * like. One of those (92 characters, no prefix) authenticated nowhere and cost a 43-minute
 * container build before anything said so.
 *
 * Silent whenever the answer is not certain: this warns, it does not block, and a wrong
 * warning on a format that later changes is worse than no warning.
 */
export function slotComplaint(p: Provider, kind: 'key' | 'oauth', value: string): SlotComplaint | null {
  const v = value.trim();
  if (!v || p !== 'claude') return null;
  if (kind === 'key') return v.startsWith('sk-ant-oat') ? 'oauthInKey' : null;
  if (v.startsWith('sk-ant-api')) return 'keyInOauth';
  return v.startsWith('sk-ant-oat') ? null : 'oauthShape';
}

/** A stored or freshly-entered credential exists for this provider. */
export function hasCred(s: WizardState, p: Provider, isSaved: SecretSavedFn = () => false): boolean {
  const a = s.accounts[p];
  const svc = serviceFor(p);
  return (
    !!a.key.trim() || !!a.oauth.trim() || isSaved(svc, 'default') || isSaved(svc, 'oauth')
  );
}

/** Does this provider have a usable auth path (so it may be assigned to a role)?
 *  - a stored/entered credential, or
 *  - cli transport on the local backend (the CLI brings its own login), or
 *  - claude with the docker host-login mount.
 *
 * `cliVerified` is deliberately NOT an auth path under docker. The check it comes from
 * looks at the **host's** PATH, and under docker the agent runs `docker exec … claude`
 * against a CLI installed in the worker image — a logged-in CLI on the host is a
 * different machine's login, invisible to the container. Counting it let the wizard
 * finish with no credential at all and fail at the first agent turn instead (CRL-78).
 * On the local backend it is the same CLI that will run, so there it still counts. */
export function configured(
  s: WizardState,
  p: Provider,
  isSaved: SecretSavedFn = () => false,
  transport: Transport = s.transport,
): boolean {
  // API mode needs an actual key, and only claude has an api adapter.
  if (transport === 'api') return apiSupported(p) && hasCred(s, p, isSaved);
  if (hasCred(s, p, isSaved)) return true;
  if (s.backend === 'local') return true;
  return p === 'claude' && s.dockerMountLogin;
}

/** The three stages, in the order the pipeline runs them. */
export const STAGE_KEYS = ['planning', 'implementation', 'review'] as const;

/** Distinct providers used in per-stage mode (plan/build/review). */
export function stageProviders(s: WizardState): Array<Provider> {
  return [...new Set(STAGE_KEYS.map((k) => s.stages[k].provider))];
}

/**
 * Every agent the assignment actually routes to, each with the transport it will run on.
 *
 * A provider alone is no longer enough to answer "can this run" or "is this configured":
 * gemini is fine on `api` under docker and blocked on `cli`, and an entry may differ from
 * the primary (CRL-94). So the checks below take pairs.
 */
export function assignedAgents(s: WizardState): Array<{ provider: Provider; transport: Transport }> {
  const used = s.perStageAgents
    ? STAGE_KEYS.map((k) => ({ provider: s.stages[k].provider, transport: s.stages[k].transport }))
    : [{ provider: s.provider, transport: s.transport }];
  const all = [...used, ...s.fallbacks.map((f) => ({ provider: f.provider, transport: f.transport }))];
  // One row per distinct pair — the same provider on two transports is two answers.
  const seen = new Set<string>();
  return all.filter(({ provider, transport }) => {
    const id = `${provider}:${transport}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** All providers referenced by the current assignment (primary/stages + fallbacks). */
export function assignedProviders(s: WizardState): Array<Provider> {
  return [...new Set(assignedAgents(s).map((a) => a.provider))];
}

/** Assigned providers that cannot run under the current backend (→ run-time block). */
export function unrunnableAssigned(s: WizardState): Array<Provider> {
  return [
    ...new Set(
      assignedAgents(s)
        .filter((a) => !runnableInBackend(s, a.provider, a.transport))
        .map((a) => a.provider),
    ),
  ];
}

export function validateStep(step: number, s: WizardState, isSaved: SecretSavedFn = () => false): string {
  switch (step) {
    case 0: {
      // Docker + Gemini is NOT blocked here — it can be configured; the run is cancelled
      // at dispatch time with a clear message.
      //
      // An assigned agent with no auth path IS blocked. The dropdowns disable such an
      // option, which stops you picking one but not from keeping the one already
      // selected — so a docker setup could be finished with every stage reading
      // "Claude · 미설정" and fail at the first agent turn, on the far side of an image
      // build and a clone (CRL-78).
      const unset = [
        ...new Set(
          assignedAgents(s)
            .filter((a) => !configured(s, a.provider, isSaved, a.transport))
            .map((a) => a.provider),
        ),
      ];
      if (unset.length) {
        const names = unset.map((p) => PROVIDER_NAMES[p]).join(', ');
        return vt(s.backend === 'docker' ? 'validate.agentCredDocker' : 'validate.agentCred', { p: names });
      }
      return '';
    }
    case 1: {
      if (s.repos.length === 0) return vt('validate.repoMin');
      const keys = new Set<string>();
      for (const r of s.repos) {
        if (!r.key.trim()) return vt('validate.repoKeyNeeded');
        // Used as a clone dir + shell arg + env account → keep it a safe slug.
        if (!/^[A-Za-z0-9._-]+$/.test(r.key)) return vt('validate.repoKeyFormat', { key: r.key });
        if (keys.has(r.key)) return vt('validate.repoKeyDup', { key: r.key });
        keys.add(r.key);
        if (!OWNER_NAME.test(r.repo)) return vt('validate.repoOwnerName', { key: r.key });
        if (!r.token.trim() && !isSaved(r.provider, r.key)) return vt('validate.repoToken', { key: r.key });
        if (r.provider === 'gitlab' && !r.gitlabHost.trim()) return vt('validate.gitlabHost', { key: r.key });
        if (r.provider === 'bitbucket' && !r.bitbucketUser.trim()) return vt('validate.bitbucketUser', { key: r.key });
      }
      return '';
    }
    case 2:
      for (const k of CORE_STATE_KEYS) if (!s.states[k].trim()) return vt('validate.stateMapping', { k });
      if (s.detailedStates) {
        for (const k of OPTIONAL_STATE_KEYS) if (!s.states[k].trim()) return vt('validate.stateMapping', { k });
      }
      if (s.trackerKind === 'notion') {
        if (!s.notionDb.trim()) return vt('validate.notionDb');
        if (!s.notionToken.trim() && !isSaved('notion', 'default')) return vt('validate.notionToken');
        if (!s.statusProp.trim() || !s.idProp.trim()) return vt('validate.notionProps');
      } else if (s.trackerKind === 'github_issues') {
        if (!OWNER_NAME.test(s.issuesRepo.trim() || firstGithub(s)?.repo || '')) return vt('validate.issuesRepo');
      } else {
        if (!s.jiraHost.trim()) return vt('validate.jiraHost');
        if (!s.jiraProject.trim()) return vt('validate.jiraProject');
        if (!s.jiraEmail.trim()) return vt('validate.jiraEmail');
        if (!s.jiraToken.trim() && !isSaved('jira', 'default')) return vt('validate.jiraToken');
      }
      return '';
    case 3:
      return '';
    case 4:
      return '';
    default:
      return '';
  }
}

function yamlStr(v: string): string {
  return JSON.stringify(v);
}

/**
 * The daily token ceiling, written only for the sides that have one.
 *
 * Counted in tokens rather than money on purpose (see `LimitsSchema`): a price table
 * belongs to a vendor and the vendor changes it, while token counts come back from the
 * response. An empty box means no ceiling, so nothing is emitted — writing `0` there
 * would stop every call on the first request of the day.
 */
function limitsYaml(s: WizardState): string[] {
  const lines: string[] = [];
  // `String(...)` because these come off a text box that a browser is free to hand back
  // as a number: a `.trim()` on one of those threw and failed the whole save.
  const input = String(s.dailyInputTokens ?? '').trim();
  const output = String(s.dailyOutputTokens ?? '').trim();
  if (input) lines.push(`  daily_input_tokens: ${Number(input)}`);
  if (output) lines.push(`  daily_output_tokens: ${Number(output)}`);
  return lines.length ? ['limits:', ...lines, ''] : [];
}

function repoYaml(s: WizardState): string[] {
  const lines = ['repositories:'];
  for (const r of s.repos) {
    lines.push(`  - kind: ${r.provider}`, `    key: ${yamlStr(r.key)}`, `    repo: ${yamlStr(r.repo)}`);
    if (r.description.trim()) lines.push(`    description: ${yamlStr(r.description)}`);
    if (r.provider === 'gitlab') lines.push(`    host: ${yamlStr(r.gitlabHost)}`);
    if (r.provider === 'bitbucket') lines.push(`    username: ${yamlStr(r.bitbucketUser)}`);
    lines.push(
      `    credential: { service: ${r.provider}, account: ${yamlStr(r.credentialAccount.trim() || r.key)} }`,
      '    branch_strategy:',
      `      production: ${yamlStr(r.production)}`,
      `      development: ${yamlStr(r.development)}`,
    );
  }
  return lines;
}

function trackerYaml(s: WizardState): string[] {
  // Emit the 3 core stages; the optional two only when "detailed" is on (else the
  // schema collapses them onto a core column).
  const order = s.detailedStates
    ? (['planning', 'plan_review', 'in_progress', 'in_review', 'done'] as const)
    : CORE_STATE_KEYS;
  const states = order.map((k) => `    ${k}: ${yamlStr(s.states[k])}`);
  if (s.trackerKind === 'github_issues') {
    const gh = firstGithub(s);
    const lines = [
      'tracker:',
      '  kind: github_issues',
      `  repo: ${yamlStr(s.issuesRepo.trim() || gh?.repo || '')}`,
      `  credential: { service: github, account: ${yamlStr(gh?.key ?? 'main')} }`,
      `  repo_key: ${yamlStr(gh?.key ?? s.repos[0]?.key ?? 'main')}`,
      `  identifier_prefix: ${yamlStr(s.identifierPrefix)}`,
    ];
    if (s.scopeLabel.trim()) lines.push(`  scope_label: ${yamlStr(s.scopeLabel)}`);
    lines.push('  states:', ...states);
    return lines;
  }
  if (s.trackerKind === 'jira') {
    return [
      'tracker:',
      '  kind: jira',
      `  host: ${yamlStr(s.jiraHost)}`,
      `  project: ${yamlStr(s.jiraProject)}`,
      `  email: ${yamlStr(s.jiraEmail)}`,
      '  credential: { service: jira, account: default }',
      `  repo_key: ${yamlStr(s.repos[0]?.key ?? 'main')}`,
      '  states:',
      ...states,
    ];
  }
  const lines = [
    'tracker:',
    '  kind: notion',
    `  database_id: ${yamlStr(s.notionDb)}`,
    '  credential: { service: notion, account: default }',
    '  properties:',
    `    status: ${yamlStr(s.statusProp)}`,
    `    identifier: ${yamlStr(s.idProp)}`,
  ];
  if (s.repoProp.trim()) lines.push(`    repo: ${yamlStr(s.repoProp)}`);
  lines.push('  states:', ...states);
  if (s.scopeProp.trim()) lines.push('  scope:', '    type: checkbox', `    property: ${yamlStr(s.scopeProp)}`);
  return lines;
}

/** Credential + oauth_credential pointers for a provider's shared account. */
function credLines(provider: Provider, indent: string): string[] {
  const svc = serviceFor(provider);
  return [
    `${indent}credential: { service: ${svc}, account: default }`,
    `${indent}oauth_credential: { service: ${svc}, account: oauth }`,
  ];
}

/** YAML for agent.fallbacks (one ordered entry each). Credentials come from the
 *  provider's shared account (service:default / :oauth).
 *
 *  Each entry writes **its own** transport. It was hardcoded `cli` (CRL-79 made it follow
 *  the step-1 choice instead), and then that single choice was pushed into every entry —
 *  which still could not say "claude on cli, gemini on api", the one shape the operational
 *  AI needs (CRL-94). */
function fallbackYaml(s: WizardState): string[] {
  if (s.fallbacks.length === 0) return [];
  const lines = ['  fallbacks:'];
  for (const f of s.fallbacks) {
    lines.push(`    - provider: ${f.provider}`, `      transport: ${f.transport}`, ...credLines(f.provider, '      '));
    lines.push(
      '      models:',
      `        planning: ${yamlStr(f.planningModel)}`,
      `        implementation: ${yamlStr(f.implementationModel)}`,
      `        review: ${yamlStr(f.reviewModel)}`,
    );
  }
  return lines;
}

/** YAML for agent.stages (per-stage provider/model overrides). Credentials come from
 *  the provider's shared account (service:default / :oauth).
 *
 *  A stage override replaces the routing whole (`bootstrap.ts`), so its transport is the
 *  one that runs — hardcoding `cli` here silently overrode the API choice for all three
 *  stages (CRL-79). Each stage now carries its own, so a hand-written mix survives a save
 *  instead of collapsing onto the primary's choice (CRL-94). */
function stageAgentYaml(s: WizardState): string[] {
  if (!s.perStageAgents) return [];
  const lines = ['  stages:'];
  for (const stage of STAGE_KEYS) {
    const a = s.stages[stage];
    lines.push(`    ${stage}:`, `      provider: ${a.provider}`, `      transport: ${a.transport}`, ...credLines(a.provider, '      '));
    lines.push('      models:', `        ${stage}: ${yamlStr(a.model)}`);
  }
  return lines;
}

export function buildConfigYaml(s: WizardState, uiLang: string): string {
  // Output language "auto" = follow the UI language. Resolve to a concrete code here so
  // the core never has to know about the renderer's UI-language toggle.
  const language = s.language === 'auto' ? uiLang : s.language;
  const profile = ['profile:', `  language: ${yamlStr(language)}`, `  stack: ${yamlStr(s.stack)}`];
  if (s.referenceRepo.trim()) {
    profile.push(`  reference_repo: ${yamlStr(s.referenceRepo.trim())}`);
    // Always point at the keychain entry (like agent/repo creds) — a private reference
    // repo needs the token, and emitting only when the field is non-blank dropped it on
    // any re-save (the field shows "saved" and is empty). No secret → resolves empty →
    // public clone.
    profile.push('  reference_credential: { service: reference, account: default }');
  }
  return [
    '# Generated by the Corral setup wizard. Secrets live in the keychain / file store.',
    ...profile,
    '',
    ...trackerYaml(s),
    '',
    ...repoYaml(s),
    '',
    'agent:',
    `  provider: ${s.provider}`,
    `  transport: ${s.transport}`,
    ...credLines(s.provider, '  '),
    '  models:',
    `    planning: ${yamlStr(s.planningModel)}`,
    `    implementation: ${yamlStr(s.implementationModel)}`,
    `    review: ${yamlStr(s.reviewModel)}`,
    ...stageAgentYaml(s),
    ...fallbackYaml(s),
    '',
    'workspace:',
    `  backend: ${s.backend}`,
    ...(s.backend === 'docker'
      ? [
          '  docker:',
          `    mount_host_login: ${s.dockerMountLogin}`,
          // Written only when set. An empty cap and a cap of zero are different, and the
          // schema's "absent = uncapped" is the one an empty box means.
          ...(s.dockerMemory.trim() ? [`    memory: ${yamlStr(s.dockerMemory.trim())}`] : []),
          ...(s.dockerCpus.trim() ? [`    cpus: ${yamlStr(s.dockerCpus.trim())}`] : []),
        ]
      : []),
    '',
    'channel:',
    '  kind: web',
    '',
    ...limitsYaml(s),
    `max_active_issues: ${s.maxActive}`,
    '',
  ].join('\n');
}

// ─────────────────────────────────────────────── the other direction: config → state

/** A record, or an empty one. The config arrives as `unknown` — it crossed a bridge. */
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Fill a wizard state from a config the core parsed.
 *
 * The mirror of `buildConfigYaml`, and the reason the settings screen can render at all
 * without a draft file. It used to have only the one direction, so the draft was the
 * screen's only representation of the config — deleting that file emptied the screen even
 * though the core was configured and running (CRL-76).
 *
 * **What this cannot carry, the screen does not show.** A config block with no field in
 * `WizardState` — `limits`, `control_plane`, `review` — simply is not mapped, so it does
 * not appear as something editable. That is on purpose while saving still rewrites the
 * whole file: showing a value the next save would delete is worse than not showing it
 * (CRL-77).
 *
 * Secrets are never here. The config holds credential *pointers*; the values live in the
 * store, and the screen asks it separately whether each one is set.
 */
/** A transport from a config file, or the given default. Anything unrecognised falls back
 *  rather than throwing: this is a read path for a file a person may have hand-edited. */
function readTransport(value: unknown, fallback: Transport): Transport {
  return value === 'api' || value === 'cli' ? value : fallback;
}

export function stateFromConfig(config: unknown, written?: unknown): WizardState {
  const c = obj(config);
  // What was actually in the file, for the fields where presence is the meaning. Falls
  // back to the parsed form so a caller with only one of them still works.
  const w = obj(written ?? config);
  const s = initialState();

  const profile = obj(c.profile);
  // A config always stores a concrete language; `auto` only ever exists in the wizard.
  s.language = str(profile.language, s.language);
  s.stack = str(profile.stack, s.stack);
  s.referenceRepo = str(profile.reference_repo);

  const agent = obj(c.agent);
  s.provider = (str(agent.provider, s.provider) as Provider) ?? s.provider;
  s.transport = agent.transport === 'api' ? 'api' : 'cli';
  const models = obj(agent.models);
  s.planningModel = str(models.planning, s.planningModel);
  s.implementationModel = str(models.implementation, s.implementationModel);
  s.reviewModel = str(models.review, s.reviewModel);

  const stages = obj(agent.stages);
  // Per-stage agents are on when the config actually names stages — the same test
  // `stageAgentYaml` applies when writing them.
  s.perStageAgents = Object.keys(stages).length > 0;
  for (const key of STAGE_KEYS) {
    const stage = obj(stages[key]);
    if (!Object.keys(stage).length) continue;
    s.stages[key] = {
      provider: (str(stage.provider, s.provider) as Provider) ?? s.provider,
      // Read back per stage. Falling back to the primary's is right for a config written
      // before entries could differ — it is what that file meant (CRL-94).
      transport: readTransport(stage.transport, s.transport),
      model: str(obj(stage.models)[key], s.stages[key].model),
    };
  }

  s.fallbacks = arr(agent.fallbacks).map((f) => {
    const e = obj(f);
    const m = obj(e.models);
    const provider = (str(e.provider, 'gemini') as Provider) ?? 'gemini';
    const base = newFallback(provider, readTransport(e.transport, s.transport));
    return {
      ...base,
      planningModel: str(m.planning, base.planningModel),
      implementationModel: str(m.implementation, base.implementationModel),
      reviewModel: str(m.review, base.reviewModel),
    };
  });

  const repos = arr(c.repositories);
  if (repos.length) {
    s.repos = repos.map((r) => {
      const e = obj(r);
      const kind = str(e.kind, 'github');
      return {
        ...newRepo(),
        provider: (kind === 'gitlab' || kind === 'bitbucket' ? kind : 'github') as RepoProvider,
        repo: str(e.repo),
        key: str(e.key),
        description: str(e.description),
        credentialAccount: str(obj(e.credential).account),
        production: str(obj(e.branch_strategy).production, 'main'),
        development: str(obj(e.branch_strategy).development, 'develop'),
        gitlabHost: str(e.host, 'https://gitlab.com'),
        bitbucketUser: str(e.username),
      };
    });
  }

  const tracker = obj(c.tracker);
  const kind = str(tracker.kind, 'notion');
  s.trackerKind = (kind === 'github_issues' || kind === 'jira' ? kind : 'notion') as TrackerKind;
  s.notionDb = str(tracker.database_id);
  const props = obj(tracker.properties);
  s.statusProp = str(props.status, s.statusProp);
  s.idProp = str(props.identifier, s.idProp);
  s.repoProp = str(props.repo);
  s.scopeProp = str(obj(tracker.scope).property);
  s.issuesRepo = str(tracker.repo);
  s.scopeLabel = str(tracker.scope_label, s.scopeLabel);
  s.identifierPrefix = str(tracker.identifier_prefix, s.identifierPrefix);
  s.jiraHost = str(tracker.host);
  s.jiraProject = str(tracker.project);
  s.jiraEmail = str(tracker.email);

  const states = obj(tracker.states);
  for (const key of ['planning', 'plan_review', 'in_progress', 'in_review', 'done'] as const) {
    s.states[key] = str(states[key], s.states[key]);
  }
  // Read from the file as written, not the parsed form: the schema defaults the optional
  // two onto a core column, so every parsed config has them. Asking the parsed form would
  // turn this switch on for everyone and then write those defaults back as choices.
  const writtenStates = obj(obj(w.tracker).states);
  s.detailedStates = !!str(writtenStates.plan_review) || !!str(writtenStates.in_review);

  const workspace = obj(c.workspace);
  s.backend = workspace.backend === 'docker' ? 'docker' : 'local';
  const docker = obj(workspace.docker);
  s.dockerMountLogin = docker.mount_host_login !== false;
  s.dockerMemory = str(docker.memory);
  s.dockerCpus = str(docker.cpus);
  // Absent stays blank. `mount_host_login` has a schema default of true, so this one is
  // read from the file: a config that says nothing must not start saying `false`.
  const writtenDocker = obj(obj(w.workspace).docker);
  if (writtenDocker.mount_host_login !== undefined) s.dockerMountLogin = writtenDocker.mount_host_login !== false;

  const limits = obj(c.limits);
  // Absent stays blank. `0` reads back as "0" — a ceiling somebody chose, not an empty box.
  s.dailyInputTokens = typeof limits.daily_input_tokens === 'number' ? String(limits.daily_input_tokens) : '';
  s.dailyOutputTokens = typeof limits.daily_output_tokens === 'number' ? String(limits.daily_output_tokens) : '';

  if (typeof c.max_active_issues === 'number') s.maxActive = c.max_active_issues;
  return s;
}

// ─────────────────────────────────────────────────── per-step draft persistence

const DRAFT_KEY = 'corral.wizard.draft';

/** Secret-bearing fields, blanked before a draft ever touches disk (BYOK: tokens
 * live only in the OS keychain, never in localStorage). */
function withoutSecrets(s: WizardState): WizardState {
  const clone: WizardState = JSON.parse(JSON.stringify(s));
  for (const p of PROVIDERS) clone.accounts[p] = { key: '', oauth: '' };
  clone.notionToken = '';
  clone.jiraToken = '';
  clone.referenceToken = '';
  for (const r of clone.repos) r.token = '';
  return clone;
}

/** The Electron draft store (userData file) when present; else null (browser). */
function draftBridge(): { read(): Promise<string | null>; write(j: string): Promise<void>; clear(): Promise<void> } | null {
  return typeof window !== 'undefined' && window.corral?.draft ? window.corral.draft : null;
}

/** Persist the non-secret wizard state so a restart mid-setup keeps your inputs.
 * Prefers the userData file (origin-independent) over localStorage. */
export async function saveDraft(s: WizardState): Promise<void> {
  const json = JSON.stringify(withoutSecrets(s));
  try {
    const bridge = draftBridge();
    if (bridge) await bridge.write(json);
    else localStorage.setItem(DRAFT_KEY, json);
  } catch {
    /* storage unavailable — non-fatal */
  }
}

export async function loadDraft(): Promise<WizardState | null> {
  try {
    const bridge = draftBridge();
    const raw = bridge ? await bridge.read() : localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WizardState>;
    const merged = { ...initialState(), ...parsed };
    // Accounts is a nested record — a partial/older draft may omit a provider.
    merged.accounts = { ...emptyAccounts(), ...(parsed.accounts ?? {}) };
    return merged;
  } catch {
    return null;
  }
}

export async function clearDraft(): Promise<void> {
  try {
    const bridge = draftBridge();
    if (bridge) await bridge.clear();
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* non-fatal */
  }
}

/** Secret refs (service/account) the wizard manages — to check keychain.has on load.
 *  All three provider accounts are probed so the account panel can show "configured". */
export function secretRefs(s: WizardState): Array<{ service: string; account: string }> {
  const refs: Array<{ service: string; account: string }> = [];
  for (const r of s.repos) if (r.key.trim()) refs.push({ service: r.provider, account: r.key });
  if (s.trackerKind === 'notion') refs.push({ service: 'notion', account: 'default' });
  else if (s.trackerKind === 'jira') refs.push({ service: 'jira', account: 'default' });
  if (s.referenceRepo.trim()) refs.push({ service: 'reference', account: 'default' });
  for (const p of PROVIDERS) {
    refs.push({ service: serviceFor(p), account: 'default' });
    refs.push({ service: serviceFor(p), account: 'oauth' });
  }
  return refs;
}

/** Secrets to persist (service, account, value). Per-repo creds use account = key;
 *  per-provider accounts use service:default / :oauth. */
export function secretsFor(s: WizardState): Array<{ service: string; account: string; value: string }> {
  const out: Array<{ service: string; account: string; value: string }> = [];
  for (const r of s.repos) out.push({ service: r.provider, account: r.key, value: r.token });
  if (s.trackerKind === 'notion') out.push({ service: 'notion', account: 'default', value: s.notionToken });
  else if (s.trackerKind === 'jira') out.push({ service: 'jira', account: 'default', value: s.jiraToken });
  // github_issues reuses a GitHub repo's token (its account = key) — already added above.
  if (s.referenceRepo.trim() && s.referenceToken.trim()) {
    out.push({ service: 'reference', account: 'default', value: s.referenceToken });
  }
  for (const p of PROVIDERS) {
    const a = s.accounts[p];
    if (a.key.trim()) out.push({ service: serviceFor(p), account: 'default', value: a.key });
    if (a.oauth.trim()) out.push({ service: serviceFor(p), account: 'oauth', value: a.oauth });
  }
  // Trim so a stray trailing space/newline from a paste never reaches the API.
  return out.map((x) => ({ ...x, value: x.value.trim() })).filter((x) => x.value);
}
