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
  | 'signal.requestMoreReview'
  | 'cost.summaryHeading';

export type Messages = Record<MessageKey, string>;

const en: Messages = {
  'review.noIssues': 'No issues found',
  'review.resolved': 'resolved',
  'review.unresolved': 'unresolved',
  'signal.approved': 'APPROVED',
  'signal.requestMoreReview': 'REQUEST FURTHER REVIEW',
  'cost.summaryHeading': 'Cost',
};

const ko: Messages = {
  'review.noIssues': '특이사항 없음',
  'review.resolved': '해결됨',
  'review.unresolved': '미해결',
  'signal.approved': '승인됨',
  'signal.requestMoreReview': '더 검토 요청',
  'cost.summaryHeading': '비용',
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
