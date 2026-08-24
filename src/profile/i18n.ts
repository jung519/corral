/** Message catalog — the language seam.
 *
 * Upstream hardcoded Korean strings into review/cost prompts (특이사항 없음, 해결됨,
 * 승인됨, …). Those move here as keyed messages so the core stays language-neutral
 * and the S2 review-pipeline lift pulls phrasing from the configured language. */

export type MessageKey =
  | 'review.noIssues'
  | 'review.resolved'
  | 'review.unresolved'
  | 'review.reqMet'
  | 'review.reqUnmet'
  | 'signal.approved'
  | 'signal.feedback'
  | 'signal.requestMoreReview'
  | 'signal.resume'
  | 'signal.resumeUncommitted'
  | 'stuck.noChanges'
  | 'stuck.uncommitted'
  | 'cost.summaryHeading'
  | 'cost.total'
  | 'cost.dispatches'
  | 'cost.tokens'
  | 'cost.none';

export type Messages = Record<MessageKey, string>;

const en: Messages = {
  'review.noIssues': 'No issues found',
  'review.resolved': 'resolved',
  'review.unresolved': 'unresolved',
  'review.reqMet': 'MET',
  'review.reqUnmet': 'UNMET',
  'signal.approved': 'APPROVED',
  'signal.feedback': 'FEEDBACK',
  'signal.requestMoreReview': 'REQUEST FURTHER REVIEW',
  'signal.resume':
    'The previous run was interrupted by a restart. Per the workflow guide, resume and finish the interrupted work (implementation, or applying review findings).',
  'signal.resumeUncommitted':
    'There are UNCOMMITTED changes in the work tree from the previous run. Review them and commit them on the work branch before anything else — that work is not lost, it was simply never committed.',
  'stuck.noChanges':
    'No committed changes detected in any repo, and the work tree is clean — the agent produced nothing. Press Retry to run the implementation again.',
  'stuck.uncommitted':
    'The agent edited files but never committed them. Nothing is lost. Press Retry to resume and commit. Uncommitted:',
  'cost.summaryHeading': 'Cost summary',
  'cost.total': 'Total cost',
  'cost.dispatches': 'AI runs',
  'cost.tokens': 'Tokens (in/out)',
  'cost.none': 'No cost recorded.',
};

const ko: Messages = {
  'review.noIssues': '특이사항 없음',
  'review.resolved': '해결됨',
  'review.unresolved': '미해결',
  'review.reqMet': '충족',
  'review.reqUnmet': '미충족',
  'signal.approved': '승인됨',
  'signal.feedback': '피드백',
  'signal.requestMoreReview': '더 검토 요청',
  'signal.resume': '이전 작업이 재시작으로 중단되었습니다. 워크플로우 가이드에 따라 중단된 작업(구현 또는 리뷰 지적 수정)을 이어서 완료하세요.',
  'signal.resumeUncommitted':
    '이전 실행의 작업 트리에 커밋되지 않은 변경이 있습니다. 다른 일보다 먼저 그 변경을 확인하고 작업 브랜치에 커밋하세요. 작업이 사라진 것이 아니라 커밋되지 않았을 뿐입니다.',
  'stuck.noChanges':
    '커밋된 변경도 없고 작업 트리도 깨끗합니다 — 에이전트가 아무것도 만들지 않았습니다. 재시도를 누르면 구현을 다시 실행합니다.',
  'stuck.uncommitted':
    '에이전트가 파일은 고쳤지만 커밋하지 않았습니다. 작업은 그대로 있습니다. 재시도를 누르면 이어서 커밋합니다. 커밋되지 않은 변경:',
  'cost.summaryHeading': '비용 요약',
  'cost.total': '총 비용',
  'cost.dispatches': 'AI 실행 횟수',
  'cost.tokens': '토큰 (입력/출력)',
  'cost.none': '집계된 비용이 없습니다.',
};

const CATALOG: Record<string, Messages> = { en, ko };

/** Default language used when the configured one has no catalog. */
export const DEFAULT_LANGUAGE = 'en';

export type Translator = (key: MessageKey) => string;

/** Build a translator for a language, falling back to English for unknown languages. */
export function createTranslator(language: string): Translator {
  const messages = CATALOG[language] ?? CATALOG[DEFAULT_LANGUAGE]!;
  return (key) => messages[key];
}

export function availableLanguages(): string[] {
  return Object.keys(CATALOG);
}
