# Spec mode — 계획을 요구사항·설계·태스크로 나눠 승인하기

> 대상: EARS 를 모르는 사용자. 예시는 전부 **corral 이 자기 이슈를 돌려 실제로 만든 문서**에서
> 가져왔다 — 지어낸 것이 하나도 없다.

기본 동작은 **계획 문서 하나를 한 번 승인**하는 것이다. Spec mode 는 그 한 번을 셋으로 나눈다.

```
요구사항 → 승인 → 설계 → 승인 → 태스크 → 승인 → 구현 → 리뷰 → PR
```

## 지금 무엇이 되는가

| 층 | 상태 |
|---|---|
| 계획이 스펙 형식으로 나온다 (EARS · `REQ-n`) | ✅ |
| 요구사항·설계·태스크 세 단계 승인 게이트 | ✅ |
| 태스크 상태 추적 — 진행률, 남은 태스크부터 재개, 완료 표시 대조 | ✅ |
| 의존성을 보고 태스크를 **병렬로** 돌리기 | ❌ 없다 |

태스크는 **순서대로 하나씩** 돈다. `[after: T1]` 은 순서를 정하는 데만 쓰이고, 서로 의존하지
않는 태스크를 동시에 돌리지는 않는다.

## 켜는 법과 그 대가

설정 → 환경설정 → **계획 방식** 에서 *"요구사항·설계·태스크"* 를 고른다. 설정 파일이라면:

```yaml
spec_mode: split   # 기본값은 single
```

**대가를 먼저 읽을 것.**

- 이슈당 AI 호출이 **약 2.4배**가 된다. 계획 3회 → 9회(문서 3종 × 초안·비평·통합)에,
  구현이 1회 → **태스크 수만큼**.
- 하루 토큰 상한은 **운영 AI 와 한 통**이다. 개발 쪽이 2.4배를 쓰면 그만큼 운영 파이프라인
  몫이 줄고, 상한이 차면 파이프라인은 큐에서 일감을 안 가져간다(유실은 없지만 처리도 없다).
  파이프라인 화면 헤더가 `개발 620k · 운영 80k` 처럼 **누가 썼는지** 보여 준다.

기본이 `single` 인 이유가 이것이다. 켜는 것은 그 대가를 알고 하는 선택이다.

## 세 단계가 각각 무엇인가

| 단계 | 답하는 질문 | 쓰는 파일 |
|---|---|---|
| 요구사항 | **무엇이 참이어야 하는가** — 파일 이름도 API 도 안 적는다 | `.corral/spec/requirements.md` |
| 설계 | **어떻게 만드는가** — 각 판단이 어느 `REQ-n` 을 위한 것인지 밝힌다 | `.corral/spec/design.md` |
| 태스크 | **무엇을 할 것인가** — 한 커밋 크기로 쪼갠 목록 | `.corral/spec/tasks.md` |

세 파일은 승인 뒤에도 남는다. 대시보드의 **스펙** 버튼으로 다시 볼 수 있다.

## EARS — 수용 기준을 쓰는 표기법

수용 기준을 *"잘 동작해야 한다"* 처럼 쓰면 나중에 충족 여부를 판정할 수가 없다. EARS 는
그것을 다섯 개의 고정된 문형으로 쓰게 한다.

| 형태 | 틀 | 언제 |
|---|---|---|
| 상시 | `THE SYSTEM SHALL …` | 조건 없이 늘 참이어야 하는 것 |
| 사건 | `WHEN <사건> THE SYSTEM SHALL …` | 어떤 일이 일어났을 때 |
| 상태 | `WHILE <상태> THE SYSTEM SHALL …` | 어떤 상태가 지속되는 동안 |
| 오류·예외 | `IF <조건> THEN THE SYSTEM SHALL …` | 원치 않는 조건이 성립했을 때 |
| 선택 기능 | `WHERE <기능이 있으면> THE SYSTEM SHALL …` | 그 기능이 켜져 있을 때만 |

**키워드는 출력 언어와 무관하게 영어로 쓴다.** 표기법이지 문장이 아니다. 설명은 설정한 언어로
나온다.

### 실물 예시

corral 이 자기 이슈(CRL-90 — *"리뷰가 도는 동안 화면이 구현이라고 말한다"*)로 만든 요구사항
문서에서 그대로 가져왔다.

```
REQ-1: WHEN the automated self-review of an implementation starts, THE SYSTEM SHALL
       transition the issue to a dedicated review-in-progress phase — persisted in issue
       state and announced with a phase event — before any review work runs.

REQ-2: WHILE the self-review is running, THE SYSTEM SHALL display the issue at the review
       stage with an active-work (spinner) indication, not at the implementation stage and
       not as waiting on a human.

REQ-5: THE SYSTEM SHALL present plan vetting and implementation review symmetrically: both
       switch to an in-progress phase with a phase event before the work starts, and both
       end in their respective awaiting-approval state.

REQ-7: IF the core restarts while an issue is in the review-in-progress phase, THEN THE
       SYSTEM SHALL recognize that phase during recovery and surface the issue as
       interrupted-and-retryable, rather than ignoring it or treating it as unknown.
```

네 형태가 한 문서에 다 나왔다 — 사건 · 상태 · 상시 · 오류.

### 흔한 실수 하나

**조건이 없는 요구사항을 `WHEN` 으로 뒤틀지 말 것.** `REQ-5` 는 *"두 흐름이 대칭이어야 한다"*
는 불변식이라 `WHEN` 을 붙일 사건이 없다. 상시형이 맞다.

`WHEN the build runs THE SYSTEM SHALL have no type errors` 같은 문장이 그 증상이다.

## 버그 수정 이슈는 세 절로 쓴다

결함 신고로 판단되면 요구사항 문서가 세 절로 나뉜다.

| 절 | 틀 | 무엇을 적나 |
|---|---|---|
| `## Current Behavior` | `WHEN <조건> THE SYSTEM <잘못된 동작>` | 결함을 재현하는 조건. **`SHALL` 을 쓰지 않는다** — 지금 일어나는 일이지 있어야 할 일이 아니다 |
| `## Expected Behavior` | 위 다섯 형태 | 고친 뒤의 동작 |
| `## Unchanged Behavior` | `WHEN <조건> THE SYSTEM SHALL CONTINUE TO <기존 동작>` | 이 수정이 **건드리면 안 되는 것** |

### 세 번째가 핵심이다

*"기존 테스트가 계속 통과한다"* 는 동작이 아니라 희망이다. **이 수정이 무엇을 깨뜨릴 수
있는지**를 적어야 한다 — 고칠 코드를 함께 쓰는 경로, 지금 타이밍에 기대는 호출자, 옛 동작이
지켜 주던 경우.

corral 이 CRL-92(*"빈 결과를 그대로 출력으로 내보낸다"*)로 만든 문서의 실물이다.

```
## Unchanged Behavior

REQ-12: WHEN delivery of a non-empty result fails (receiver outage, rejection of a
        non-empty payload), THE SYSTEM SHALL CONTINUE TO record a delivery failure and
        leave a queued event unsettled so it is retried.
```

*"빈 결과를 실패로 치지 말라"* 는 수정이 **진짜 전달 실패까지 삼켜 버릴 수 있다**는 것을
짚은 줄이다. 이런 것을 찾아 적는 절이다.

**위험한 것이 정말 없으면 그렇다고 한 줄 쓴다.** 빈 절과 *"건드리는 것이 없다"* 는 화면에서
같아 보이고 뜻은 반대다.

## `tasks.md` 형식 — 코드가 읽는다

이 파일만은 형식이 고정돼 있다. 진행률·재개 지점·완료 대조가 전부 이 파일을 파싱해서 나온다.

```md
- [ ] T1 — Add `'reviewing'` to the `IssuePhase` union (REQ-1, REQ-5, REQ-6, REQ-7)
- [ ] T2 — Persist the phase at the top of each review round (REQ-1, REQ-4) [after: T1]
```

- `- [ ] ` · `T<번호>` · ` — ` · 하는 일 · `(REQ-…)` · 선택적으로 `[after: T1]`
- 요구사항은 **한 개 이상** 반드시 적는다
- `[after:]` 는 정말 먼저 끝나야 하는 경우에만. 없는 의존은 일을 헛되이 직렬화한다
- **불변 요구사항(`SHALL CONTINUE TO`)에는 태스크를 만들지 않는다.** 같은 것을 유지하는 데는
  할 일이 없다

체크는 에이전트가 **코드를 커밋한 뒤에** 찍는다. `.corral/` 은 저장소 밖이라 그 체크는 커밋에
들어가지 않는다 — 그래서 corral 이 *"찍혔는데 커밋이 없다"* 를 잡아낼 수 있다.

읽을 수 없는 줄이 있으면 그 사실을 화면에 표시한다. **일부만 읽힌 파일 위의 깨끗한 진행률이
가장 위험한 화면이다.**

## 안 되는 것

- **태스크 병렬 실행** — 순차만 돈다
- **진행 중 이슈 마이그레이션** — 단일 계획으로 시작한 이슈는 그대로 끝난다. 모드를 바꿔도
  이미 승인된 계획은 계획대로 간다
- **형식을 벗어난 `tasks.md` 의 자동 교정** — 읽을 수 없으면 단일 구현으로 안전하게 내려간다

## 관련 문서

- `docs/sdd-adoption-plan.md` — 도입 계획과 결정 기록
- `docs/operational-ai-design.md` §3.3 — 상한을 개발·운영이 공유하는 이유(D12)
