/** Setup-wizard state → corral.yaml + the secret writes. Secrets never go into the
 * config — only CredentialRef pointers do. Repository (github/gitlab/bitbucket) and
 * tracker (notion/github_issues/jira) are each provider-selectable. */

export type RepoProvider = 'github' | 'gitlab' | 'bitbucket';
export type TrackerKind = 'notion' | 'github_issues' | 'jira';

export interface WizardState {
  // AI
  provider: 'claude' | 'gemini' | 'gpt';
  transport: 'api' | 'cli';
  agentKey: string;
  planningModel: string;
  implementationModel: string;
  reviewModel: string;
  // Repository
  repoProvider: RepoProvider;
  repo: string; // owner/name (github/gitlab) or workspace/slug (bitbucket)
  repoKey: string;
  production: string;
  development: string;
  repoToken: string;
  gitlabHost: string; // gitlab only
  bitbucketUser: string; // bitbucket only
  // Tracker
  trackerKind: TrackerKind;
  // Notion
  notionDb: string;
  notionToken: string;
  statusProp: string;
  idProp: string;
  repoProp: string;
  scopeProp: string;
  // GitHub Issues
  issuesRepo: string;
  scopeLabel: string;
  identifierPrefix: string;
  // Jira
  jiraHost: string;
  jiraProject: string;
  jiraEmail: string;
  jiraToken: string;
  // shared semantic state → tracker value
  states: { planning: string; plan_review: string; in_progress: string; in_review: string; done: string };
  // Workspace / channel / profile
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
    repoProvider: 'github',
    repo: '',
    repoKey: 'main',
    production: 'main',
    development: 'develop',
    repoToken: '',
    gitlabHost: 'https://gitlab.com',
    bitbucketUser: '',
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
    backend: 'local',
    port: 4400,
    maxActive: 3,
    language: 'en',
    stack: 'generic',
  };
}

/** Keychain service name for the chosen AI provider. */
export function serviceFor(provider: WizardState['provider']): string {
  return { claude: 'anthropic', gemini: 'google', gpt: 'openai' }[provider];
}

const OWNER_NAME = /^[^/\s]+\/[^/\s]+$/;

export function validateStep(step: number, s: WizardState): string {
  switch (step) {
    case 0:
      if (s.transport === 'api' && !s.agentKey.trim()) return 'API key is required for the api transport.';
      return '';
    case 1:
      if (!OWNER_NAME.test(s.repo)) return 'Repository must be "owner/name".';
      if (!s.repoToken.trim()) return 'A repository token is required.';
      if (!s.repoKey.trim()) return 'A routing key is required.';
      if (s.repoProvider === 'gitlab' && !s.gitlabHost.trim()) return 'A GitLab host is required.';
      if (s.repoProvider === 'bitbucket' && !s.bitbucketUser.trim()) return 'A Bitbucket username is required.';
      return '';
    case 2:
      for (const [k, v] of Object.entries(s.states)) if (!v.trim()) return `State mapping "${k}" is required.`;
      if (s.trackerKind === 'notion') {
        if (!s.notionDb.trim()) return 'Notion database id is required.';
        if (!s.notionToken.trim()) return 'A Notion token is required.';
        if (!s.statusProp.trim() || !s.idProp.trim()) return 'Status and ID property names are required.';
      } else if (s.trackerKind === 'github_issues') {
        if (!OWNER_NAME.test(s.issuesRepo.trim() || s.repo.trim())) return 'Issues repo must be "owner/name".';
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
  const lines = ['repositories:', `  - kind: ${s.repoProvider}`, `    key: ${yamlStr(s.repoKey)}`, `    repo: ${yamlStr(s.repo)}`];
  if (s.repoProvider === 'gitlab') lines.push(`    host: ${yamlStr(s.gitlabHost)}`);
  if (s.repoProvider === 'bitbucket') lines.push(`    username: ${yamlStr(s.bitbucketUser)}`);
  lines.push(
    `    credential: { service: ${s.repoProvider}, account: default }`,
    '    branch_strategy:',
    `      production: ${yamlStr(s.production)}`,
    `      development: ${yamlStr(s.development)}`,
  );
  return lines;
}

function trackerYaml(s: WizardState): string[] {
  const states = Object.entries(s.states).map(([k, v]) => `    ${k}: ${yamlStr(v)}`);
  if (s.trackerKind === 'github_issues') {
    const lines = [
      'tracker:',
      '  kind: github_issues',
      `  repo: ${yamlStr(s.issuesRepo.trim() || s.repo)}`,
      '  credential: { service: github, account: default }',
      `  repo_key: ${yamlStr(s.repoKey)}`,
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
      `  repo_key: ${yamlStr(s.repoKey)}`,
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

/** Secrets to persist (service, account, value). Empty values skipped. */
export function secretsFor(s: WizardState): Array<{ service: string; account: string; value: string }> {
  const out: Array<{ service: string; account: string; value: string }> = [
    { service: s.repoProvider, account: 'default', value: s.repoToken },
  ];
  if (s.trackerKind === 'notion') out.push({ service: 'notion', account: 'default', value: s.notionToken });
  else if (s.trackerKind === 'jira') out.push({ service: 'jira', account: 'default', value: s.jiraToken });
  // github_issues reuses the GitHub repo token (service "github").
  if (s.agentKey.trim()) out.push({ service: serviceFor(s.provider), account: 'default', value: s.agentKey });
  return out.filter((x) => x.value.trim());
}
