# Corral 개발계획서 (v2 — 현재 코드 기준)

> 작성일: 2026-06-19
> 대상: `corral` (OSS 공개판) — 소스는 마실 내부 도구 `symphony-ts`(현 main, M0~M11 + review 파이프라인)
> 위치: 코드 `/Users/junghyun/Project/corral`, 저장소 `https://github.com/jung519/corral.git`
> 전신 계획서: `~/Project/masil/symphony/docs/oss-release-plan.md` (v1, 2026-06-18) — 본 문서가 현재 코드 기준으로 대체

---

## 0. v1 → v2 무엇이 바뀌었나

- **제품명**: Symphony(내부) → **Corral**(공개). 에이전트를 몰아 관리하는 오케스트레이터.
- **코드 진화** (v1 계획서 작성 이후 symphony main):
  - `src/review/` 파이프라인 신설 — 정적 검증 게이트(`static-qa-runner.ts`), semgrep(`semgrep-runner.ts`), **계획 사전 비평**(`plan-critique.ts`), 적응형 리뷰 라운드(`orchestrator.ts`), 증분 재리뷰.
  - `fix_plan` 승인 종류 분리, 막힌 이슈 retry, 첨부(pdf/이미지) 리더.
  - `agent/tracker/repository`에 `factory.ts` 추가 — 단, **레지스트리가 아니라 `switch(kind)`**.
- **관계 모델 확정**: symphony는 **시한부 도너**, corral은 **재설계된 후계자**(모델 D, §1). 솔로 개발 + 단일 최종 동기화이므로 상시 동기화 장치는 두지 않는다.

## 1. 핵심 결정 — Symphony ↔ Corral 관계 (모델 D)

### 1.1 모델 선택의 결론

| 모델 | 내용 | 판정 |
|------|------|------|
| A. 하드 포크 | 복사 후 각자 진화 | ✗ symphony 개선을 잃음 |
| B. 단일 코어(상시 동기화) | symphony를 generic core+profile로 두고 corral과 코어 공유 | ✗ symphony가 영구히 산다는 **잘못된 전제**. 영구 동기화 장치는 과설계 |
| C. subtree 변환 동기화 | 주기적으로 symphony를 가져와 de-masil 변환 | ✗ 변환 마찰 누적 |
| **D. 후계자 / 시한부 도너 (채택)** | corral을 **corral에 맞게 처음부터 재설계**. symphony는 corral이 성숙할 때까지만 쓰는 도너 → 검증 후 폐기 | ✅ 솔로 + 단일 최종 동기화면 가장 단순·정직 |

### 1.2 채택 모델 D — 개발 흐름

corral은 모든 입력을 **유저 설정값**으로 받는 도구이므로, symphony 코드를 그대로 복사하지 않고 **corral 구조에 맞게 최적화**한다. symphony는 한시적 발판일 뿐, corral이 마실 개발로 검증되면 폐기한다.

1. **골격 작성** — 지금 symphony를 기준으로 corral의 **큰 골격(경계)** 을 짠다. 큰 흐름은 변하지 않으므로 안전.
2. **최종 동기화 (단 1회)** — corral이 쓸 만해지면 symphony의 그동안 변경분을 **마지막으로 한 번** 가져온다. 이후 symphony 동결.
3. **검증·수정** — corral로 실제 마실 개발을 하며 필요한 부분을 수정(도그푸드).
4. **정식 출시** — 마실 개발로 corral이 검증된 시점에 OSS 공개.

> 솔로 개발이라 두 레포가 통제 못 할 만큼 벌어지지 않는다. 따라서 CI grep 가드·포팅 백로그·동결일 관리 같은 **드리프트 장치는 두지 않는다**(과설계).

### 1.3 "골격 먼저 / 코어는 최종 동기화" — 한 번만 손대는 분업

핵심 낭비는 **같은 코드를 두 번 포팅**하는 것. symphony에서 계속 바뀌는 코어 로직을 지금 끌어다 넣으면, 최종 동기화 전에 또 바뀌어 재포팅하게 된다. 그래서 작업을 변동성으로 가른다:

| symphony에서 **계속 바뀌는 코어** → 2단계에 한 번에 lift | corral **고유·신규** → 1단계에 지금 만듦 |
|---|---|
| orchestrator 상태머신 | 어댑터/레지스트리 경계 (factory→registry) |
| review 파이프라인(정적게이트·plan-critique·적응형) | config 스키마 + 설정 마법사 |
| issue-state 복구, cost-tracker, workspace | 크리덴셜 → OS 키체인 |
| | agent **provider×transport** 추상화 |
| | i18n/프로파일 스캐폴딩, Electron 셸, LICENSE/문서 |

- **1단계 = corral 신규 골격 + 코어가 끼워질 인터페이스(스텁)** 까지. 변동성 큰 코어 로직은 포팅하지 말고 **인터페이스만 비워둔다**.
- **2단계 = 성숙한 symphony 코어를 그 인터페이스에 한 번에 떨군다.** 각 조각을 딱 한 번만 만진다.
- **주의**: 오른쪽 칸 중 **agent provider×transport**와 **크리덴셜/키체인**은 symphony에 없는 형태(claude CLI 단일)이므로 **백지에서 설계**한다 — symphony에서 모양을 베끼지 않는다.

> 들어올릴 검증된 코어는 **재작성하지 말 것**(버그 재유입). 경계만 corral 모양으로 다시 짠다.

## 2. 현재 자산 진단 (재사용 / 일반화 / 신규)

| 영역 | 현재 (symphony) | corral 조치 |
|------|------------------|-------------|
| 4축 추상화 | `src/types.ts` 인터페이스 + zod discriminatedUnion('kind') | ✅ 토대 재사용. 어댑터 인터페이스로 승격 |
| Factory | `agent/tracker/repository/factory.ts` = `switch(kind)`, 단일 구현 | ⚠️ 레지스트리로 일반화 (S1, 경계) |
| Agent | `agent/claude.ts` — claude CLI spawn 전용, `--model`/`--continue` 등 claude 플래그, `.claude/rules/WORKFLOW.md` 하드코딩 | ⚠️ provider×transport 백지 설계 (S1, 경계) |
| 인증 | `~/.claude` OAuth 마운트(`workspace/docker.ts:53`), 평문 yaml + `$ENV` 치환(`config/loader.ts`) | ⚠️ 제거 → BYOK + OS 키체인 백지 설계 (S1, 경계) |
| Review 파이프라인 | `src/review/*` — 정적 게이트·semgrep·plan vetting·적응형 | ✅ 코어 강점 → **S2 lift**. semgrep PATH 가정·마실 예시만 일반화 |
| 마실 하드코딩 | 아래 §2.1 인벤토리 | ⚠️ corral 코어에 미반영(프로파일/i18n) (S1/S2) |
| 대시보드 | `src/server/dashboard.ts` — 단일 임베드 HTML + SSE | ✅ Electron 렌더러로 이식 (S3) |
| 채널 | web/slack 양립(`channel/`) | ✅ ChannelAdapter로 (S1 경계 / S2 lift) |
| 워크스페이스 | docker/local + io 팩토리 | ✅ 코어 → S2 lift (인터페이스는 S1) |
| 라이선스 | 없음 (= all rights reserved) | ⚠️ Apache-2.0 + NOTICE (S1) |
| 실행 | PM2(`ecosystem.config.cjs`) + Makefile + tsc | ⚠️ Electron 메인이 생명주기 인수 (S3) |

### 2.1 마실 하드코딩 인벤토리 (corral 코어에 넣지 않을 대상)

| 파일:위치 | 값 | 종류 |
|-----------|-----|------|
| `src/review/prompt.ts:46` | `${skillsPath}/masil_project` | 경로 |
| `src/review/prompt.ts:51,97` | `한국어 (존댓말)` | 언어 |
| `src/review/prompt.ts:52,98` | `특이사항 없음` | 텍스트 |
| `src/review/prompt.ts:79` | `해결됨`/`미해결` | 한글 상태 |
| `src/review/prompt.ts:84-86` | NestJS/Flutter/Mongoose 예시 | 스택 캘리브레이션 |
| `src/prompt-builder.ts:51,57` | `✅ 승인됨`, `🔍 더 검토 요청` | 한글 시그널 |
| `src/cost-tracker.ts:49,52` | `## 💰 Symphony 비용` + 한글 라벨 | 텍스트 |
| `WORKFLOW.md:25,31` | 첨부 안내 + `{{ skills_path }}/masil_project/` | 한글 문서/경로 |
| `symphony.yaml:13,34,51` | `진행 상태`, `jung519/tilldone-masil*` | 설정 |
| `config/schema*.ts`, `prompt-builder.test.ts` | `tilldone-masil` 예시·테스트 | 경로/테스트 |

외재화 방식: `src/i18n/{en,ko}.json` + 스택 프로파일(`generic`/`nestjs`/`flutter`) + schema의 `skills_path` → 범용 `reference_repo` 옵션.

## 3. 타깃 아키텍처 (현재 코드와의 갭)

### 3.1 5축 어댑터 (레지스트리 + 인터페이스)
```
TrackerAdapter      fetchCandidates / transition / comment / attachments
RepositoryAdapter   listPRs / openPR / merge / branch / verify
AgentAdapter        run(handle, issue, opts)   ← provider × transport
WorkspaceAdapter    create / exec / writeFile / remove   (docker | local)
ChannelAdapter      requestApproval / sendFeedback   (web | slack)
```
- 갭: 현재 factory는 `switch` → `register(kind, ctor)` 레지스트리로 교체. zod 유니온은 동적 등록 가능하게 확장.
- v1 레퍼런스: Tracker=Notion, Repository=GitHub, Channel=web, Workspace=docker/local. 인터페이스를 `@corral/sdk`로 노출.

### 3.2 Agent: provider × transport
```
AgentAdapter
├─ provider: claude | gemini | gpt
└─ transport: api | cli
```
- 갭: `agent/claude.ts`가 CLI spawn·claude 플래그·`.claude` 경로에 강결합. 출력 파서가 claude `stream-json` 전용(`claude.ts:119-135`).
- 작업: 공통 `AgentRequest/Response` 추출 → api(공식 SDK/HTTP, BYOK) / cli(설치 감지 후 spawn) 트랜스포트 분리. 단계별 모델 매핑(planning/implementation/review) 프로바이더 중립화. `~/.claude` 마운트 제거.

### 3.3 크리덴셜 (BYOK)
- 갭: 평문 yaml + `$ENV`(`config/loader.ts`), `~/.claude` 마운트(`workspace/docker.ts`).
- 작업: 키는 **OS 키체인**(safeStorage/keytar), 설정엔 참조만. 마법사에서 입력·검증(ping). 앱 임베드 키 0.

### 3.4 Electron 2-프로세스 + UI (별도 UI 검토 반영)
- 메인 = 오케스트레이터 생명주기(PM2 대체)·종료 시 컨테이너 정리. 렌더러 = Svelte + Vite(electron-vite).
- **데이터 평면 = 기존 HTTP+SSE 유지** → 같은 렌더러가 헤드리스(브라우저)에서도 동작. IPC는 키체인/파일다이얼로그/Docker감지/알림 등 네이티브만.
- 핵심 신규 UI = **설정 마법사**(5축 단계별 입력 + 즉시 검증). IA: 첫실행→마법사, 이후 좌측 내비(대시보드/이슈/설정/로그/About).

## 4. 마일스톤 로드맵 (모델 D — 골격→최종동기화→검증→출시)

4단계 흐름(§1.2)에 기술 작업을 매핑. **헤드리스로 코어를 먼저 안정화한 뒤** S3에서 Electron을 입힌다(리스크 분리).

### S1 — 골격 (corral 고유 경계 + 코어 인터페이스 스텁) · 헤드리스
지금 착수. symphony 코어 로직은 **포팅하지 않고 인터페이스만** 둔다.
- corral 레포 부트스트랩: `LICENSE`(Apache-2.0) + `NOTICE` + 소스 헤더 + README 골격.
- **어댑터/레지스트리 경계**: `factory.ts` `switch` → `register(kind, ctor)` 레지스트리. 5축(Tracker/Repository/Agent/Workspace/Channel) 인터페이스 확정.
- **config 스키마 재설계**: 모든 값이 유저 입력 전제. i18n(`en`/`ko`) + 스택 프로파일(`generic`/…) + `reference_repo` 옵션. 마실 하드코딩(§2.1)은 corral 코어에 **애초에 넣지 않음**.
- **agent provider×transport 추상화** (백지 설계): `AgentAdapter` = provider(claude/gemini/gpt) × transport(api/cli). api(BYOK) 1순위. claude `stream-json` 가정 제거, 출력 정규화 인터페이스.
- **크리덴셜 → OS 키체인** (백지 설계): 평문 yaml·`~/.claude` 마운트 폐기, 설정엔 참조만.
- 코어 자리: orchestrator/review/workspace 등은 **인터페이스 + 최소 스텁**만. semgrep 등 외부 바이너리는 미설치 감지·안내(번들 금지).
- **DoD**: 임의 GitHub 레포 + Notion DB를 **설정값만으로** 연결, 스텁 코어로 파이프라인 골격이 헤드리스에서 흐름. corral `src/`에 masil 문자열 0.

### S2 — 최종 동기화 (symphony 코어 1회 lift) · 헤드리스
corral 골격이 쓸 만해진 시점. **symphony를 마지막으로 한 번** 가져와 동결.
- 성숙한 symphony 코어를 S1 인터페이스에 끼움: orchestrator 상태머신, review 파이프라인(정적게이트·plan-critique·적응형·증분재리뷰), issue-state 복구, cost-tracker, concurrency-limiter, workspace(docker/local). **재작성 금지 — 들어올려 적응만.**
- 마실 특화 잔재는 lift 과정에서 프로파일/i18n로 흘려보냄(코어엔 안 들어감).
- 이후 **symphony 동결** — 신규 개발은 corral에서만.
- **DoD**: 실제 코어로 1사이클(계획→비평→승인→구현→리뷰→PR) 헤드리스 완주. claude api로 완주, cli 1종 이상 동작.

### S3 — 검증·수정 + Electron (도그푸드)
마실 개발을 corral로 옮겨 실사용하며 다듬는다. 코어가 안정적이니 이제 GUI를 입힘.
- Electron 2-프로세스: 메인이 오케스트레이터 생명주기/로그 인수(PM2 대체), 종료 시 컨테이너 정리. 렌더러 = Svelte + Vite(electron-vite), 데이터평면은 기존 HTTP+SSE 유지.
- **설정 마법사**(5축 단계별 입력 + 즉시 검증) + 대시보드 이식. Docker 설치 감지(없으면 local 안내).
- (선택) gemini/gpt 어댑터, 외부 어댑터 로드(`@corral/sdk`) — 실사용 필요에 따라.
- **DoD**: 마실 개발을 corral GUI에서 일상 운영. .dmg/.exe 설치 → 마법사 입력 → 1사이클 완주.

### S4 — 정식 출시
마실 개발로 corral이 검증된 시점에 OSS 공개.
- GitHub Actions: 멀티 OS 빌드, 코드 서명(가능 범위), `electron-updater`.
- 문서: 설치/온보딩/프로바이더별 설정/트러블슈팅, 5분 Quickstart.
- 거버넌스: `CONTRIBUTING.md`, 이슈/PR 템플릿, `CODE_OF_CONDUCT`, `SECURITY.md`, 어댑터 작성 가이드, SemVer·로드맵.
- **DoD**: 태그 푸시 → 릴리스 아티팩트 자동 생성, 신규 사용자가 문서만으로 가동, 외부인이 어댑터 PR 제출 가능.

## 5. 전환 운영 (솔로 · 단일 최종 동기화)

모델 D이므로 무거운 동기화 장치는 두지 않는다. 규칙은 두 개뿐:
- **코어는 두 번 만지지 않는다** — S1에선 인터페이스만, 코어 로직은 S2에서 한 번에 lift(§1.3).
- **마실 특화는 corral 코어에 안 넣는다** — config/프로파일/i18n로. (솔로라 CI 강제 도구 불필요, 관례로 충분.)
- S2 이후 symphony 동결 → 포팅할 신규 변경 자체가 없음.

## 6. 리스크 / 완화

- **리라이트 트랩**(corral이 영영 symphony를 못 따라잡음) → 검증된 코어는 재작성 말고 lift, 경계만 재설계. S2를 명확한 1회 이벤트로.
- **두 번 포팅 낭비** → S1=인터페이스만, 코어는 S2에 한 번(§1.3).
- Docker 마찰(2~3GB) → local 기본 + Docker 선택, 첫 실행 경량화.
- 프로바이더 약관 변동(third-party access) → BYOK·비번들 + 약관 고지/면책, 릴리스 전 재확인.
- CLI 트랜스포트 파편화 → 어댑터 경계 격리, api 1순위.
- 추상화 과설계 → 인터페이스 + 레퍼런스 1~2종, 나머지는 커뮤니티.
- 시크릿 평문 노출 → 키체인 강제, 설정엔 참조만.

## 7. 즉시 착수 체크리스트 (S1 1주차)

1. corral 레포: `LICENSE`(Apache-2.0)·`NOTICE`·`README` 골격 커밋, `main` 푸시.
2. config 스키마 v1 + 5축 어댑터 인터페이스 + 레지스트리(`register(kind, ctor)`) 스켈레톤.
3. agent provider×transport 인터페이스 백지 설계(스텁) + 크리덴셜 키체인 추상화.
4. 코어 인터페이스(orchestrator/review/workspace) 시그니처만 — 구현은 S2 lift 대상으로 표시.
5. 임의 테스트 레포(GitHub) + 더미 Notion DB로 골격이 설정값만으로 헤드리스 기동되는지 확인.

## 8. 성공 기준 (전체 DoD)

신규 사용자가 (1) 설치 파일로 corral을 깔고, (2) 마법사에서 자기 AI 키·저장소·트래커만 입력하고, (3) 자기 프로젝트 이슈 하나를 계획→승인→구현→리뷰→PR까지 GUI에서 완주한다. 이 과정에서 앱은 어떤 임베드 키도 쓰지 않고 어떤 독점 바이너리도 재배포하지 않으며, 라이선스/고지가 갖춰져 있다. 그리고 corral이 **마실 개발로 검증**되어 symphony를 대체한다.

---

### 참고
- 현재 코드 지도(2026-06-19): factory=switch(레지스트리 아님), `src/review/*` 신설, 키체인 없음, masil 하드코딩 §2.1.
- 관련: `~/Project/masil/symphony/docs/oss-release-plan.md`(v1), `harness-improvement-plan.md`, `planning-improvement-plan.md`, `WORKFLOW.md`.
- UI 구성 검토(이 대화): Svelte+Vite 렌더러, HTTP+SSE 유지, 설정 마법사 중심.
