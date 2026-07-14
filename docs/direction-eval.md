# Direction — 효과 검증(eval)

> 목적: **방향성(Direction)이 실제로 계획·리뷰를 바꾸는지**, 그리고 **과하지도 모자라지도
> 않은지**를 확인한다. 계획서 §9에서 "가장 어려운 부분 = 효과 입증"으로 지목한 작업.

검증은 두 층으로 나뉜다.

## 1. 배선 검증 (결정적, 무료 — 자동)

"방향성이 프롬프트/가이드에 실제로 주입되는가"는 유닛 테스트로 이미 고정되어 있다. AI·비용
없이 매 빌드에서 확인된다:

- 계획 가이드: `src/agent/prompt-builder.test.ts` — direction 있으면 WORKFLOW.md에
  `Direction (방향성` 블록 + 프레이밍 가드, 없으면 미출력.
- 리뷰 라운드: `src/review/prompt.test.ts` — `reviewRoundPrompt`에 direction 주입 + "심각도만
  보정, 정확성은 BLOCKER 유지" 가드, 없으면 미출력.
- 계획 비평: `src/review/prompt.test.ts` — `planCritiquePrompt`에 direction("guiding, not a rule").
- 병합·검증: `src/core/direction.test.ts` — `mergeDirection`(스코프 병합), 해시 기반 verified,
  verdict 파싱.

→ "코어가 방향성을 올바른 지점에 실어 보낸다"는 여기서 보증된다.

## 2. 행동 검증 (A/B, 실제 실행 — 수동)

"실린 방향성이 결과를 실제로 바꾸는가"는 같은 이슈를 방향성 **끄고/켜고** 돌려 비교해야 한다.
이건 실제 에이전트를 쓰므로 비용이 든다.

### 준비
- 설정 완료된 앱 + 에이전트 1개.
- **판단 여지가 있는 이슈** 1개를 고른다(정답이 하나면 방향성 영향이 안 보인다). 예: "최소로
  빠르게 vs 견고하게 리팩터까지" 둘 다 말이 되는 기능.

### Run A — 방향성 OFF
- 셋업에서 전역 방향성을 **비우고 저장**(또는 검사 **미허용**) → 주입 안 됨.
- 프로젝트 방향성이 있다면 그 레포의 `.corral/DIRECTION.md`도 비운다.
- 이슈 시작 → 다음 산출물 보관:
  - `.corral/pending_plan.md` (계획)
  - `.corral/plan_options.json` (옵션 라벨)
  - `.corral/pending_review.md` (리뷰)

### Run B — 방향성 ON
- 전역 방향성에 **명확한 한 방향**을 적는다. 예:
  ```
  ## 우선순위
  - 안정 > 기능 속도
  ## 의사결정 원칙
  - 새 의존성은 정당화 필요
  ```
- **검사 허용(동의) → 이슈 시작 시 검사 통과(verified) 확인**(미검증이면 주입 안 되므로 A와
  차이가 안 난다 — 타임라인의 "방향성 검토 완료" 이벤트로 확인).
- **같은 이슈를 재시작**(restart) → 같은 산출물 보관.

### 비교 포인트
| 산출물 | A→B에서 볼 것 |
|---|---|
| pending_plan.md | 접근이 방향대로 기우는가(예: 최소 변경·의존성 회피) |
| plan_options.json | 추천/순서가 방향 쪽으로 바뀌는가 |
| pending_review.md | 주관·우선순위 findings의 **심각도**가 보정되는가 |

## 3. 판정 기준

**정상(방향성이 살아있음)**
- 이슈가 중립인 지점에서 계획이 방향대로 기운다.
- 리뷰의 주관/미관 findings 심각도가 방향에 맞춰 오르내린다.

**과함(over-tuned) — 프레이밍을 조여야 하는 신호**
- 방향을 규칙처럼 강제해 더 나은 해법을 비튼다.
- 리뷰가 **정확성·보안·데이터손실·동작파손 BLOCKER를 완화**한다(→ 절대 금지 가드 위반).
- 방향에 맞추려고 **없는 findings를 만든다**, 또는 옵션을 억지로 3개로 늘린다.

**모자람(under-tuned)**
- A와 B가 사실상 동일 → 방향 문구가 너무 추상적이거나(구체 예시 부족), verified가 안 됐거나,
  이슈에 판단 여지가 없었다. 문구를 구체화하거나 다른 이슈로 재시도.

## 4. 튜닝 손잡이

결과가 과하거나 모자라면 코드가 아니라 **프레이밍**을 만진다:
- 계획: `WORKFLOW.md`의 `{% if direction %}` 블록.
- 리뷰 라운드: `src/review/prompt.ts` `reviewRoundPrompt`의 direction 문단.
- 리뷰 통합: `WORKFLOW.md` "Consolidate review" 절.
- 계획 비평: `src/review/prompt.ts` `planCritiquePrompt`의 direction 문단.

가드 원칙은 고정: **이슈 정확성·요구 우선, skills는 binding, 방향은 중립일 때의 기본값,
정확성/보안 findings는 방향과 무관하게 유지.**
