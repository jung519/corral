# Corral UI/UX 기획서 (v1)

> 이 문서가 UI의 **단일 기준(source of truth)** 입니다. 구현(`renderer/`)은 여기에 맞춥니다.
> 변경은 이 문서를 먼저 고친 뒤 코드에 반영합니다.

## 1. 원칙

- **컨트롤 패널** — 화려함보다 밀도·가독성. 운영자가 상태를 한눈에 보고 즉시 조치.
- **다크 테마 기본**, 플랫(그라데이션·그림자 최소), GitHub 다크 계열.
- **두 모드** — 첫 실행=설정 마법사(전체화면), 이후=앱 셸(좌측 내비 + 콘텐츠).
- **데이터 평면 = HTTP+SSE** — 같은 렌더러가 브라우저(헤드리스)·Electron 양쪽에서 동작.
- **UI 언어** — 영문 기본 + 한국어 i18n(`renderer/src/lib/i18n.svelte.ts`, EN/한국어 토글, localStorage 저장). 이는 UI 문자열이며, `profile.language`(에이전트 출력 언어)와 별개.

## 2. 디자인 토큰 (`renderer/src/app.css`)

| 토큰 | 값 | 용도 |
|------|-----|------|
| `--bg` | `#0d1117` | 페이지 배경 |
| `--surface` | `#161b22` | 카드/헤더 |
| `--surface-2` | `#1c2129` | 보조 표면(배지/호버) |
| `--border` | `#30363d` | 경계선 |
| `--text` / `--text-dim` | `#e6edf3` / `#9da7b3` | 본문 / 보조 |
| `--accent` / `--accent-text` | `#534ab7` / `#cecbf6` | 강조(현재 단계, 주요 버튼) |
| `--green` / `--amber` / `--red` | `#1d9e75` / `#ba7517` / `#e24b4a` | 성공 / 경고 / 오류 |
| `--radius` | `10px` | 카드/버튼 |

타이포: system-ui, 14px 기준, 헤더 18px. 버튼 outline·hover surface-2·primary는 accent 보더.

## 3. 정보 구조 / 내비게이션

```
첫 실행(설정 없음) ─────────────▶ 설정 마법사 (#/setup, 전체화면)
                                      └ 완료 → 앱 셸로 전환
설정 있음 ───────────────────────▶ 앱 셸
  ├─ Dashboard  (#/)        실행 중 이슈 + 액션 필요 + 타임라인
  ├─ Issues     (#/issues)  이슈 가져오기/목록(후보 모달은 Dashboard에서)
  ├─ Settings   (#/settings) 설정 재편집 + 자격증명 관리
  ├─ Logs       (#/logs)     오케스트레이터/이슈 로그
  └─ About      (#/about)    버전 · 오픈소스 라이선스
```
좌측 내비 폭 200px. 승인 필요 시 Dashboard 항목에 배지 + (Electron) OS 알림.

## 4. 화면 — 설정 마법사 (`#/setup`)

좌측 5단계 스텝퍼 + 우측 폼. **끝까지 입력 후 실패 방지**를 위해 단계별 검증.

```
┌──────────────┬───────────────────────────────────────────┐
│ Corral setup │  AI provider                               │
│              │                                            │
│ ● AI         │  Provider  [Claude][Gemini][GPT]           │
│ ○ 저장소      │  Transport [cli][api]                      │
│ ○ 트래커      │  API key (BYOK·키체인)  [••••••]  [Test ✓] │
│ ○ 워크스페이스 │  planning [opus]   implementation [sonnet] │
│ ○ 채널·예산   │                                            │
│              │                         [Back]   [Next →]  │
│ 1/5 ▓░░░░     │                                            │
└──────────────┴───────────────────────────────────────────┘
```

단계와 입력:
1. **AI** — provider(claude/gemini/gpt) × transport(cli/api). api면 API 키 + **Test**. 단계별 모델.
2. **저장소** — GitHub `owner/name`, 토큰(+Test), 라우팅 key, production/development 브랜치.
3. **트래커(선택형 — Notion 강제 아님)** — 종류 선택 [Notion | GitHub Issues].
   - Notion: DB id, 토큰(+Test), 속성(status/identifier/repo), scope 체크박스.
   - GitHub Issues: 이슈 repo(기본=작업 repo), scope 라벨, 식별자 prefix(GitHub 토큰 재사용).
   - 공통: 의미 상태(planning/plan_review/in_progress/in_review/done) → 트래커 값 매핑.
4. **워크스페이스** — local | docker(+Docker 감지 결과 배지).
5. **채널·예산** — 포트(기본 4400), 동시 이슈 한도, language/stack 프로파일.

검증 상태(필드/Test): `idle → validating(“testing…”) → valid(✓ green) → error(✗ red + 사유)`.
스텝퍼: 완료 ✓(green), 현재 단계 accent 강조, 미완 빈 원. 하단 진행 바.
저장: Electron=키체인+config 파일+IPC, 브라우저=`POST /api/setup`(파일 스토어). 완료 후 대시보드로.

## 5. 화면 — 대시보드 (`#/`)

```
● Corral                                3 issue(s)   [+ Import issues]
─────────────────────────────────────────────────────────────────────
Action needed
┌─ [plan] 로그인 속도 개선                                   ISS-42 ─┐
│  <렌더된 계획 마크다운>                                            │
│  ( ) 1안  ( ) 2안  ( ) 3안                                         │
│  [메모…………]                          [Approve]  [Request changes] │
└────────────────────────────────────────────────────────────────────┘

Issues
┌ ISS-42  로그인 속도 개선     [implementing]              $0.0123 ┐
│  계획 ─ 승인 ─ 구현 ─ 리뷰 ─ PR ─ 완료   (현재=구현)             │
│  tracker  ·  PR #12  ·  [Complete]  [Retry]                      │
└──────────────────────────────────────────────────────────────────┘

Timeline (live)
  ISS-42  🛠 Implementing
  ISS-42  🔍 Self-reviewing
```

- **헤더**: 온라인 점(green/red) · 제목 · 이슈 수 · Import issues(후보 모달).
- **Action needed**: 승인 카드 목록(아래 §6).
- **Issues**: 카드마다 ID/제목/단계 배지/누적 비용 + **단계 진행 스텝바** + tracker/PR 링크 + Complete(PR 있을 때)/Retry(stuck일 때).
- **Timeline**: SSE 이벤트 최신순. 이슈별 색/아이콘.
- **빈 상태**: "No issues in flight. Import one to begin."

### Phase → 라벨/색

| phase | 라벨 | 색 |
|-------|------|----|
| planning / plan_reviewing | 계획 | accent |
| plan_sent / pr_plan_sent / review_sent / question_sent | 액션 필요 | amber |
| implementing / review_fixing | 구현/수정 | accent |
| reviewing | 리뷰 | accent |
| pr_open | PR 대기 | green |
| auth_error_waiting / error | 오류 | red |

## 6. 컴포넌트 — 승인 카드 (ApprovalCard)

- 종류 배지(plan / fix_plan / review / pr_plan / question) + 제목 + 이슈 ID.
- 본문: 마크다운 렌더(HTML). 스크롤 박스.
- plan류: 안 선택 라디오(추천안 먼저). 메모 textarea.
- 액션: **Approve**(primary), **Request changes**(메모 필수).

## 7. 컴포넌트 인벤토리

`Button`(default/primary/disabled) · `Field`(label+input/유효성) · `Stepper`(좌측) ·
`Card` · `Badge`(phase/kind) · `Modal`(후보) · `Toast`(알림, 예정) · `ApprovalCard` ·
`IssueCard`(+PhaseBar) · `EventRow`. 모두 §2 토큰 사용.

## 8. 구현 현황 대비 (갭)

| 화면/요소 | 기획 | 현재 코드 | 갭 |
|-----------|------|-----------|-----|
| 마법사 5단계 | ✓ | ✓ **목업 일치** (프로바이더 카드·넓은 라디오·검증됨 배지·부제/헬퍼·스텝퍼+진행바) | 완료 |
| 대시보드 헤더/이슈/타임라인 | ✓ | ✓ **PhaseBar(단계 진행 바)+phase 색 배지+i18n 적용** | 완료 |
| 승인 카드 | ✓ | ✓ (i18n) | 완료 |
| 앱 셸 좌측 내비(Issues/Settings/Logs/About) | ✓ | ✗ | 내비·Settings·Logs·About 화면 미구현 |
| Toast 알림 | ✓ | ✗ | 미구현(현재 alert) |
| a11y(label 연결) | ✓ | △ | 경고 다수 |

→ 이 갭이 "보여준 UI와 다르다"의 실체입니다. 다음 작업에서 위 표를 위→아래로 좁힙니다.
