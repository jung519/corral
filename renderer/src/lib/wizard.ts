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

export interface WizardState {
  provider: 'claude' | 'gemini' | 'gpt';
  transport: 'api' | 'cli';
  agentKey: string;
  planningModel: string;
  implementationModel: string;
  reviewModel: string;
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
    planningModel: 'opus',
    implementationModel: 'sonnet',
    reviewModel: 'opus',
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

export const MODELS: Record<WizardState['provider'], string[]> = {
  claude: ['opus', 'sonnet', 'haiku'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
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

export function validateStep(step: number, s: WizardState, isSaved: SecretSavedFn = () => false): string {
  switch (step) {
    case 0:
      if (s.transport === 'api' && !s.agentKey.trim() && !isSaved(serviceFor(s.provider), 'default'))
        return vt('validate.apiKeyApi');
      // Docker without the host login mount has no auth source → require an API key.
      if (s.backend === 'docker' && !s.dockerMountLogin && !s.agentKey.trim() && !isSaved(serviceFor(s.provider), 'default'))
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

export function buildConfigYaml(s: WizardState): string {
  const profile = ['profile:', `  language: ${yamlStr(s.language)}`, `  stack: ${yamlStr(s.stack)}`];
  if (s.referenceRepo.trim()) {
    profile.push(`  reference_repo: ${yamlStr(s.referenceRepo.trim())}`);
    if (s.referenceToken.trim()) profile.push('  reference_credential: { service: reference, account: default }');
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
    '  models:',
    `    planning: ${yamlStr(s.planningModel)}`,
    `    implementation: ${yamlStr(s.implementationModel)}`,
    `    review: ${yamlStr(s.reviewModel)}`,
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
  // Trim so a stray trailing space/newline from a paste never reaches the API.
  return out.map((x) => ({ ...x, value: x.value.trim() })).filter((x) => x.value);
}
