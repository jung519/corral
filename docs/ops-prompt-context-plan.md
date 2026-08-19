# 작업계획서 — 프롬프트에 쓸 재료를 정의에서 공급한다

> 성격: **작업계획서**. `ops-prompt-context.md`의 분석 위에 서고, 그 문서가 열어둔 4문항을
> §1에서 닫는다.
> 관련: `ops-prompt-context.md`(문제 분석) · `operational-ai-design.md`(D6·D7·D9, §5.1~5.2)
> 기준 커밋: `327137c` (develop). 아래 파일·줄 번호는 그 시점의 것이다.

---

## 0. 한 줄로

**허용값 목록은 이미 조회·캐시되는데 채점에만 쓰인다.** 모델에게 보기를 주지 않은 채 채점하니
답이 전부 버려지고, 그런데도 실행은 `completed`로 끝난다. 재료를 프롬프트로 보내는 길을 만들고,
그 전에 **버려도 성공으로 끝나는 것부터** 막는다.

---

## 1. 확정 (분석 문서 §6의 4문항 + 추가 1건)

> ⚠️ 아래는 검토에서 나온 권고를 그대로 확정한 것이다. 뒤집을 것이 있으면 착수 전에 말해야
> 한다 — D1은 스키마 모양을, D5는 착수 순서를 바꾼다.

| # | 결정 | 근거 |
|---|---|---|
| **D1** | **안 B — `agent.context` 자리를 신설**하고, `validate.allowed_values`가 그 이름을 참조하게 한다 | `validate`에 `as:`를 두면(안 A) 검증 블록이 데이터 공급 수단이 되어 이름이 하는 일을 설명하지 못한다. `context`는 허용값 말고 기준표·분류 지침도 같은 자리에 들어간다. 이름 참조로 URL 중복도 사라진다 |
| **D2** | **조회 실패 시 모델 호출 전에 막는다** | 목록 없이 물으면 답이 전부 버려져 토큰만 쓴다. 호출 전에 막으면 토큰도 안 쓴다. `rules.ts:68`이 이미 "목록 없이는 판단 불가 → 거부" 판례를 세웠다 |
| **D3** | **목록은 원문 그대로 넣는다.** 사람이 읽는 형태로 다듬는 기능은 두지 않는다 | 다듬기는 어휘의 구조(부모·key·라벨)를 아는 쪽만 할 수 있고, corral은 도메인을 모른다. refinery가 그것을 하는 것은 도메인을 알기 때문이다(§5.1 참조). corral 쪽에서 다듬어야 하면 조회 API가 하면 되고, `select`가 이미 그 경로다. `schemaInstruction`이 JSON Schema를 통째로 넣는 것도 같은 선례다 |
| **D4** | **`prompt.system`은 계속 치환하지 않는다.** 재료는 `user_template`에만 | 분석 문서는 "규칙은 system, 재료는 user" 구분을 이유로 들었으나 더 실질적인 이유가 있다 — `system`을 치환하면 **이벤트에서 온 문자열이 시스템 메시지로 들어간다.** 프롬프트 인젝션 표면을 system 역할로 승격시키는 것이고, CRL-43이 방금 정리한 문제와 같은 종류다 |
| **D5** | **"전부 버려지면 `completed`로 끝내지 않는다"를 먼저, 따로 낸다** | 분석 문서가 다루지 않은 선택지다. 문제는 둘로 쪼개진다 — (a) 모델이 목록을 모른다, (b) 전부 버려져도 성공으로 끝난다. (b)는 (a)와 **독립적으로** 고칠 수 있고, D1의 결정을 기다리지 않는다 |

### D5의 근거를 따로 적어둔다

`rules.ts:50-56`이 `isComparable` 실패에 대해 이미 이렇게 거부한다.

> which would empty the field and report success: the pipeline would go on publishing
> nothing, forever, as a completed run

이 문장이 all-dropped 케이스에 한 글자도 안 바꾸고 적용되는데, 거기엔 걸려 있지 않다.
실측으로 확인했다.

```
입력: labels = ["plausible", "other"],  allowed_values = [ALPHA, BETA]
결과: {"ok":true,"answer":{"labels":[]},"dropped":["labels: plausible","labels: other"]}
→ run.ts:340 이 completed 로 끝낸다
```

CRL-33이 세운 원칙("일할 수 없는 규칙은 조용히 통과시키지 않는다")의 미적용 구멍이다.

---

## 2. 목표 모양

```yaml
agent:
  context:                                   # ← 신설. 프롬프트에 넣을 재료의 공급원
    allowed:
      source: { url: "https://<host>/api/vocabulary" }
      select: "data.values"
  prompt:
    user_template: |
      다음 key 중에서만 고른다: {{allowed}}
      대상: {{title}}
  schema: { ... }
  validate:
    allowed_values:
      field: labels
      from: allowed                          # ← 신설. context 이름 참조. URL을 두 번 적지 않는다
```

`values`(인라인)·`source`(조회)·`from`(context 참조) 셋 중 하나를 고른다.

### 실행 순서

```
트리거 → 입력 조회 → skip_if / require → [context 조회] → 모델 1턴 → 채점 → 출력
                                          ↑ 신설
```

`context`는 `fields`에 병합된다. **그래서 프롬프트 조립 코드는 손대지 않는다** — `one-turn.ts`와
`cli-turn.ts`가 둘 다 `fillTemplate(user_template, fields)`를 쓰므로 API·CLI 두 경로가 함께
동작한다. 한쪽만 고쳐질 위험이 구조적으로 없다.

---

## 3. 지금 구조와의 갭

| 사실 | 위치 | 갭 |
|---|---|---|
| 어휘 캐시가 `RuleAnswerValidator` 인스턴스 안에 있다 | `rules.ts:32` | 러너가 접근할 경로가 없다(`grep` 0건) |
| 그 인스턴스는 `validator` 슬롯에만 들어간다 | `ops-host.ts:131` | 공유하려면 배선을 바꿔야 한다 |
| 조회가 **조건부**다 — 답에 그 필드가 있을 때만 부른다 | `rules.ts:50` | "이미 매 실행 조회된다"는 전제가 사실이 아니다 |
| 조회는 답이 온 **뒤**에 일어난다 | `rules.ts:64` (유일한 호출 지점) | 프롬프트는 그 **앞**이다 |
| `fields`는 이벤트 + 입력 결과뿐 | `run.ts:236` | 넣을 자리가 없다 |
| `AnswerValidator.check(step, answer)` | `ports.ts` | 해석된 context를 받을 인자가 없다 |
| `RunStage`에 `'context'`가 없다 | `run.ts:40` | 어느 단계에서 멈췄는지 말할 수 없다 |

---

## 4. 작업

### S1 — 전부 버려지면 성공으로 끝내지 않는다 (D5) · 독립

| # | 작업 | 파일 | 규모 |
|---|---|---|---|
| T1 | `allowed_values` 필터 뒤, 남은 값이 없고 버린 값이 있으면 `ok:false` | `src/ops/validate/rules.ts` | **S** |
| T2 | 테스트 3종 — 전부 버림 / 일부 버림 / 원래 빈 답 | `rules.test.ts` | S |

**경계선이 중요하다.** "전부 버렸다"와 "모델이 빈 배열을 답했다"는 다르다. 후자는 프롬프트가
허용한 답(*"근거가 없으면 억지로 채우지 말고 빈 배열"*)이므로 통과해야 한다. 판정은
`남은 값 없음 && 버린 값 있음`이다.

스칼라 필드도 같다 — `result[field] = kept[0] ?? null`이므로 하나뿐인 값이 버려지면 `null`이
되고 `dropped`가 1이다.

- **수용 기준**
  - 허용값 밖의 값만 답한 실행이 `completed`로 끝나지 않는다
  - 일부만 버려진 실행은 계속 `completed`이고 `dropped`에 기록된다
  - 모델이 빈 배열을 답한 실행은 계속 `completed`다
  - 큐 트리거는 이 실행을 **ack한다** — `rejected`가 `SETTLED`에 있기 때문이다. 그대로 둘지는 §6 미결 1

### S2 — context 조회 층

| # | 작업 | 파일 | 규모 |
|---|---|---|---|
| T3 | `ContextSourceSchema` + `agent.context` 필드 | `pipeline/schema.ts` | S |
| T4 | 어휘 조회·캐시를 `RuleAnswerValidator`에서 떼어내 공용 클래스로 | 신규 `ops/context/store.ts` | M |
| T5 | `ContextResolver` 포트 | `pipeline/ports.ts` | S |
| T6 | `run.ts`에 단계 삽입 — `require` 통과 뒤, 예산 확인 **앞** | `pipeline/run.ts` | M |
| T7 | `RunStage`에 `'context'` 추가 | `pipeline/run.ts` | S |
| T8 | `ops-host.ts`에서 store 하나를 resolver와 validator **양쪽에** 넘긴다 | `ops-host.ts` | S |

**T4가 이 단계의 본체다.** `runHttpRequest` + `readPath` + TTL 캐시는 이미 `rules.ts:116-131`에
있으므로 옮기는 작업이다. 다만 캐시 키가 `method url#select`이므로 그대로 쓸 수 있다.

**T6의 위치를 지정한다.** `require` 검사 뒤여야 하고(대상이 없으면 목록도 필요 없다) 예산 확인
앞이어야 한다(목록 조회는 토큰을 쓰지 않으므로 상한과 무관하다). 즉 `run.ts:250` 근처다.

- **수용 기준**
  - `context`에 선언한 이름이 `user_template`의 `{{이름}}`으로 치환된다
  - 같은 URL을 5분 안에 여러 실행이 쓰면 HTTP 호출은 한 번이다
  - API 경로와 CLI 경로가 같게 동작한다(프롬프트 조립을 고치지 않았으므로 자동)
  - `context`가 없는 기존 파이프라인의 동작이 바뀌지 않는다

### S3 — 조회 실패를 모델 호출 전에 막는다 (D2)

| # | 작업 | 파일 | 규모 |
|---|---|---|---|
| T9 | 조회 실패 시 `stage: 'context'`로 실행을 끝낸다 | `pipeline/run.ts` | S |
| T10 | 테스트 — 목록 API가 500일 때 모델이 호출되지 않는다 | `run.test.ts` | S |

**결과 코드는 `input_failed`를 재사용한다.** 새 outcome을 만들지 않는 이유는 큐 의미론이다 —
`input_failed`는 `SETTLED`에 없어 nack되고, 목록 API 장애는 정확히 "잠시 뒤 다시 하면 될 일"이다.
새 코드를 만들면 `SETTLED`·`FAILURE_OUTCOMES`·대시보드 라벨 세 곳을 함께 고쳐야 한다.
어느 단계였는지는 `stage: 'context'`와 `reason`이 말한다.

- **수용 기준**
  - 목록 조회가 실패한 실행에서 모델이 호출되지 않는다(토큰 0)
  - 이력에 `stage: 'context'`와 실패 이유가 남는다
  - 큐 트리거가 그 메시지를 nack한다

### S4 — `validate`가 `context`를 참조한다 (D1의 중복 제거)

| # | 작업 | 파일 | 규모 |
|---|---|---|---|
| T11 | `allowed_values.from` 추가 — `values`·`source`와 배타 | `pipeline/schema.ts` | S |
| T12 | `superRefine` — `from`이 선언된 `context` 이름이어야 한다 | `pipeline/schema.ts` | S |
| T13 | `AnswerValidator.check`에 해석된 context를 넘긴다 | `pipeline/ports.ts`, `rules.ts`, `run.ts` | M |

**T12에 선례가 있다.** `schema.ts:246-259`가 `validate.*.field`를 `schema.properties`에 대해
검사하며 *"is not declared in the answer schema, so this rule would never see a value"*라고
말한다. `from`도 같은 모양이다 — 없는 이름을 가리키면 불러올 때 거부한다.

**T13이 포트를 바꾼다.** `check(step, answer)` → `check(step, answer, context)`. `from`을 쓰지
않는 파이프라인은 세 번째 인자를 읽지 않으므로 기존 동작은 그대로다.

- **수용 기준**
  - `from`으로 참조한 목록이 채점에 쓰이고, URL은 정의에 한 번만 적힌다
  - 선언되지 않은 이름을 `from`에 적으면 불러올 때 어느 파일·어느 경로인지와 함께 거부된다
  - `values`·`source`·`from`을 둘 이상 적으면 거부된다
  - 프롬프트에 쓰인 목록과 채점에 쓰인 목록이 **같은 조회 결과**다(캐시 공유)

### S5 — 편집기

| # | 작업 | 파일 | 규모 |
|---|---|---|---|
| T14 | 3단계(AI 작업)에 `context` 블록 — 이름·URL·select, 행 추가/삭제 | `PipelineEditor.svelte:679` 부근 | M |
| T15 | 허용값 탭에 "context 참조"를 세 번째로 | `PipelineEditor.svelte:705` 부근 | S |
| T16 | 조회 시험을 `context`에도 — `opsTestFetch`를 그대로 재사용 | `PipelineEditor.svelte` | S |
| T17 | i18n 문구(ko/en) | `lib/i18n.svelte.ts` | S |

**T16이 값싸다.** `opsTestFetch`가 이미 `request` + `select`를 받아 원문과 뽑은 값을 돌려주고,
CRL-53에서 `missing`·`selectError`까지 붙었다. `context`의 공급원이 같은 `HttpRequestSchema`이므로
버튼만 하나 더 놓으면 된다.

**T14의 자리.** 설계서 §4.2의 3단계는 이미 "프로바이더·모델 / max_tokens / 프롬프트 / 답 형식 /
답 검사"로 다섯 블록이다. `context`는 **프롬프트 블록 바로 위**에 둔다 — 재료를 먼저 선언하고
그것을 쓰는 문장을 아래에 쓰는 순서가 읽기 순서와 같다.

- **수용 기준**
  - 편집기만으로 `context`를 선언하고 `{{이름}}`으로 쓰는 파이프라인을 만들 수 있다
  - 저장 전에 목록 조회를 시험해 원문과 뽑힌 값을 볼 수 있다
  - 허용값을 context 참조로 고르면 URL 입력란이 사라진다

### S6 — 문서

| # | 작업 | 파일 |
|---|---|---|
| T18 | 설계서 §5.1 스키마 예시에 `context`·`from` 반영 | `operational-ai-design.md` |
| T19 | ~~§5.3 "선언으로 안 되는 것" 표에서 이 항목을 지운다~~ **해당 없음** — 확인해보니 그 표에 이 항목이 애초에 없었다. 문제는 표가 아니라 `ops-prompt-context.md`로 분리돼 있었다. 표에 남은 다섯 한계는 전부 여전히 사실이다 | — |
| T20 | `ops-prompt-context.md`를 "결정됨"으로 전환하고 이 문서를 가리킨다 | `ops-prompt-context.md` |
| T21 | 결정 표에 D25~D29로 §1의 다섯 결정을 올린다 | `operational-ai-design.md` |

**T19는 할 일이 없었다.** 설계서 §5.3이 선언형의 한계를 표로 적어뒀으니 이 작업이 그중
하나를 없앨 것이라 봤는데, 확인해보니 "목록이 프롬프트에 안 간다"는 항목은 그 표에 없었다.
그 문제는 처음부터 별도 문서로 분리돼 있었다. 표의 다섯 한계는 전부 여전히 사실이다.

계획을 세울 때 확인하지 않고 추정한 자리다 — CRL-57(설계서에 뒤집힌 결정이 남음)을 겪고
나서 "표도 손봐야 할 것"이라고 짚었는데, 그 표를 열어보지 않았다.

---

## 5. 비용과 위험

| 항목 | 크기 | 완화 |
|---|---|---|
| ~~프롬프트 토큰 증가~~ **비용이 아니라 격차 해소다** | refinery는 **이미** 어휘를 프롬프트에 넣고 있고(`classify-festival.operation.ts`), 그 상태의 실측이 **분류 1건 약 800토큰**이다(`tag-sweep-batch.service.ts`). corral이 지금 그것을 안 넣는 것이 정상 상태가 아니다 | 없음. 기준선을 corral의 현재 동작으로 잡은 것이 오류였다 — §6-3 참조 |
| **조회가 조건부에서 상시로** | 지금은 답에 필드가 있을 때만. 앞당기면 매 실행 | TTL 5분이 이미 있어 실질 호출은 파이프라인당 12회/시간 |
| **목록 API 장애 = 파이프라인 정지** | D2의 의도된 결과 | 큐는 nack이라 유실 없음. **스케줄은 그 틱을 잃는다** — 다음 틱에 다시 시도 |
| **포트 2개 변경**(`AnswerValidator`, `ContextResolver` 신설) | 호출자가 각 1곳 | `ops-host.ts` 한 파일에서 배선 |
| **`context` 이름과 입력 필드 이름 충돌** | `fields`에 병합하므로 같은 이름이면 하나가 덮인다 | 병합 순서를 정해 문서화한다 — §6 미결 2 |

---

## 6. 미결

| # | 항목 | 비고 |
|---|---|---|
| 1 | **S1의 결과 코드** — `rejected`는 `SETTLED`에 있어 큐가 **ack**한다. 전부 버려진 건을 버릴 것인가 | `rejected`의 뜻이 "답이 규칙을 어겼다 = 재시도해도 같다"이므로 ack이 일관되긴 하다. 다만 원인이 프롬프트라면 고친 뒤 재처리하고 싶을 것이다 |
| 2 | **이름 충돌 규칙** — `input.select`의 이름과 `context`의 이름이 같을 때 | `run.ts:236`의 선례는 "선택된 이름이 이긴다". context를 나중에 병합하면 context가 이긴다 |
| 3 | ~~호출 빈도 실측~~ **닫힘 (CRL-69)** | corral 이력이 아니라 **발행 쪽 코드**에 답이 있었다. `apps/batch/src/main.ts`가 스케줄을 적어두고 `tag-sweep`(01:30)이 발행량 상한을 적어둔다 — 정상 상태 **하루 수 건**, 발행 누락 시 최대 200건. 1건당 약 800토큰(어휘 포함). 그리고 refinery가 이미 어휘를 넣고 있으므로 **증가분이라는 것이 없다** |
| 4 | **`context`에 크기 상한을 둘 것인가** | `FieldSelectorSchema`의 `truncate`·`limit`이 이미 같은 일을 한다. 재사용할지, context는 원문 고정인지 |

---

## 7. 비범위

- **입력을 여러 번 조회하기.** `context`는 프롬프트 재료 전용이다. 처리 대상을 둘 이상 가져오는
  것은 파이프라인 하나가 내는 요청 수를 바꾸는 별개 주제다(분석 문서 §7과 같은 선).
- **파생 계산.** 설계서 §5.2가 `derive`를 없애며 정리했다.
- **`prompt.system` 치환** — D4로 하지 않는다.
- **실패 알림.** 목록 조회 실패가 어떻게 알려지는가는 운영 전반의 문제다.

---

## 8. 순서와 판단 지점

```
S1 ──▶ 배포 (CRL-63, 완료)
  │
  └─▶ 호출 빈도 확인 (CRL-69, 닫힘) ──▶ S2 ─▶ S3 ─▶ S4 ─▶ S5 ─▶ S6
```

**S1을 먼저 낸 이유는 D1의 결정과 무관하기 때문이다.** 안 A로 뒤집혀도, 아무것도 하지 않기로
해도 S1은 유효하다 — 조용히 성공하는 것을 멈추는 일이라 근본 문제와 독립적이다.

**S2 앞의 판단 지점은 닫혔다.** 원래 질문은 "목록을 프롬프트에 넣는 값이 토큰 비용보다 큰가"
였고, 전제는 그것이 **비용을 추가한다**는 것이었다. 그 전제가 틀렸다 — refinery는 이미 어휘를
프롬프트에 넣고 있고 그 상태의 실측이 1건 약 800토큰이다. corral이 안 넣는 쪽이 예외이며,
S2는 비용을 늘리는 작업이 아니라 격차를 메우는 작업이다.

숫자가 있어야 답할 수 있다고 본 것도 틀렸다. 답은 corral 이력이 아니라 **발행 쪽 코드**에
있었다 — 스케줄은 `apps/batch/src/main.ts`, 발행량 상한은 `tag-sweep-batch.service.ts`다.
운영 중인 코어에 붙어야 알 수 있는 일이 아니었다.
