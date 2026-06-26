/** Setup-wizard state → corral.yaml + the secret writes. Secrets never go into the
 * config — only CredentialRef pointers do. Repositories are a list (multi-repo);
 * each repo has its own key + description + credential (account = key). */
import { t } from './i18n.svelte';

export type RepoProvider = 'github' | 'gitlab' | 'bitbucket';
export type TrackerKind = 'notion' | 'github_issues' | 'jira';

/** Functionally required tracker stages (entry / working / terminal). */
export const CORE_STATE_KEYS = ['planning', 'in_progress', 'done'] as const;
/** Optional refinements; omitted → they collapse onto a core column (see schema). */
export const OPTIONAL_STATE_KEYS = ['plan_review', 'in_review'] as const;

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

/** A fallback agent: tried (in list order) when the agent above it is out of capacity.
 *  Always cli transport for now; carries its own credentials + per-stage models. */
export interface FallbackEntry {
  provider: WizardState['provider'];
  key: string; // API key (BYOK) — optional for cli (own login)
  oauthToken: string; // claude subscription token (claude only)
  planningModel: string;
  implementationModel: string;
  reviewModel: string;
}

export interface WizardState {
  provider: 'claude' | 'gemini' | 'gpt';
  transport: 'api' | 'cli';
  agentKey: string;
  /** Claude subscription token from `claude setup-token` — lets docker auth with no
   * API key (subscription, not pay-per-use). Stored in the keychain, never in config. */
  agentOauthToken: string;
  planningModel: string;
  implementationModel: string;
  reviewModel: string;
  /** Ordered fallback agents (failover when the one above is out of capacity). */
  fallbacks: FallbackEntry[];
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

export function initialState(): WizardState {
  return {
    provider: 'claude',
    transport: 'cli',
    agentKey: '',
    agentOauthToken: '',
    planningModel: 'opus',
    implementationModel: 'sonnet',
    reviewModel: 'opus',
    fallbacks: [],
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

export function serviceFor(provider: WizardState['provider']): string {
  return { claude: 'anthropic', gemini: 'google', gpt: 'openai' }[provider];
}

// Use the CLIs' own version-agnostic tier aliases, never concrete version numbers
// (those churn constantly and would go stale). Each CLI resolves the alias to its
// current model: claude opus/sonnet/haiku, gemini pro/flash/flash-lite (also `auto`).
export const MODELS: Record<WizardState['provider'], string[]> = {
  claude: ['opus', 'sonnet', 'haiku'],
  gemini: ['pro', 'flash', 'flash-lite'],
  gpt: ['gpt-5', 'gpt-5-mini', 'o4-mini'],
};

export function defaultModels(provider: WizardState['provider']): {
  planning: string;
  implementation: string;
  review: string;
} {
  const m = MODELS[provider];
  const first = m[0] ?? '';
  return { planning: first, implementation: m[1] ?? first, review: first };
}

/** A new fallback entry defaulting to the given provider's models (cli transport). */
export function newFallback(provider: WizardState['provider'] = 'gemini'): FallbackEntry {
  const d = defaultModels(provider);
  return {
    provider,
    key: '',
    oauthToken: '',
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

/** Providers that can't run under the docker backend: gemini (no in-container token,
 *  no ~/.gemini mount). claude (oauth token / mount) and gpt (codex auth import / API
 *  key) ARE supported. Disallowed as primary OR fallback when the backend is docker. */
function dockerBlocked(provider: string): boolean {
  return provider === 'gemini';
}
export function dockerProviderConflict(s: WizardState): boolean {
  return s.backend === 'docker' && (dockerBlocked(s.provider) || s.fallbacks.some((f) => dockerBlocked(f.provider)));
}

export function validateStep(step: number, s: WizardState, isSaved: SecretSavedFn = () => false): string {
  switch (step) {
    case 0:
      if (dockerProviderConflict(s)) return vt('validate.geminiDocker');
      if (s.transport === 'api' && !s.agentKey.trim() && !isSaved(serviceFor(s.provider), 'default'))
        return vt('validate.apiKeyApi');
      // Docker has no auth source unless one of: host-login mount, an API key, or a
      // subscription OAuth token (claude setup-token). Require at least one.
      if (
        s.backend === 'docker' &&
        !s.dockerMountLogin &&
        !s.agentKey.trim() &&
        !isSaved(serviceFor(s.provider), 'default') &&
        !s.agentOauthToken.trim() &&
        !isSaved(serviceFor(s.provider), 'oauth')
      )
        return vt('validate.apiKeyDocker');
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
      // Workspace step: catch a docker+gemini combo even when the AI step isn't open.
      if (dockerProviderConflict(s)) return vt('validate.geminiDocker');
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

/** YAML for agent.fallbacks (one ordered entry each). Credential accounts are unique
 *  per index (fb0, fb1, …) so multiple agents — even same provider — never collide. */
function fallbackYaml(s: WizardState): string[] {
  if (s.fallbacks.length === 0) return [];
  const lines = ['  fallbacks:'];
  s.fallbacks.forEach((f, i) => {
    const svc = serviceFor(f.provider);
    lines.push(
      `    - provider: ${f.provider}`,
      '      transport: cli',
      `      credential: { service: ${svc}, account: fb${i} }`,
    );
    if (f.provider === 'claude') lines.push(`      oauth_credential: { service: ${svc}, account: fb${i}-oauth }`);
    lines.push(
      '      models:',
      `        planning: ${yamlStr(f.planningModel)}`,
      `        implementation: ${yamlStr(f.implementationModel)}`,
      `        review: ${yamlStr(f.reviewModel)}`,
    );
  });
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
    `  credential: { service: ${serviceFor(s.provider)}, account: default }`,
    `  oauth_credential: { service: ${serviceFor(s.provider)}, account: oauth }`,
    '  models:',
    `    planning: ${yamlStr(s.planningModel)}`,
    `    implementation: ${yamlStr(s.implementationModel)}`,
    `    review: ${yamlStr(s.reviewModel)}`,
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
  clone.agentKey = '';
  clone.agentOauthToken = '';
  for (const f of clone.fallbacks) {
    f.key = '';
    f.oauthToken = '';
  }
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
    return { ...initialState(), ...(JSON.parse(raw) as Partial<WizardState>) };
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

/** Secret refs (service/account) the wizard manages — to check keychain.has on load. */
export function secretRefs(s: WizardState): Array<{ service: string; account: string }> {
  const refs: Array<{ service: string; account: string }> = [];
  for (const r of s.repos) if (r.key.trim()) refs.push({ service: r.provider, account: r.key });
  if (s.trackerKind === 'notion') refs.push({ service: 'notion', account: 'default' });
  else if (s.trackerKind === 'jira') refs.push({ service: 'jira', account: 'default' });
  if (s.referenceRepo.trim()) refs.push({ service: 'reference', account: 'default' });
  refs.push({ service: serviceFor(s.provider), account: 'default' });
  refs.push({ service: serviceFor(s.provider), account: 'oauth' });
  s.fallbacks.forEach((f, i) => {
    refs.push({ service: serviceFor(f.provider), account: `fb${i}` });
    if (f.provider === 'claude') refs.push({ service: serviceFor(f.provider), account: `fb${i}-oauth` });
  });
  return refs;
}

/** Secrets to persist (service, account, value). Per-repo creds use account = key. */
export function secretsFor(s: WizardState): Array<{ service: string; account: string; value: string }> {
  const out: Array<{ service: string; account: string; value: string }> = [];
  for (const r of s.repos) out.push({ service: r.provider, account: r.key, value: r.token });
  if (s.trackerKind === 'notion') out.push({ service: 'notion', account: 'default', value: s.notionToken });
  else if (s.trackerKind === 'jira') out.push({ service: 'jira', account: 'default', value: s.jiraToken });
  // github_issues reuses a GitHub repo's token (its account = key) — already added above.
  if (s.referenceRepo.trim() && s.referenceToken.trim()) {
    out.push({ service: 'reference', account: 'default', value: s.referenceToken });
  }
  if (s.agentKey.trim()) out.push({ service: serviceFor(s.provider), account: 'default', value: s.agentKey });
  if (s.agentOauthToken.trim())
    out.push({ service: serviceFor(s.provider), account: 'oauth', value: s.agentOauthToken });
  s.fallbacks.forEach((f, i) => {
    if (f.key.trim()) out.push({ service: serviceFor(f.provider), account: `fb${i}`, value: f.key });
    if (f.provider === 'claude' && f.oauthToken.trim())
      out.push({ service: serviceFor(f.provider), account: `fb${i}-oauth`, value: f.oauthToken });
  });
  // Trim so a stray trailing space/newline from a paste never reaches the API.
  return out.map((x) => ({ ...x, value: x.value.trim() })).filter((x) => x.value);
}
