/** Renderer UI i18n. Default English; Korean available via the language toggle
 * (persisted to localStorage). Separate from `profile.language` in config, which
 * controls the AGENT's output language, not the UI. */

export type Lang = 'en' | 'ko';

type Dict = Record<string, string>;

const en: Dict = {
  'app.title': 'Corral — Setup',
  'wizard.sidebar': 'Setup',
  'wizard.back': 'Back',
  'wizard.next': 'Next',
  'wizard.finish': 'Finish & start',
  'wizard.saving': 'Saving…',
  'wizard.browserPreview': 'Browser preview — saving requires the desktop app.',
  'step.ai': 'AI provider',
  'step.repo': 'Repository',
  'step.tracker': 'Tracker',
  'step.workspace': 'Workspace',
  'step.channel': 'Channel & budget',
  'step0.subtitle': 'Choose your coding agent. Keys are stored only in the OS keychain.',
  'transport.api': 'API (BYOK)',
  'transport.cli': 'CLI (detected)',
  'agent.pingOk': 'connection ok',
  'agent.modelsLabel': 'Per-stage models',
  'field.apiKey': 'API key',
  'field.apiKey.optionalCli': ' · optional for CLI',
  'field.planningModel': 'Planning model',
  'field.implModel': 'Implementation model',
  'status.validated': 'validated',
  'status.testing': 'testing…',
  'status.ok': 'ok',
  'status.failed': 'failed',
  'test.key': 'Test key',
  'test.token': 'Test token',
  'field.repo': 'Repository (owner/name)',
  'field.githubToken': 'GitHub token (keychain)',
  'field.routingKey': 'Routing key',
  'field.prodBranch': 'Production branch',
  'field.devBranch': 'Development branch',
  'tracker.label': 'Tracker (where issues come from — not limited to Notion)',
  'field.notionDb': 'Notion database id',
  'field.notionToken': 'Notion token (keychain)',
  'field.statusProp': 'Status property',
  'field.idProp': 'ID property',
  'field.repoProp': 'Repo property (optional)',
  'field.scopeProp': 'Scope checkbox (optional)',
  'field.issuesRepo': 'Issues repo (blank = work repo)',
  'field.scopeLabel': 'Scope label (optional gate)',
  'field.idPrefix': 'Identifier prefix',
  'tracker.ghHint': 'Uses your GitHub token. Semantic states map to issue labels below.',
  'states.notion': 'State → Notion status',
  'states.github': 'State → GitHub label',
  'workspace.backend': 'Workspace backend',
  'workspace.detect': 'Detect Docker',
  'workspace.dockerNone': '✗ Docker not found — use local',
  'field.port': 'Control-plane port',
  'field.maxActive': 'Max active issues',
  'field.language': 'Agent output language',
  'field.stack': 'Stack profile',
};

const ko: Dict = {
  'app.title': 'Corral — 초기 설정',
  'wizard.sidebar': '설정 마법사',
  'wizard.back': '이전',
  'wizard.next': '다음',
  'wizard.finish': '완료 · 시작',
  'wizard.saving': '저장 중…',
  'wizard.browserPreview': '브라우저 미리보기 — 저장은 데스크톱 앱에서 가능합니다.',
  'step.ai': 'AI 프로바이더',
  'step.repo': '저장소',
  'step.tracker': '트래커',
  'step.workspace': '워크스페이스',
  'step.channel': '채널 · 예산',
  'step0.subtitle': '코딩 에이전트를 선택하세요. 키는 OS 키체인에만 저장됩니다.',
  'transport.api': 'API (BYOK)',
  'transport.cli': 'CLI (설치 감지)',
  'agent.pingOk': '연결 ping 성공',
  'agent.modelsLabel': '단계별 모델',
  'field.apiKey': 'API 키',
  'field.apiKey.optionalCli': ' · CLI는 선택',
  'field.planningModel': '계획 모델',
  'field.implModel': '구현 모델',
  'status.validated': '검증됨',
  'status.testing': '검증 중…',
  'status.ok': '정상',
  'status.failed': '실패',
  'test.key': '키 검증',
  'test.token': '토큰 검증',
  'field.repo': '저장소 (owner/name)',
  'field.githubToken': 'GitHub 토큰 (키체인)',
  'field.routingKey': '라우팅 키',
  'field.prodBranch': '운영 브랜치',
  'field.devBranch': '개발 브랜치',
  'tracker.label': '트래커 (이슈 출처 — Notion 강제 아님)',
  'field.notionDb': 'Notion 데이터베이스 id',
  'field.notionToken': 'Notion 토큰 (키체인)',
  'field.statusProp': '상태 속성',
  'field.idProp': 'ID 속성',
  'field.repoProp': '저장소 속성 (선택)',
  'field.scopeProp': '범위 체크박스 (선택)',
  'field.issuesRepo': '이슈 저장소 (비우면 작업 저장소)',
  'field.scopeLabel': '범위 라벨 (선택 게이트)',
  'field.idPrefix': '식별자 접두',
  'tracker.ghHint': 'GitHub 토큰을 재사용합니다. 아래 의미 상태가 이슈 라벨에 매핑됩니다.',
  'states.notion': '상태 → Notion 상태',
  'states.github': '상태 → GitHub 라벨',
  'workspace.backend': '워크스페이스 백엔드',
  'workspace.detect': 'Docker 감지',
  'workspace.dockerNone': '✗ Docker 없음 — local 사용',
  'field.port': '컨트롤 플레인 포트',
  'field.maxActive': '동시 이슈 한도',
  'field.language': '에이전트 출력 언어',
  'field.stack': '스택 프로파일',
};

const catalog: Record<Lang, Dict> = { en, ko };

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem('corral.lang');
    if (saved === 'en' || saved === 'ko') return saved;
  } catch {
    /* no localStorage */
  }
  return 'en';
}

let lang = $state<Lang>(initialLang());

export function currentLang(): Lang {
  return lang;
}

export function setLang(next: Lang): void {
  lang = next;
  try {
    localStorage.setItem('corral.lang', next);
  } catch {
    /* ignore */
  }
}

/** Translate a key for the current language (falls back to English, then the key). */
export function t(key: string): string {
  return catalog[lang][key] ?? en[key] ?? key;
}
