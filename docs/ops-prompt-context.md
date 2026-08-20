# 조회한 목록을 프롬프트에서 쓸 수 없다

> 성격: **문제 분석 + 선택지**. **결정됐고 구현됐다** — 아래 §5의 선택지 중 안 B를 골랐다.
> 결정과 근거: `operational-ai-design.md` §3.6 (D25~D29)
> 이슈 CRL-63·64·65·66·67·68
> 관련: `operational-ai-design.md` (D6·D7·D9, §5.2)
> 확인 일자: 2026-08-18. 아래 파일·줄 번호는 그 시점의 것이며, 구현으로 달라진 곳이 있다.

---

## 0. 결정 요약 (뒤에 붙임)

| 무엇 | 답 |
|---|---|
| 어느 안인가 | **안 B** — `agent.context` 자리 신설. `validate.allowed_values.from`이 그 이름을 참조해 중복을 없앰 |
| 조회 실패 | 모델을 부르기 전에 막는다. `input_failed` + `stage: 'context'` |
| 목록의 모양 | 원문 그대로. 다듬기는 어휘 구조를 아는 쪽(조회 API)의 일이다 |
| `system` 치환 | 하지 않는다. 이벤트 문자열이 시스템 메시지로 들어가는 것을 막는다 |
| 호출 빈도 (§6-3) | 정상 하루 수 건, 큐가 밀리면 최대 수백 건. 1건당 약 800토큰 |

**§3이 지적한 "성공으로 끝나는 실패"는 별도로 먼저 고쳤다** — 전부 버려지면 `rejected`다
(CRL-63). 근본 원인과 독립적이라 `context` 결정을 기다리지 않았다.

**§6-3의 전제가 틀렸었다.** "목록을 프롬프트에 넣으면 토큰이 는다"고 봤는데, 이 일을 손으로
하는 쪽은 이미 넣고 있었다. 그 상태의 실측이 1건 약 800토큰이므로 이 작업은 비용을 늘리는
것이 아니라 corral이 안 넣는 예외 상태를 없애는 것이었다.

---

## 1. 한 줄로

**허용값 목록은 이미 조회되고 캐시된다. 그런데 채점에만 쓰이고 프롬프트에는 가지 않는다.**
모델에게 "이 목록 중에서 고르라"고 알려줄 자리가 없다.

---

## 2. 지금 어떻게 되어 있나

### 2.1 프롬프트로 나가는 것

`src/ops/operation/one-turn.ts:107-110`

```ts
const messages: NeutralMessage[] = [
  { role: 'system', content: `${step.prompt.system}\n\n${schemaInstruction(step.schema)}` },
  { role: 'user',   content: fillTemplate(step.prompt.user_template, fields) },
];
```

| 정의의 어느 부분 | 프롬프트로 | 치환 |
|---|---|---|
| `agent.prompt.system` | 간다 | **없다** — 적힌 문자열 그대로 |
| `agent.schema` | 간다 | `JSON.stringify(schema)` 통째로 |
| `agent.prompt.user_template` | 간다 | `{{field}}` → `fields` |
| `agent.validate.*` | **안 간다** | — |

### 2.2 `fields`는 어디서 오나

`src/ops/pipeline/run.ts:236`

```ts
const fields = { ...asFields(event), ...resolved.fields };
```

이벤트 본문과 입력 해석기가 돌려준 값, 둘뿐이다. 그리고 입력은 **하나**다 —
`PipelineSchema`의 `input`은 단수이고, `http` 해석기는 URL 하나를 한 번 부른다
(`src/ops/input/http.ts:48`).

### 2.3 허용값 목록은 이미 조회되고 있다

`src/ops/validate/rules.ts`

- `vocabulary()` (116행) — `allowed_values.source`가 있으면 HTTP로 가져온다
- `VOCABULARY_TTL_MS` (22행) — 5분간 캐시한다
- 호출 지점은 `check()` 안의 64행 **하나뿐**이다. 답이 돌아온 뒤 대조하는 자리다

즉 값은 이미 손에 있다. 프롬프트로 가는 길만 없다.

```
목록 원천 ──▶ allowed_values.source ──▶ 채점    (조회·캐시 됨)
                    └─────────────╳──▶ 프롬프트  (길이 없다)
```

---

## 3. 무엇이 잘못되나

목록을 모르는 모델은 목록 밖의 값을 답한다. 그러면 `allowed_values`가 **전부 버린다**.

```
모델 답:  ["적당해 보이는 이름", "그럴듯한 다른 이름"]
채점 후:  []
실행 결과: completed
```

**실행은 성공으로 끝나고 아무것도 전달되지 않는다.** 검증이 고장난 게 아니라 정상 작동한
결과다 — 채점 기준은 있는데 문제지에 보기를 주지 않은 것에 가깝다.

버린 값은 `dropped`에 기록되고 `rules.ts:89`가 경고를 남기므로 흔적은 있다. 다만 실행
자체는 실패로 잡히지 않는다.

---

## 4. 지금 할 수 있는 우회와 그 한계

### 4.1 `prompt.system`에 직접 적는다

지금도 된다. `system`은 자유 텍스트이고, 편집기에 입력란이 있으며
(`renderer/src/PipelineEditor.svelte:681`), 저장하면 즉시 반영된다
(`ops-host.ts:334` → `load()` → `syncSubscriptions()`). 배포는 필요 없다.

```yaml
agent:
  prompt:
    system: |
      다음 key 중에서만 고른다: ALPHA, BETA, GAMMA
  validate:
    allowed_values:
      field: labels
      values: [ALPHA, BETA, GAMMA]     # 채점용으로 또 적는다
```

**한계**

- **같은 목록을 두 곳에 적는다.** 한쪽만 고치면 조용히 어긋난다 — 채점은 새 값을
  통과시키는데 모델은 그런 값이 있는 줄 모른다
- **원천이 따로 있으면 복사본이 생긴다.** 원천에서 항목이 추가될 때마다 사람이 정의
  파일을 고쳐야 한다. 안 고쳐도 실행은 성공으로 끝나므로 알아차릴 계기가 없다

목록이 고정이고 원천이 따로 없다면 이 방법으로 충분하다. **문제는 목록이 다른 곳에서
관리될 때다.**

### 4.2 입력 조회로 목록을 가져온다

`select`를 비우면 응답 전체가 필드가 된다(`src/ops/input/http.ts:58`). 그래서 입력 URL을
목록 API로 두면 `{{...}}`로 프롬프트에 들어간다.

**한계** — 입력 슬롯이 하나다. 목록을 가져오면 **정작 처리할 대상을 가져올 수 없다.**
둘 다 필요하면 사용자 API가 한 응답에 둘을 함께 실어야 하는데, 그건 corral 형편에 맞춰
남의 API 모양을 바꾸는 것이다.

### 4.3 이벤트에 목록을 실어 보낸다

발행자가 메시지마다 목록을 넣는다.

**한계** — D6(fetch-back)과 정면으로 어긋난다. 큐에서 대기하는 동안 목록이 바뀌면 낡은
값으로 처리한다. 메시지 크기도 커진다.

---

## 5. 선택지

### 안 A — 검증이 가져온 목록을 필드로도 공급한다

`allowed_values.source`(또는 `values`)로 확보한 값을 `fields`에 넣어 `user_template`에서
쓸 수 있게 한다.

```yaml
agent:
  validate:
    allowed_values:
      field: labels
      source: { url: "https://<host>/api/vocabulary" }
      select: "data.values"
      as: allowed          # ← 이 이름으로 프롬프트에서 쓴다 (가안)
  prompt:
    user_template: |
      다음 중에서만 고른다: {{allowed}}
      대상: {{title}}
```

| | |
|---|---|
| 좋은 점 | 목록이 **한 번만 선언된다.** 조회·캐시 코드가 이미 있어 새로 만들 것이 적다 |
| 걸리는 점 | 검증 시점이 답이 온 **뒤**인데 프롬프트는 그 **앞**이다. 조회를 앞당겨야 한다 |
| 실패 처리 | 조회가 실패하면? 지금은 채점이 거부한다(`rules.ts:68`). 프롬프트에도 쓰이면 **호출 전에** 막을지 정해야 한다 |

### 안 B — 프롬프트 재료를 위한 자리를 따로 둔다

검증과 무관하게, 프롬프트에 넣을 값의 공급원을 명시한다.

```yaml
agent:
  context:
    allowed:
      source: { url: "https://<host>/api/vocabulary" }
      select: "data.values"
  prompt:
    user_template: "다음 중에서만 고른다: {{allowed}}"
```

| | |
|---|---|
| 좋은 점 | 용도가 분명하다. 허용값 말고 다른 것(기준 문서, 분류 기준표)도 같은 자리에 들어간다 |
| 걸리는 점 | 허용값에 쓸 때 **같은 URL을 두 번 적는다.** 4.1의 중복이 형태만 바꿔 남는다 |
| 여지 | `validate`가 `context`의 이름을 참조하게 하면 중복은 사라진다. 대신 개념이 하나 는다 |

### 안 C — `prompt.system`에도 치환을 허용한다

`user_template`처럼 `system`도 `fillTemplate`을 태운다.

| | |
|---|---|
| 좋은 점 | 변경이 가장 작다(한 줄) |
| 걸리는 점 | **이것만으로는 아무것도 해결되지 않는다.** 넣을 값이 `fields`에 없는 것이 문제이지, `system`이 치환되지 않는 것이 문제가 아니다 |

→ C는 A나 B와 **함께** 쓰일 수는 있어도 단독으로는 답이 아니다.

---

## 6. 정해야 할 것

| # | 질문 | 비고 |
|---|---|---|
| 1 | A인가 B인가 | 목록을 한 번 적게 할 것인가, 용도를 분리할 것인가 |
| 2 | 조회 실패 시 실행을 막나 | 목록 없이 물으면 답이 전부 버려진다. 막는 쪽이 자연스러워 보이나 결정이 필요하다 |
| 3 | 목록을 어떤 모양으로 넣나 | `fillTemplate`은 객체·배열을 `JSON.stringify`한다(`run.ts:102`). 사람이 읽는 형태로 다듬는 기능을 둘지, 원문 그대로 둘지 |
| 4 | `system`도 치환할 것인가 | 규칙 문장은 `system`에, 재료는 `user`에 두는 지금 구분을 유지할 수도 있다 |

### 3번에 대한 실측

어떤 파이프라인의 허용 목록이 **54개 항목**이었을 때:

| 형태 | 크기 |
|---|---|
| 사람이 읽는 형태로 다듬은 문자열 (`그룹: KEY(설명), ...`) | 1,016자 |
| 원천 API 응답을 `JSON.stringify` 그대로 | 2,671자 (2.6배) |

정렬 순서 같은 프롬프트에 불필요한 필드와 JSON 구두점이 차이를 만든다. 다만 호출량이
적으면 이 차이는 무시할 수 있다 — **선택지를 좁히기 전에 해당 파이프라인의 실제
호출 빈도를 확인하는 편이 낫다.**

---

## 7. 이 문서가 다루지 않는 것

- **파생 계산.** "답에서 상위 개념을 역산한다" 같은 것은 설계서 §5.2가 `derive`를
  없애면서 정리한 별개 주제다. 필요해지면 실행 가능한 형태로 따로 추가한다
- **입력을 여러 번 조회하기.** 4.2의 한계를 정면으로 푸는 방법이지만, 파이프라인 하나가
  요청 몇 개를 내는지가 달라지므로 이 문서의 범위를 넘는다
- **실패 알림.** 목록 조회가 조용히 실패하면 무엇이 알려지는가는 운영 전반의 문제다

---

## 부록 — 확인에 사용한 지점

| 사실 | 위치 |
|---|---|
| `system`은 치환되지 않는다 | `src/ops/operation/one-turn.ts:108` |
| `user_template`만 치환된다 | `src/ops/operation/one-turn.ts:109` |
| `schema`가 프롬프트에 통째로 실린다 | `src/ops/operation/one-turn.ts:93` (`schemaInstruction`) |
| `fields`는 이벤트 + 입력 결과뿐 | `src/ops/pipeline/run.ts:236` |
| 입력은 하나, 조회는 한 번 | `src/ops/pipeline/schema.ts` (`input`) · `src/ops/input/http.ts:48` |
| `select`가 없으면 응답 전체가 필드 | `src/ops/input/http.ts:58` |
| 허용 목록을 조회하고 5분 캐시한다 | `src/ops/validate/rules.ts:116` · `:22` |
| 그 목록은 채점에서만 쓰인다 | `src/ops/validate/rules.ts:64` (유일한 호출 지점) |
| 목록 밖 값은 버려지고 기록된다 | `src/ops/validate/rules.ts:72` |
| 조회 실패 시 채점이 거부한다 | `src/ops/validate/rules.ts:68` |
| 객체·배열은 JSON으로 렌더된다 | `src/ops/pipeline/run.ts:102` (`fillTemplate`) |
| 경로 표기는 점 표기뿐이다 | `src/ops/pipeline/run.ts:134` (`readPath`) |
| 저장하면 즉시 반영된다 | `src/ops/ops-host.ts:334` → `load()` → `syncSubscriptions()` |
| 편집기에 `system` 입력란이 있다 | `renderer/src/PipelineEditor.svelte:681` |
| 허용값은 인라인·조회 중 고른다 | `renderer/src/PipelineEditor.svelte:708` |
