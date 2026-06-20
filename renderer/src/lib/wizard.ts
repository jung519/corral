/** Setup-wizard state → corral.yaml + the secret writes. Secrets never go into the
 * config — only CredentialRef pointers do. Repositories are a list (multi-repo);
 * each repo has its own key + description + credential (account = key). */

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
  port: number;
  maxActive: number;
  language: string;
  stack: string;
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
    port: 4400,
    maxActive: 3,
    language: 'en',
    stack: 'generic',
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

export function validateStep(step: number, s: WizardState): string {
  switch (step) {
    case 0:
      if (s.transport === 'api' && !s.agentKey.trim()) return 'API key is required for the api transport.';
      return '';
    case 1: {
      if (s.repos.length === 0) return 'Add at least one repository.';
      const keys = new Set<string>();
      for (const r of s.repos) {
        if (!r.key.trim()) return 'Every repository needs a key.';
        if (keys.has(r.key)) return `Duplicate repository key "${r.key}".`;
        keys.add(r.key);
        if (!OWNER_NAME.test(r.repo)) return `Repository "${r.key}" must be "owner/name".`;
        if (!r.token.trim()) return `A token is required for "${r.key}".`;
        if (r.provider === 'gitlab' && !r.gitlabHost.trim()) return `A GitLab host is required for "${r.key}".`;
        if (r.provider === 'bitbucket' && !r.bitbucketUser.trim()) return `A Bitbucket username is required for "${r.key}".`;
      }
      return '';
    }
    case 2:
      for (const k of CORE_STATE_KEYS) if (!s.states[k].trim()) return `State mapping "${k}" is required.`;
      if (s.detailedStates) {
        for (const k of OPTIONAL_STATE_KEYS) if (!s.states[k].trim()) return `State mapping "${k}" is required.`;
      }
      if (s.trackerKind === 'notion') {
        if (!s.notionDb.trim()) return 'Notion database id is required.';
        if (!s.notionToken.trim()) return 'A Notion token is required.';
        if (!s.statusProp.trim() || !s.idProp.trim()) return 'Status and ID property names are required.';
      } else if (s.trackerKind === 'github_issues') {
        if (!OWNER_NAME.test(s.issuesRepo.trim() || firstGithub(s)?.repo || '')) return 'Issues repo must be "owner/name".';
      } else {
        if (!s.jiraHost.trim()) return 'A Jira host is required.';
        if (!s.jiraProject.trim()) return 'A Jira project key is required.';
        if (!s.jiraEmail.trim()) return 'A Jira account email is required.';
        if (!s.jiraToken.trim()) return 'A Jira API token is required.';
      }
      return '';
    case 4:
      if (!Number.isInteger(s.port) || s.port <= 0) return 'Port must be a positive integer.';
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
  return [
    '# Generated by the Corral setup wizard. Secrets live in the keychain / file store.',
    'profile:',
    `  language: ${yamlStr(s.language)}`,
    `  stack: ${yamlStr(s.stack)}`,
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
    '',
    'channel:',
    '  kind: web',
    `  port: ${s.port}`,
    '',
    `max_active_issues: ${s.maxActive}`,
    '',
  ].join('\n');
}

/** Secrets to persist (service, account, value). Per-repo creds use account = key. */
export function secretsFor(s: WizardState): Array<{ service: string; account: string; value: string }> {
  const out: Array<{ service: string; account: string; value: string }> = [];
  for (const r of s.repos) out.push({ service: r.provider, account: r.key, value: r.token });
  if (s.trackerKind === 'notion') out.push({ service: 'notion', account: 'default', value: s.notionToken });
  else if (s.trackerKind === 'jira') out.push({ service: 'jira', account: 'default', value: s.jiraToken });
  // github_issues reuses a GitHub repo's token (its account = key) — already added above.
  if (s.agentKey.trim()) out.push({ service: serviceFor(s.provider), account: 'default', value: s.agentKey });
  return out.filter((x) => x.value.trim());
}
