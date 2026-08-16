# 학습 노트 — 스펙 주도 개발(SDD) · Corral · 운영AI

> 작성일: 2026-08-03
> 성격: **학습·설계 검토 노트**(코드 없음). 결정된 것과 미결인 것을 구분해 표기.
> 다룬 대상: [kiro.dev](https://kiro.dev/) 공식 문서 · `/Users/junghyun/Project/corral` ·
> `/Users/junghyun/Project/sojan/tilldone-sojan-server/apps/refinery`
> 개념도: `/Users/junghyun/Downloads/소잔_운영AI_개념도.pdf`

표기 규칙 — **[문서]** 공식 문서 확인 · **[코드]** 저장소에서 직접 확인 · **[추론]** 위 둘에서 끌어낸 판단(근거 명시).

---

## 1. Kiro와 스펙 주도 개발(SDD)

### 1.1 문제의식

기존 AI 코딩은 **프롬프트 → 코드**의 1단계 점프다. 구조적 문제가 셋.

- **의도가 휘발됨** — "왜 이렇게 만들었는지"가 채팅 로그에만 남고 저장소에 안 남는다.
- **검증 기준이 없음** — 생성된 코드가 맞는지 판단할 기준이 코드 자신뿐이다.
- **모호함이 코드에서 터짐** — "빠른 응답"이 구현 단계에 가서야 "500ms인가 5초인가"로 드러난다.

SDD는 여기에 **중간 산출물 계층**을 끼워 넣는다. 핵심 명제:

> **작업의 단위는 코드가 아니라 명세(spec)다.** 코드는 명세의 산출물이지 진실의 원천이 아니다.

### 1.2 3문서 구조 **[문서]**

| 문서 | 답하는 질문 | 담기는 것 |
|---|---|---|
| `requirements.md` | 무엇을 만드는가 | 사용자 스토리 + EARS 표기 수용 기준 |
| `design.md` | 어떻게 만드는가 | 아키텍처, 시퀀스 다이어그램, 데이터 흐름, 에러 처리, 테스트 전략 |
| `tasks.md` | 어떤 순서로 만드는가 | 추적 가능한 작업, 실시간 완료 상태 |

순차 생성이며 **각 단계마다 사람이 검토·승인**한 뒤 다음으로 넘어간다. 셋으로 쪼개는 이유는
**각 층위의 오류가 다른 시점에 잡히기 때문**이다 — 요구사항 모순은 설계 전에, 설계 결함은
코딩 전에 잡아야 비용이 싸다.

> ⚠️ Kiro 문서에는 **스펙 파일의 저장 경로가 명시돼 있지 않다**(확인함). `.kiro/steering/`은
> 명시돼 있으나 specs 경로는 문서에 없다.

### 1.3 EARS 표기법 **[문서]**

EARS(Easy Approach to Requirements Syntax). Rolls-Royce에서 항공기 엔진 요구사항용으로 만들어졌다.

Kiro 문서가 명시한 기본형:

```
WHEN [조건/이벤트] THE SYSTEM SHALL [기대 동작]
```

문서 예시:
> WHEN a user submits a form with invalid data THE SYSTEM SHALL display validation errors
> next to the relevant fields

EARS 표준에는 `WHILE [지속 상태] ... SHALL ...`, `IF [조건] THEN ... SHALL ...` 템플릿도 있다.

**이 문법이 주는 것 넷**

1. **명확성** — `SHALL`은 필수. "~하면 좋겠다"와 "~해야 한다"가 안 섞인다.
2. **테스트 가능성** — WHEN절이 given/when, THEN절이 assert가 된다. 문장 하나 = 테스트 하나.
3. **추적성** — 요구사항에 ID가 붙고 `tasks.md`의 작업이 그 ID를 참조한다.
4. **완전성** — 템플릿이 강제되면 "실패했을 때는?"이라는 빈칸이 눈에 보인다.

**결정적 지점**: EARS로 쓰인 요구사항은 **기계가 읽을 수 있다.** Kiro가 스펙에서 속성(property)을
추출해 property-based test를 자동 생성하는 근거가 이것이다. 요구사항 문서가 장식이 아니라
검증의 입력이 된다.

### 1.4 Analyze Requirements — 설계 전 모순 검출 **[문서]**

요구사항 완성 후 설계로 넘어가기 전, **요구사항 집합 전체를 교차 검토**한다. 개별이 아니라
요구사항들 *사이의* 문제를 찾는다.

1. **논리적 모순** — 각각은 타당한데 함께는 불가능
2. **모호한 표현** — "대용량 파일", "빠른 응답"
3. **충돌하는 제약** — 기능/비기능이 동시 만족 불가
4. **암묵적 가정** — 정의되지 않은 개념을 이미 있는 것처럼 참조
5. **누락된 엣지 케이스** — 장애 시나리오, 경계 조건, 동시 접근

몇 초가 아니라 **수 분** 걸린다(교차 추론이 계산 집약적). 금융·의료·규정준수처럼 요구사항
오류의 대가가 큰 도메인에 특히 권장.

### 1.5 tasks.md와 병렬 실행 **[문서]**

단순 체크리스트가 아니다. 작업 간 **의존성 그래프**를 만들어 Wave 단위로 실행한다.

- Wave 1 — 의존성 없는 작업 전부, 동시 실행
- Wave 2 — Wave 1 완료로 조건이 충족된 작업들
- Wave N — 전부 끝날 때까지

**설계 단계에서 의존성을 명시적으로 적어뒀기 때문에** 병렬화가 가능해진다. 즉흥적 코딩에서는
의존 관계가 암묵적이라 병렬 실행 자체가 불가능하다.

### 1.6 변형 **[문서]**

| 변형 | 성격 | 쓸 때 |
|---|---|---|
| Requirements-First | 시스템 동작 → 설계 | 제품 주도 개발 |
| Design-First | 기술 설계 → 요구사항 역도출 | 지연시간·처리량·규정준수 등 비기능 요구가 이미 정해진 경우 |
| Quick Spec | 승인 게이트 없이 3문서 한 번에 생성(대신 사전 질문으로 맥락 확보) | 잘 아는 기능, 빠른 프로토타이핑 |
| Bugfix Spec | `requirements.md` 대신 `bugfix.md` | 근본 원인이 불명확한 버그 |

⚠️ **워크플로는 시작 후 변경 불가.** 바꾸려면 새 스펙을 만들어야 한다.

**Bugfix Spec의 3섹션**

```
Current Behavior   : WHEN [조건] THEN the system [잘못된 동작]
Expected Behavior  : WHEN [조건] THEN the system SHALL [올바른 동작]
Unchanged Behavior : WHEN [조건] THEN the system SHALL CONTINUE TO [기존 동작]
```

세 번째가 이 구조의 발명이다. **"변하면 안 되는 것"을 명시적으로 적게 강제**한다. 검증 속성
3개(결함 재현 / 수정 동작 / 기존 동작 유지)로 보호하므로 **회귀 방지가 사후 테스트가 아니라
명세의 일부**가 된다.

### 1.7 모범 사례 **[문서]**

- **스펙은 잘게 나눈다** — e-커머스 예시는 5개로 분리(인증/카탈로그/장바구니/결제/관리자).
- **버그 설명은 재현 단계·현재 동작·예상 동작·제약을 다 포함**.
- 흔한 실수: 워크플로 중간 변경 시도 / Unchanged Behavior 누락 / 복잡한 버그를 Feature Spec으로 처리.

### 1.8 채택 판단 기준 **[추론]**

SDD는 선행 투자가 크다. 5분이면 될 일에 문서 3개를 쓰게 된다. Kiro가 Quick Spec이라는 우회로를
둔 이유가 이것이다. 판단 기준은 하나 —

> **틀렸을 때 되돌리는 비용이 문서 작성 비용보다 큰가.**

크면 정규 스펙, 작으면 Quick Spec이나 대화형.

---

## 2. Corral 현황 (v0.1.0)

### 2.1 정체 **[코드]**

`트래커 → 저장소 → 사람 승인 → AI 코딩 에이전트` 파이프라인을 자기 컴퓨터에서 자기 키로
돌리는 오픈소스 오케스트레이터. 내부 도구 Symphony의 후계자.

| 항목 | 값 |
|---|---|
| 버전 | v0.1.0 (게시 완료, **미서명**) |
| 라이선스 | Apache-2.0 |
| 런타임 | Node.js ≥24, pnpm 10.10 |
| 구조 | 루트(헤드리스 코어) + `renderer/`(Svelte) + `desktop/`(Electron) |

### 2.2 5축 어댑터 **[코드: `src/core/types.ts`]**

`kind` 필드(zod discriminated union)로 골라 레지스트리에서 해석.

| 축 | 인터페이스 | 구현 |
|---|---|---|
| Tracker | `TrackerAdapter` | Notion, GitHub Issues, Jira |
| Repository | `RepositoryAdapter` | GitHub, GitLab, Bitbucket |
| Agent | `AgentAdapter` | provider × transport 6셀 |
| Workspace | `WorkspaceAdapter` + `WorkspaceIO` | Docker, Local |
| Channel | `ChannelAdapter` | Web(SSE), Slack |

`WorkspaceIO`가 특히 잘 잡혀 있다 — 오케스트레이터는 자기가 `docker exec`을 쓰는지 로컬 fs를
쓰는지 모른다.

### 2.3 파일 채널 오케스트레이션 ★ **[코드: `WORKFLOW.md`, `src/orchestrator.ts`]**

Corral 설계의 중심. **에이전트는 오케스트레이터와 오직 `.corral/` 디렉터리 파일로만 대화한다.**

```
.corral/pending_plan.md    → 사람에게 승인 요청
.corral/plan_options.json  → 선택지 UI 렌더
.corral/question.md        → 사람에게 질문 전달
.corral/pending_review.md  → 리뷰 결과 표시
.corral/review_status.json → blocker 카운트로 자동 PR 판단
.corral/pr_meta.json       → 이 title/body로 PR 오픈
```

에이전트는 **절대 push하지 않고 PR도 열지 않는다.** 커밋까지만 하고 push·PR·트래커 전이·정리는
오케스트레이터 몫. 권한 경계가 파일 하나로 그어진다.

`WORKFLOW.md`(liquid 템플릿)가 에이전트 지시서이며 브랜치 A~H로 분기한다 — A 계획 / B 계획
피드백 / C 구현 / D 리뷰 통합 / E 리뷰 피드백 / F 리뷰 승인→PR / H 수정계획 승인.

### 2.4 상태 기계 **[코드: `src/core/types.ts:307`]**

`IssuePhase` 11개. 두 집합으로 분류:

- `WAITING_PHASES` — 사람(`*_sent`)이나 외부 이벤트(`pr_open`) 대기. 폴러 디스패치 금지
- `RESUMABLE_PHASES` — `implementing`/`review_fixing`. 재시작이 중간에 끊을 수 있어 복구 시
  자동 재실행이 아니라 **재시도 버튼으로 노출**

상태는 `.corral-state/issues.json`에 저장(워크스페이스 밖이라 cleanup보다 오래 산다).

### 2.5 검증 파이프라인 **[코드: `src/review/`]**

계획과 코드 양쪽에 **동일한 패턴**을 쓴다.

**코드 리뷰** (`review/orchestrator.ts`)
1. **정적 게이트 먼저** — 레포의 `verify` 명령(lint/typecheck)을 워크스페이스에서 실행. 앱 실행 없음
2. **N개 리뷰 라운드 병렬**, 각각 **새 세션**(서로의 결론을 모름)
3. semgrep 병렬
4. 메인 에이전트가 통합해 `pending_review.md` 작성

정적 게이트를 맨 앞에 둔 이유가 주석에 있다 — *"non-zero exit는 LLM 리뷰어가 합리화로 무마할
수 없는 객관적 사실"*. 실패한 명령은 통합에서 무조건 BLOCKER로 접힌다.

**계획 비평** (`review/plan-critique.ts`) — 초안 계획에 독립 비평가를 병렬로 돌리고 통합.
**코드만이 아니라 계획도 리뷰 대상**이라는 게 핵심.

### 2.6 Agent 데코레이터 체인 **[코드: `src/bootstrap.ts:83-123`]**

```
TimingAgent( StageRoutingAgent( FailoverAgent([ GenericAgent(transport), ... ]) ) )
```

- **FailoverAgent** — `rate_limit`/`auth`/`budget`만 전환 트리거. `timeout`/`crashed`는
  일시적이라 같은 에이전트로 재시도, `login_required`는 설정 오류라 그대로 노출
  (*"잘못 설정된 primary를 프로바이더 전환으로 가리지 않는다"*). 쿨다운 후 1순위 복귀.
- **StageRoutingAgent** — 단계별로 다른 프로바이더 배치 가능. **CLI 세션은 한 프로바이더
  소유라 재개 불가** → 프로바이더가 바뀌면 강제로 새 세션을 열고 인수인계는 **파일**로 넘긴다.
- **TimingAgent** — 모든 턴을 계측해 "AI 실작업 시간"을 벽시계와 분리 기록.

`provider(claude|gemini|gpt) × transport(cli|api)` 6셀 전부 구현. api 로드맵 Phase 1~6 완료.

### 2.7 Direction (방향성) **[코드: `src/core/direction.ts`, `docs/direction-injection-plan.md`]**

> 메모에 "미구현"으로 남아 있었으나 **구현 완료**다. Phase 0~5, 7 전부 ✅, Phase 6(옵션 방향 축)만 보류.

- **전역 스코프만.** 프로젝트별 `.corral/DIRECTION.md`는 결정 H로 철회 — 레포에 파일을 수동
  커밋해야 해서 "설정 0" 방향과 안 맞았다.
- 계층: skills = **binding(준수)**, Direction = **guiding(이 방향대로 판단)**.
- 리뷰 심각도까지 보정한다. 속도/MVP 방향이면 cosmetic·gold-plating 강등, 안정성 방향이면 엄격.
  **단 정확성·보안·데이터손실은 절대 강등 금지.**
- 검증층: 방향성 텍스트 자체의 위법·어뷰징·실현불가를 AI로 검사. 해시 기반이라 수정 시 자동
  unverified. 소비 동의(consent) 1회 필요.

### 2.8 읽으면서 관찰된 것 (미수정) **[코드]**

**① `site/version.json`이 전부 `0.0.0`인데 v0.1.0이 게시됐다.**
업데이트 게이트가 이 파일로 강제/권장을 판단하므로 현재 게이트는 사실상 무동작(fail-open이라
무해). 릴리스마다 갱신하는 절차가 아직 안 돌았다.

**② 사용자 대면 문자열이 한글로 하드코딩돼 있다.**
`orchestrator.ts` 13곳, `failover.ts` 3곳. 그런데 `orchestrator.ts` 자기 헤더 주석은
*"UI/status strings in English"*라고 적혀 있고, 개발계획서 §2.1은 i18n 외재화가 원칙이다.

**③ 데이터 필드가 한글 표시 문자열에 결합돼 있다.**
```ts
// src/orchestrator.ts:170
.some((e) => e.label.includes('소진') || e.label.includes('전환') || ...)
```
히스토리의 `failoverUsed`를 이벤트 라벨의 **한글 부분 문자열 매칭**으로 판정한다. 오늘 동작하는
이유는 `failover.ts:74-77`이 정확히 그 단어를 하드코딩하기 때문뿐. ②를 고쳐 라벨을 영어화하거나
i18n으로 옮기는 순간 이 판정이 조용히 항상 false가 된다. **②③은 같이 처리해야 하는 한 덩어리.**

---

## 3. refinery — 소잔 운영AI 워커

경로: `/Users/junghyun/Project/sojan/tilldone-sojan-server/apps/refinery` (소스 9개)

### 3.1 정체와 두 가지 구조적 선택 **[코드: `src/main.ts`]**

크롤로 들어온 거친 축제 데이터를 AI로 **경험유형 태그**로 분류해 DB에 저장한다.

- **왜 batch 안에 안 넣었나** — batch는 Cloud Functions라 **540초 타임아웃**을 받는다.
  452건 AI 처리가 그 안에 안 끝난다. VM에 pm2로 상주하는 워커여야 한다.
- **왜 HTTP 서버가 없나** — 외부에서 부를 일이 없다. Pub/Sub Pull 구독만으로 돌아 포트를 안 연다.
  `NestFactory.create()`가 아니라 `createApplicationContext()`를 쓴다.
  주석: *"열면 공격 표면만 늘어난다(PC8에서 배치 엔드포인트가 무인증 공개였던 전례가 있다)."*

### 3.2 데이터 흐름 **[코드]**

```
[크롤 발견 PD7]  저장 직후 → 'discovered' 발행
[백필 배치 PO1]  태그 없는 축제 조회 → 'backfill' 발행
                            │
                   festival-refine-topic (Pub/Sub)
                            │  동시 1건
                     PubSubListenerService
                            │
                     RefineHandlerService   ← 스킵 판정 4종
                            │
                  ClassifyFestivalOperation ← AI 호출 + 어휘 검증
                            │
                  Festival.category만 $set
```

발행과 처리를 분리한 이유: *"분류 로직을 배치에도 두면 같은 코드가 두 벌이 된다. 프롬프트나
어휘 검증을 고칠 때 한쪽만 고치면 조용히 어긋난다."*

### 3.3 ack / nack 결정 매트릭스 ★ **[코드: `pubsub-listener.service.ts`]**

| 상황 | 처리 | 근거 |
|---|---|---|
| 알 수 없는 메시지 형태 | **ack하고 버림** | 재시도해도 형태가 안 바뀜 |
| AI 일일 상한 초과 | **ack하고 버림** | nack하면 상한 풀릴 때까지 재전송 반복 → dead letter로 밀림. 태그 없는 건 다음 백필에 자연히 재대상 |
| 대상 없음 / 제목 없음 | **던지지 않고 return** | 재시도해도 소용없음 |
| 저신뢰 / 태그 없음 | **던지지 않고 return** | 같은 결과 나옴 |
| 그 외 처리 실패 | **nack** | Pub/Sub 재전송 |

무한 재시도 방어를 코드가 아니라 **dead letter 정책**에 맡겼다 — *"코드로 횟수를 세지 않는
이유: 워커가 재시작되면 카운터가 사라진다."*

### 3.4 메시지에 데이터를 안 싣는다 ★ **[코드: `refine-message.ts`]**

`RefineMessage`는 `festivalId` + `reason` 둘뿐.

> ⚠️ **축제 데이터를 싣지 않는다 — ID만 싣는다.** 큐에서 대기하는 동안 원본이 바뀔 수 있다.
> 크롤 재수집으로 축제 정보가 갱신되면 워커는 낡은 값으로 정제하게 된다. ID만 싣고
> **처리 시점에 읽으면** 항상 최신이다.

`reason`은 로그용이고 처리 분기에 안 쓴다(*"분기가 필요해지면 그때 명시적인 필드를 더한다"*).

### 3.5 두 겹 중복 방어 **[코드]**

Pub/Sub은 at-least-once고 백필도 여러 번 돌 수 있다.

- **1차** — 배치 대상 선정에서 `category.minor` 비어 있는 것만 조회
- **2차(마지막 방어선)** — 핸들러가 `minor.length > 0`이면 AI 호출 전에 스킵

전면 재분류가 필요하면 **강제 플래그가 아니라 대상의 `category`를 비우고 다시 넣는다** —
*"코드에 강제 플래그를 두는 것보다 그쪽이 대상 범위를 명시적으로 만든다."*

### 3.6 AI를 믿지 않는 3중 방어 **[코드: `classify-festival.operation.ts`]**

프롬프트에 규칙을 적어놓고도 코드에서 전부 재검증한다.

1. **통제 어휘 검증** — 반환 key가 태그 캐시에 없으면 버리고 `droppedKeys`에 기록.
   *"실측 위반은 0건이었지만, 프롬프트 준수는 모델을 바꾸면 깨질 수 있는 종류의 보장이다."*
2. **개수 상한** — `MAX_MINOR = 4`로 코드에서도 자름
3. **대분류는 아예 안 물음** — `minor`가 정해지면 `parentByKey`로 **역산**. 물으면
   *"minor는 FRUIT인데 major는 ACTIVITY"* 같은 모순이 나올 여지만 생긴다

어휘를 상수로 굳히지 않고 **매 호출마다 DB 스냅샷으로 프롬프트를 새로 만든다**(F4 원칙 —
정본은 DB). 운영자가 태그를 추가·비활성하면 즉시 반영된다.

### 3.7 실측에서 나온 상수들 **[코드]**

- `MAX_TOKENS = 4096` — 512로는 8건 중 6건이 JSON 중간에서 잘렸다.
  **Gemini 3.x는 사고 토큰이 `maxOutputTokens`를 함께 소진**하기 때문. 응답 JSON은 200자도
  안 되는데 앞의 사고가 예산을 먹는다.
- `MAX_DESCRIPTION = 700` — TourAPI 최대 944자
- `MAX_CONCURRENT_MESSAGES = 1` — rate limit 미상이라 1부터. *"한도를 모르는 채로 병렬로
  던지면 429가 쏟아진다"*
- **주최자유형 분류 제외** — `organizer`/`host`가 933건 전부 빈값이라 넣어봐야 전부 UNKNOWN

### 3.8 임계값을 어느 층에 둘 것인가 ★ **[코드: `classify-festival.types.ts`]**

`ClassifyResult.confidence` 주석이 **자기 층에서 자르지 말라고 명시**한다 —
*"A2가 임의로 0.7 같은 값을 박으면 그 숫자의 근거를 아무도 모른 채 굳는다."*

그래서 오퍼레이션은 `confidence`를 그대로 반환만 하고, `MIN_CONFIDENCE = 0.7`은 상위
핸들러에 있으며 거기엔 근거가 붙어 있다 — *"표본 50건 실측에서 최소 0.9였다(0.9 미만 0건)."*
거의 안 걸리지만 모델 교체 시 엉뚱한 태그가 조용히 저장되는 걸 막는 안전망.

또한 **`category`만 건드리고 `reviewStatus`는 손대지 않는다** — 검수를 AI에 맡기지 않는다.

### 3.9 기대고 있는 공용 층 **[코드: `libs/common/src/ai/`]**

| 모듈 | 역할 |
|---|---|
| `AiCompletionService` | Claude 1차 → Gemini 폴오버. "다른 데서는 될 수 있는 실패"일 때만 넘어감 |
| `AiUsageService` | 일일 **토큰** 상한(20만/2만). 초과 시 `AiBudgetExceededError` |
| `TagCacheService` | 통제 어휘 스냅샷 |
| `SlackService` | `dedupeKey`로 중복 억제된 알림 |

- **상한을 금액이 아니라 토큰으로 건 이유** — *"금액은 단가표에 의존하고 단가는 벤더가 바꾼다
  (Gemini는 아예 모른다). 토큰은 응답이 직접 알려주는 정확한 값."*
- **상한을 DB에 둔 이유** — refinery는 pm2 상주, batch는 Cloud Functions라 실행마다 새 프로세스.
  메모리 카운터는 배치에서 매번 0이 된다.
- **알림 계층 분리** — 폴오버 성공은 정보성(결과 정상), 상한 도달·구독 끊김은 오류 채널.
  상한 초과 시 리스너는 알림을 **안 보낸다**(`AiUsageService`가 경계를 넘는 순간 이미 보냄).

### 3.10 운영 사실 **[코드: `refine-backfill-batch.service.ts`]**

- **초기 452건 백필은 하루에 안 끝난다.** 입력 약 372,900 토큰 vs 일일 상한 200,000.
  **의도된 설계**고 이틀에 나눠 돌린다. 대상 선정이 "태그 비어 있는 축제"라 처리된 건은 자동 제외.
- 백필 배치는 **수동 실행**. 신규 발견은 PD7이 저장 직후 발행하므로 이 배치는 누락분용.

### 3.11 인상 **[추론]**

코드량 대비 **판단 밀도가 매우 높다.** 거의 모든 상수와 분기에 "왜 이 값인가 / 왜 다른 선택을
안 했는가"가 실측 날짜나 사고 전례와 함께 붙어 있고, 이슈 코드로 다른 결정과 상호 참조된다.
처음 보는 사람도 "이 숫자를 왜 못 바꾸는지"를 코드만 읽고 알 수 있다.

**이식 가치가 있는 건 분류 로직이 아니라 그 위의 골격이다** — 폴오버 체인, 토큰 기반 상한,
ack/nack 결정 매트릭스, AI 응답 코드 재검증. 이 넷은 도메인(축제 태그)에 전혀 안 묶여 있다.

---

## 4. SDD를 Corral에 넣으면 — 스펙 파일은 AI 호출에 어떻게 적용되는가 ★

> 이 절이 이번 학습의 핵심 질문이었다.

### 4.1 결론

**스펙 md는 AI 호출 프롬프트에 안 들어간다.** 워크스페이스에 파일로 놓이고 에이전트가 자기
read 도구로 읽는다. 방향성과는 전달 방식이 근본적으로 다르다.

### 4.2 Corral은 지금도 세 가지 전달 방식을 쓰고 있다 **[코드: `src/agent/prompt-builder.ts`]**

`WorkflowContext`를 보면 무엇이 프롬프트에 실리는지 그대로 드러난다.

| 대상 | 필드 | 실제로 전달되는 것 |
|---|---|---|
| 방향성 | `direction?: string` | **본문 전체**가 WORKFLOW.md에 보간됨 |
| skills 저장소 | `reference_path?: string` | **경로만**. 내용은 안 실림 |
| 계획서(`pending_plan.md`) | (없음) | **아무것도 안 실림** |

계획서는 `WorkflowContext`에 필드조차 없다. 대신 `WORKFLOW.md` 브랜치 C가 이렇게만 지시한다:

> First read the approved plan at `.corral/pending_plan.md` and implement exactly that —
> a different agent may have written it, so **rely on the file, not memory of the planning chat.**

### 4.3 왜 스펙은 주입하면 안 되는가 **[추론 — 근거는 각 항목에]**

**① 크기가 다르다.** 방향성은 수백 토큰이고 모든 단계에 똑같이 관련된다. 스펙 3종은 수천~수만
토큰이고 구현 중인 태스크에 따라 필요한 부분이 다르다.

**② 세션이 다르다.** `StageRoutingAgent`는 프로바이더가 바뀌면 **강제로 새 세션**을 연다(CLI
세션은 한 프로바이더 소유). 그래서 인수인계가 애초에 세션 기억이 아니라 파일이어야 한다.

**③ 리뷰 라운드는 워크플로를 안 받는다.** 병렬 리뷰 라운드는 `workflow: ''`로 돌아간다
(방향성 주입이 계획서 Phase 4에서 따로 처리된 이유). 주입 경로에만 의존하면 리뷰어는 스펙을
못 본다. 파일이면 읽으면 된다.

**④ 스펙은 읽기 전용 컨텍스트가 아니라 상태를 가진 산출물이다.** `tasks.md`는 에이전트가 작업을
끝낼 때마다 갱신해야 하고 오케스트레이터는 그 파일을 읽어 진행률을 안다.
**주입은 단방향이라 애초에 불가능하다.**

정리:

```
방향성   → 작다 · 항상 동일 · 읽기 전용        → 프롬프트 주입
skills   → 크다 · 항상 동일 · 읽기 전용        → 경로만 주입, 에이전트가 탐색
스펙     → 크다 · 단계마다 다름 · 읽고 쓴다    → 파일 핸드오프
```

### 4.4 `pending_plan.md`가 이미 스펙이다 **[추론]**

Corral은 축소판 SDD를 이미 돌리고 있다. 지금은 **requirements + design + tasks가 한 문서에
뭉쳐** 있을 뿐이다. `WORKFLOW.md` 브랜치 A가 요구하는 내용 — 바꿀 레포와 이유, 접근, 바꿀
파일 목록, 엣지 케이스, **테스트 가능한 수용 기준** — 은 Kiro의 3문서를 합쳐놓은 형태다.

**SDD를 넣는다는 건 새 메커니즘을 만드는 게 아니라 이 문서를 쪼개는 것이다.**

### 4.5 쪼개면 무엇이 바뀌나 **[추론]**

| 지금 | SDD 적용 후 |
|---|---|
| `.corral/pending_plan.md` 1개 | `.corral/spec/requirements.md` · `design.md` · `tasks.md` |
| 브랜치 A(계획) 1단계 | A1(요구사항) → A2(설계) → A3(태스크) |
| 사람 게이트 1개 | 최대 3개 |
| plan-critique가 계획 전체 비평 | **요구사항 단계로 이동** — Kiro의 Analyze Requirements 자리 |
| 리뷰가 diff를 자유 판단 | **EARS 수용 기준 대조** — 정적 게이트와 같은 결정론 층 추가 |
| — | `tasks.md`가 상태 파일이 되어 진행률·의존성 판독 가능 |

마지막 줄이 실질적으로 제일 크다. 지금 corral은 `implementing` 내부가 블랙박스다
(`RESUMABLE_PHASES`에 넣고 재시도 버튼만 띄우는 이유). `tasks.md`가 있으면 재개도 처음부터가
아니라 남은 태스크부터 가능해진다.

**주입 방식은 하나도 안 바뀐다.** `WORKFLOW.md`의 지시문이 "`pending_plan.md`를 읽어라"에서
"`spec/tasks.md`에서 다음 미완료 태스크를 읽고, 그 태스크가 참조하는 요구사항 ID를
`requirements.md`에서 확인하라"로 바뀔 뿐이다.

### 4.6 세 층의 우선순위 **[코드: `WORKFLOW.md:32-49`]**

```
skills/conventions   binding   — 규칙. 어겨도 되는 게 아님
       ↓
스펙(이 이슈)         계약     — 이번 작업이 만족해야 할 것
       ↓
방향성               guiding   — 위 둘이 중립일 때의 기본 방향
```

방향성이 스펙의 수용 기준을 못 뒤집는다. 이미 같은 원칙이 리뷰 심각도 보정에 박혀 있다 —
*"never downgrade a correctness, security, data-loss, or broken-behavior finding on account
of the direction."*

---

## 5. 운영AI를 Corral에 올리기 (방향 B)

> **확정된 방향**: corral이 운영AI를 **실행/호스팅**한다. 실행 중인 호출 모니터링, 이력 조회,
> 운영AI 설정을 corral에서 한다. 비즈니스 로직 흐름 중 AI가 필요한 지점에 운영AI를 추가할 수 있게.

### 5.1 개념도가 그은 경계 **[개념도 + 추론]**

```
① 원천 데이터 ──큐·API 알림──▶ ② 운영 AI ──▶ ③ 판단 ──▶ ④ 비즈니스 로직 A/B/C
  크롤링→DB등록              정제·분류/태깅   어떤 로직인가    (이미 정의된 것)
                                  │
                            확신 낮으면
                                  ▼
                             사람 검수
```

주황(운영AI)은 ②뿐이고 ③ 판단은 검정 다이아몬드 = **코드 분기**. 현재 코드는 1~2까지 실동,
3~4는 확장 설계.

**corral은 비즈니스 로직을 실행하지 않는다.** ①③④는 소잔 서버 소유고 corral이 가져가는 건
②(그리고 나중에 A/B/C 안쪽에 생길 AI 지점들)뿐이다.

→ corral의 운영AI 쪽은 **워크플로 엔진이 아니라 "어디서든 부를 수 있는 AI 오퍼레이션 런타임
+ 관제탑"**이다.

### 5.2 경계선 **[추론]**

| corral이 가져갈 것 | 소잔에 남을 것 |
|---|---|
| 오퍼레이션 정의(프롬프트 조립 + 출력 스키마) | 대상 선정(백필 배치 쿼리) |
| 프로바이더 폴오버 | 큐 발행 / 호출 시점 결정 |
| 토큰 상한·비용 집계 | 결과 저장 |
| 응답 검증(어휘 밖 버리기·상한·역산) | 판단③ · 비즈니스 로직④ |
| 실행 로그·이력·설정 UI | 통제 어휘의 **정본**(DB) |
| 재시도/ack·nack 정책 | 도메인 스키마 전체 |

### 5.3 바로 걸리는 것 셋 **[추론]**

**① 통제 어휘를 누가 읽는가.** 현재 오퍼레이션은 매 호출마다 소잔 DB에서 태그 스냅샷을 읽는다.
corral이 실행하려면 corral이 소잔 DB에 붙어야 하고, 그 순간 provider-neutral 성격이 깨진다.
→ 대안: 호출자가 어휘를 요청에 실어 보내고 corral은 "이 목록 밖 key는 버려라"는 규칙만 안다.

**② 결과를 누가 저장하는가.** corral이 도메인 DB를 안 만지면 결과를 돌려주기만 하고 저장은
소잔이 한다. 호출 모델이 통째로 바뀐다(§5.6).
※ refinery가 HTTP 서버를 일부러 안 연 이유(PC8 전례)를 다시 검토해야 한다.

**③ 관측·이력 규모가 두 자릿수 다르다.**

| | 개발AI | 운영AI |
|---|---|---|
| 하루 건수 | 몇 건 | 수백~수천 |
| 건당 수명 | 수십 분~시간 | 초 |
| 이력 저장 | JSONL 파일 | ? |

corral의 관측 층은 전부 **이슈 단위**로 묶여 있다(`bus.recent(identifier)`, `IssueRuntime`,
`JsonlHistoryStore`, `CostTracker` 모두 `identifier`가 키). 운영AI는 **오퍼레이션 실행**이
단위다. refinery는 이미 `AiUsageLog`/`AiUsageDaily`를 MongoDB에 쓴다. 일 수천 건을 JSONL로
쌓으면 조회가 안 된다 → **저장소 결정 필요.**

### 5.4 corral에 이미 있는 것 vs 새로 필요한 것 **[코드 + 추론]**

| 필요한 것 | 현황 |
|---|---|
| 프로바이더 폴오버 | ✅ `FailoverAgent` — 트리거 조건·쿨다운 복귀까지 동일 |
| 예산 상한 | ⚠️ `maxBudgetUsd` 있으나 **USD 기준**. 토큰 축 추가 필요 |
| 실시간 진행 표시 | ✅ `bus` + SSE (단위만 이슈→실행으로) |
| 비용 집계 | ✅ `CostTracker` + `pricing.ts` |
| 알림 | ⚠️ 채널은 있으나 `dedupeKey` 중복 억제·정보성/오류 분리 없음 |
| 이력 | ⚠️ JSONL — 볼륨 재검토 |
| 오퍼레이션 레지스트리 | ❌ 신규 |
| 수신 경로(호출 받기) | ❌ 신규 |
| 사람 검수 UI | ⚠️ `ApprovalKind`는 개발 흐름용뿐. 도메인 데이터 렌더링 방법 없음 |

### 5.5 ⚠️ 방향성 주입을 타면 안 된다 **[추론 — 근거 아래]**

corral은 방향성을 `WORKFLOW.md` 렌더링 경로로 **모든 호출에** 주입한다. 운영AI가 그 경로를
타면 축제 분류 한 건마다 방향성 본문이 실린다.

- **비용** — refinery의 상한 설계는 "하루 1.5만 토큰" 실측 기준이다. 호출마다 수백 토큰이
  붙으면 452건 백필 입력 추정(372,900)이 어긋난다.
- **정확도** — 축제를 어떤 태그로 분류할지는 회사의 속도/안정성 방향과 무관하다. 편향만 생긴다.

→ **운영AI는 방향성·워크플로 주입을 타지 않는 별도 호출 경로여야 한다.**

### 5.6 "저장된 데이터를 운영AI가 읽어야 한다"의 일반화 ★

> 사용자 확인 사항: **어떤 방식이 되었건 운영AI가 저장된 데이터를 읽어야 한다.**
> 그 일반화 방법은 **미결(더 고민 필요)**.

**이 제약이 탈락시키는 것** — "호출자가 미리 좁혀서 실어 보내기"는 여기서 탈락한다.
§3.4의 설계 근거(ID만 싣고 처리 시점에 읽기)가 그대로 깨지기 때문이다. 남는 건 **처리 시점에
corral이 읽는다** 두 가지뿐: DB 직접 읽기 / 호출자 API 되불러 읽기.

**일반화의 실마리는 이미 refinery 안에 있다** — `ClassifyInput`.

```ts
/** 분류에 넣는 재료. DB 문서가 아니라 이 형태로 좁혀서 넘긴다
 *  — 프롬프트에 뭐가 들어가는지 한눈에 보인다. */
export interface ClassifyInput {
  title: string; description?: string; keywords?: string[]; address?: string;
}
```

**오퍼레이션은 `Festival` 문서를 본 적이 없다.** 납작한 4개 필드만 본다. 도메인과 AI 사이에
이미 얇은 막이 있고 **그 막이 일반화 지점**이다. 질문이 "corral이 도메인을 어떻게 아느냐"에서
**"이 좁히기 규칙을 어디에 어떻게 적느냐"**로 바뀐다.

**corral에 이미 같은 모양의 선례가 있다** — 트래커 config.

```yaml
tracker:
  kind: notion
  properties: { status: "Status", identifier: "ID", repo: "Repo" }
```

corral은 Notion API는 알지만 사용자 스키마는 모른다. 사용자가 매핑을 선언하고 어댑터가 그
매핑으로 읽는다. 운영AI 입력도 같은 모양이 가능하다.

**refinery를 선언으로 옮겨보면** (스케치):

```yaml
operations:
  - key: classify-festival
    input:
      select:
        title:       "basicInfo.title"
        description: "basicInfo.description"    # truncate: 700
        keywords:    "basicInfo.tags"
        address:     "location.address"
      require: [title]                          # 없으면 스킵
      skip_if:  "category.minor 비어있지 않음"    # 중복 호출 방어
    vocabulary: { key: "key", label: "label", parent: "parentKey" }
    output:
      schema: { minor: string[], confidence: number }
      validate: { in_vocabulary: minor, max_items: 4, min_confidence: 0.7 }
      derive:   { major: "parent_of(minor) 중복제거" }
    write: { "category.major": major, "category.minor": minor }
```

**발견**: `classify-festival.operation.ts` 126줄 중 도메인 고유는 사실상 프롬프트 문장뿐이다.
나머지(어휘 재검증·개수 상한·대분류 역산·신뢰도 컷·중복 방어·필드 좁히기)는 전부 선언 가능하다.

**선언형이 깨지는 지점 [추론]** — 두 번째, 세 번째 오퍼레이션이 붙으면 선언으로 안 되는 게
나온다(개념도의 ③④가 이미 확장 설계로 남아 있다). 갈래는 둘:

- 선언 문법을 계속 늘린다 → 결국 프로그래밍 언어를 재발명
- **선언으로 못 하는 것은 기능으로 채운다** → 사용자가 코드를 넣어 단계를 갈아끼우는 길은 두지 않는다

corral은 후자의 골격을 이미 갖고 있다(`Registry` 패턴 + `@corral/sdk` 노출 계획, 5축이 전부
"인터페이스 + 레퍼런스 1~2종" 구조). **선언형으로 가되, 선언으로 안 되는 것이 나오면 그때
스키마를 넓히거나 어댑터를 추가**하는 쪽을 권한다.

**pull vs fetch-back 비교** (고민 재료):

| | **DB 직결 (pull)** | **호출자 API 되부르기 (fetch-back)** |
|---|---|---|
| corral이 아는 것 | 저장소 종류 + 경로 매핑 | HTTP 엔드포인트 하나 |
| 최신성 | ✅ 처리 시점 | ✅ 처리 시점 |
| 좁히기 주체 | corral (선언대로) | 소잔 (엔드포인트가 좁혀서 응답) |
| 소잔이 할 일 | 없음 | 내부 엔드포인트 1개 추가 |
| 도메인 결합 | 중 — 스키마 경로를 앎 | 낮음 — JSON만 앎 |
| 자격증명 | 소잔 DB 접속 정보 | 내부 API 토큰 |
| 쓰기 | corral이 `$set` | 소잔이 저장 (또는 콜백) |
| 타 프로젝트 확장 | 저장소마다 어댑터 | 규약만 맞추면 무엇이든 |

**잠정 의견 [추론]**: fetch-back이 corral 성격에 더 맞다. 남의 DB 스키마와 접속정보를 쥐는
순간 "내 컴퓨터에서 내 키로 도는 도구" 성격이 흐려지고 저장소마다 어댑터가 는다. fetch-back은
소잔에 엔드포인트 하나만 늘리면 되고 그 엔드포인트가 곧 `ClassifyInput` 좁히기를 담당하니
**이미 있는 막을 그대로 쓰는 것**이 된다. 단, 다른 프로젝트를 붙일 때 "엔드포인트를 만들어야
corral을 쓸 수 있다"는 진입 장벽은 남는다.

### 5.7 지금 정할 것 / 미룰 것 **[추론]**

**미뤄도 되는 것 — pull이냐 fetch-back이냐.** 둘 다 *"실행 시점에 입력을 해석해 납작한 객체를
만든다"*는 하나의 추상 뒤에 숨는다.

```ts
interface InputResolver {
  resolve(ref: { id: string }, spec: InputSpec): Promise<Record<string, unknown>>
}
```

이 인터페이스만 세워두면 mongodb 구현과 http 구현을 나중에 갈아끼울 수 있다. corral
개발계획서 §1.3의 방법론과 같다 — *"S1에선 인터페이스만, 코어 로직은 S2에서 한 번에 lift.
같은 코드를 두 번 포팅하는 게 핵심 낭비."*

**지금 정해야 하는 것 — 오퍼레이션 정의를 "선언"으로 표현할 것인가 "코드"로 표현할 것인가.**
설정 UI의 모양, 이력에 남길 항목, 검증 층의 위치가 전부 여기서 갈린다. **선언으로 간다면**
선언으로 안 되는 것이 나올 때마다 스키마를 넓히거나 어댑터를 추가하는 것이 유일한 길이 되므로,
그 확장이 쉬운 모양(축·레지스트리)을 처음부터 잡아야 한다.

**검수 위치는 아무것도 막지 않는다.** 저신뢰 판정은 이미 오퍼레이션 안에서 나오고
(`confidence < MIN`), corral은 그걸 이력에 남기기만 하면 된다.

### 5.8 SDD와 운영AI의 관계 **[추론]**

- **운영AI 실행에는 SDD 스펙이 안 붙는다.** 매 호출에 스펙 md를 넣는 건 성립하지 않는다.
- 운영AI의 스펙 역할은 **오퍼레이션 정의**가 한다 — 프롬프트 + 출력 스키마 + 통제 어휘 +
  상한 + 신뢰도 임계값. 문서 주입이 아니라 **코드/설정으로 강제**된다.
- **그 오퍼레이션을 만드는 일 자체는 개발AI의 SDD 대상이다.** `requirements.md`에 EARS로:

```
WHEN 분류 결과의 key가 요청에 실린 통제 어휘에 없으면
THE SYSTEM SHALL 그 key를 버리고 droppedKeys에 기록한다

WHEN confidence가 임계값 미만이면
THE SYSTEM SHALL 결과를 저장하지 않고 WARN으로 남긴다
```

그대로 오퍼레이션 정의이자 검증 코드이자 property-based test의 속성이 된다.

> **루프가 닫힌다**: corral의 개발AI가 SDD로 운영AI 오퍼레이션을 만들고 → 그 산출물이 corral의
> 운영AI 런타임에 등록되어 돌고 → 실행 이력이 다시 corral 대시보드에 쌓인다.

---

## 6. 미결 사항

| # | 항목 | 상태 |
|---|---|---|
| 1 | 오퍼레이션 정의: 선언 vs 코드 vs 둘 다 | **지금 정해야 함** (§5.7) |
| 2 | 입력 읽기: pull(DB 직결) vs fetch-back(API) | 미결 — 인터페이스로 미룰 수 있음 (§5.6) |
| 3 | 사람 검수 위치: 소잔 admin vs corral 대시보드 | 미결 — 아무것도 막지 않음 |
| 4 | 운영AI 이력 저장소: JSONL vs DB | 미결 — 볼륨상 재검토 필요 (§5.3) |
| 5 | 예산 상한 축: USD만 vs 토큰 추가 | 미결 (§5.4) |
| 6 | SDD 도입 범위: 전면 vs Quick Spec 병행 | 미검토 |
| 7 | 두 번째 운영AI 오퍼레이션 후보 | **미정 — 선언형 한계 검증에 필요** (§5.6) |

**다음 검증 방법 [추론]**: 두 번째 운영AI 후보를 하나 정해 §5.6의 선언 스케치로 같이 적어보는
것이 선언형이 어디까지 버티는지 확인하는 가장 빠른 길이다.

---

## 7. 출처

**Kiro 공식 문서**
- [kiro.dev](https://kiro.dev/) · [Docs](https://kiro.dev/docs/) · [Pricing](https://kiro.dev/pricing/)
- [Specs](https://kiro.dev/docs/specs/) · [Feature Specs](https://kiro.dev/docs/specs/feature-specs/) ·
  [Quick Spec](https://kiro.dev/docs/specs/quick-spec/) ·
  [Analyze Requirements](https://kiro.dev/docs/specs/analyze-requirements/) ·
  [Bugfix Specs](https://kiro.dev/docs/specs/bugfix-specs/) ·
  [Best Practices](https://kiro.dev/docs/specs/best-practices/)
- [Steering](https://kiro.dev/docs/steering/) · [Hooks](https://kiro.dev/docs/hooks/) · [CLI](https://kiro.dev/docs/cli/)

**EARS 배경** — [TeachMeIDEA](https://teachmeidea.com/kiro-ai-ide-spec-driven-development/) ·
[Medium](https://medium.com/@biagolini/what-is-spec-driven-development-and-how-to-implement-it-with-kiro-b5846bd55869)

**저장소** — `/Users/junghyun/Project/corral` (v0.1.0, main) ·
`/Users/junghyun/Project/sojan/tilldone-sojan-server/apps/refinery`

**개념도** — `/Users/junghyun/Downloads/소잔_운영AI_개념도.pdf`
