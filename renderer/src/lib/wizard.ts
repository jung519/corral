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

export interface RepoEntry {
  provider: RepoProvider;
  repo: string; // owner/name (github/gitlab) or workspace/slug (bitbucket)
  key: string; // stable id (workspace subdir, per-repo PR tracking)
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

/** One stage's agent in per-stage mode: provider + the model for that stage. */
export interface StageAgent {
  provider: Provider;
  model: string;
}

/** A fallback agent: tried (in list order) when the agent above it is out of capacity.
 *  References a configured provider (credentials come from that provider's account). */
export interface FallbackEntry {
  provider: Provider;
  planningModel: string;
  implementationModel: string;
  reviewModel: string;
}

export interface WizardState {
  provider: Provider;
  transport: 'api' | 'cli';
  /** Independent per-provider accounts (credentials). Keyed by provider. */
  accounts: Record<Provider, AccountCred>;
  /** Providers the user explicitly verified (CLI install/login check passed). Lets a
   *  CLI agent count as "configured" without a stored token. Non-secret → kept in draft. */
  cliVerified: Partial<Record<Provider, boolean>>;
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
  port: number;
  maxActive: number;
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
    cliVerified: {},
    planningModel: 'opus',
    implementationModel: 'sonnet',
    reviewModel: 'opus',
    fallbacks: [],
    perStageAgents: false,
    stages: {
      planning: { provider: 'claude', model: 'opus' },
      implementation: { provider: 'claude', model: 'sonnet' },
      review: { provider: 'claude', model: 'opus' },
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
    port: 4400,
    maxActive: 3,
    language: 'en',
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

/** A new fallback entry defaulting to the given provider's models. */
export function newFallback(provider: Provider = 'gemini'): FallbackEntry {
  const d = defaultModels(provider);
  return {
    provider,
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

/** Gemini cannot run under the docker backend (no in-container token / ~/.gemini mount).
 *  claude (oauth/mount) and gpt (codex auth import / API key) are supported. */
export function dockerBlocked(provider: Provider): boolean {
  return provider === 'gemini';
}

/** Whether this provider can execute under the current backend. */
export function runnableInBackend(s: WizardState, provider: Provider): boolean {
  return !(s.backend === 'docker' && dockerBlocked(provider));
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
 *  - claude with the docker host-login mount, or
 *  - the user verified the CLI (install/login check passed). */
export function configured(s: WizardState, p: Provider, isSaved: SecretSavedFn = () => false): boolean {
  if (hasCred(s, p, isSaved)) return true;
  if (s.transport === 'cli' && s.backend === 'local') return true;
  if (p === 'claude' && s.backend === 'docker' && s.dockerMountLogin) return true;
  return !!s.cliVerified[p];
}

/** Distinct providers used in per-stage mode (plan/build/review). */
export function stageProviders(s: WizardState): Array<Provider> {
  return [...new Set([s.stages.planning.provider, s.stages.implementation.provider, s.stages.review.provider])];
}

/** All providers referenced by the current assignment (primary/stages + fallbacks). */
export function assignedProviders(s: WizardState): Array<Provider> {
  const used = s.perStageAgents ? stageProviders(s) : [s.provider];
  return [...new Set([...used, ...s.fallbacks.map((f) => f.provider)])];
}

/** Assigned providers that cannot run under the current backend (→ run-time block). */
export function unrunnableAssigned(s: WizardState): Array<Provider> {
  return assignedProviders(s).filter((p) => !runnableInBackend(s, p));
}

export function validateStep(step: number, s: WizardState, isSaved: SecretSavedFn = () => false): string {
  switch (step) {
    case 0:
      // Docker + Gemini is NOT blocked here — it can be configured; the run is cancelled
      // at dispatch time with a clear message. Assignment dropdowns already disable
      // providers that have no auth path at all (see `configured`).
      if (s.transport === 'api' && !hasCred(s, s.provider, isSaved)) return vt('validate.apiKeyApi');
      return '';
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
      if (!Number.isInteger(s.port) || s.port <= 0) return vt('validate.port');
      return '';
    default:
      return '';
  }
}

function yamlStr(v: string): string {
  return JSON.stringify(v);
}

function repoYaml(s: WizardState): string[] {
  const lines = ['repositories:'];
  for (const r of s.repos) {
    lines.push(`  - kind: ${r.provider}`, `    key: ${yamlStr(r.key)}`, `    repo: ${yamlStr(r.repo)}`);
    if (r.description.trim()) lines.push(`    description: ${yamlStr(r.description)}`);
    if (r.provider === 'gitlab') lines.push(`    host: ${yamlStr(r.gitlabHost)}`);
    if (r.provider === 'bitbucket') lines.push(`    username: ${yamlStr(r.bitbucketUser)}`);
    lines.push(
      `    credential: { service: ${r.provider}, account: ${yamlStr(r.key)} }`,
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
 *  provider's shared account (service:default / :oauth). */
function fallbackYaml(s: WizardState): string[] {
  if (s.fallbacks.length === 0) return [];
  const lines = ['  fallbacks:'];
  for (const f of s.fallbacks) {
    lines.push(`    - provider: ${f.provider}`, '      transport: cli', ...credLines(f.provider, '      '));
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
 *  the provider's shared account (service:default / :oauth). */
function stageAgentYaml(s: WizardState): string[] {
  if (!s.perStageAgents) return [];
  const lines = ['  stages:'];
  for (const stage of ['planning', 'implementation', 'review'] as const) {
    const a = s.stages[stage];
    lines.push(`    ${stage}:`, `      provider: ${a.provider}`, '      transport: cli', ...credLines(a.provider, '      '));
    lines.push('      models:', `        ${stage}: ${yamlStr(a.model)}`);
  }
  return lines;
}

export function buildConfigYaml(s: WizardState): string {
  const profile = ['profile:', `  language: ${yamlStr(s.language)}`, `  stack: ${yamlStr(s.stack)}`];
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
    ...(s.backend === 'docker' ? ['  docker:', `    mount_host_login: ${s.dockerMountLogin}`] : []),
    '',
    'channel:',
    '  kind: web',
    `  port: ${s.port}`,
    '',
    `max_active_issues: ${s.maxActive}`,
    '',
  ].join('\n');
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
