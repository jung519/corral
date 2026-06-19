/** Message catalog — the language seam.
 *
 * Upstream hardcoded Korean strings into review/cost prompts (특이사항 없음, 해결됨,
 * 승인됨, …). Those move here as keyed messages so the core stays language-neutral
 * and the S2 review-pipeline lift pulls phrasing from the configured language. */

export type MessageKey =
  | 'review.noIssues'
  | 'review.resolved'
  | 'review.unresolved'
  | 'signal.approved'
  | 'signal.feedback'
  | 'signal.requestMoreReview'
  | 'signal.resume'
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
  'signal.approved': 'APPROVED',
  'signal.feedback': 'FEEDBACK',
  'signal.requestMoreReview': 'REQUEST FURTHER REVIEW',
  'signal.resume':
    'The previous run was interrupted by a restart. Per the workflow guide, resume and finish the interrupted work (implementation, or applying review findings).',
  'cost.summaryHeading': 'Cost summary',
  'cost.total': 'Total cost',
  'cost.dispatches': 'Dispatches',
  'cost.tokens': 'Tokens (in/out)',
  'cost.none': 'No cost recorded.',
};

const ko: Messages = {
  'review.noIssues': '특이사항 없음',
  'review.resolved': '해결됨',
  'review.unresolved': '미해결',
  'signal.approved': '승인됨',
  'signal.feedback': '피드백',
  'signal.requestMoreReview': '더 검토 요청',
  'signal.resume': '이전 작업이 재시작으로 중단되었습니다. 워크플로우 가이드에 따라 중단된 작업(구현 또는 리뷰 지적 수정)을 이어서 완료하세요.',
  'cost.summaryHeading': '비용 요약',
  'cost.total': '총 비용',
  'cost.dispatches': '디스패치 횟수',
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
