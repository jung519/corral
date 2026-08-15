# 모듈 경계 — 개발 AI · 운영 AI · 공용

> corral은 **두 기둥**을 갖는다: 이슈를 PR로 만드는 **개발 AI**와, 이벤트를 받아 정제·분류하는
> **운영 AI**. 둘은 같은 앱에 살지만 **코드가 섞이면 안 된다.** 이 문서는 그 경계를 정한다.

## 세 층

```
src/
├── agent/  core/  config/  credentials/  profile/  util/   ← 공용 인프라
├── control-plane/                                          ← 공용 (전송·프로토콜)
│
├── orchestrator.ts  review/  workspace/  tracker/          ← 개발 AI
│   repository/  attachments.ts
│
└── ops/                                                    ← 운영 AI
```

| 층 | 무엇 | 누가 쓰나 |
|---|---|---|
| **공용 인프라** | AI 프로바이더 호출, 이벤트 버스, 타입, 로거, 비용, 설정, 시크릿, 언어 프로파일 | 양쪽 |
| **제어평면** | 요청/응답·이벤트 스트림 프로토콜과 그 전송(프로세스 IPC / WS) | 양쪽 |
| **개발 AI** | 이슈 수명주기, 계획 비평·리뷰, 워크스페이스, PR, 트래커 | 개발만 |
| **운영 AI** | 파이프라인 정의·실행, 트리거·입력·출력 어댑터, 1턴 오퍼레이션 | 운영만 |

## 규칙 (확정)

1. **`ops/`는 공용 인프라만 import한다** — `agent`, `core`, `config`, `credentials`, `profile`, `util`.
2. **`ops/`는 개발 AI 코드를 import하지 않는다** — `orchestrator`, `review/`, `workspace/`,
   `tracker/`, `repository/`, `attachments`.
3. **개발 AI 코드도 `ops/`를 import하지 않는다.**
4. **둘의 연결은 배선 지점에서만** — `bootstrap.ts`, `ipc-main.ts`.

### 왜

- 한쪽 변경이 다른 쪽을 조용히 깨뜨리지 않는다.
- 운영 AI는 **도메인 중립**이어야 한다. 개발 AI 코드(이슈·PR·워크스페이스)를 끌어오면 그 중립성이
  깨진다.
- 나중에 분리하거나 한쪽만 배포하고 싶을 때 가능해진다.

### 공용으로 올릴 때

양쪽이 같은 것을 필요로 하면 **한쪽에서 다른 쪽을 import하지 말고 공용 인프라로 올린다.**
예: 토큰 상한은 개발·운영이 공유하므로 `core/`에 둔다(개발 AI 쪽에 두고 `ops/`가 가져다 쓰면 안 된다).

## 제어평면이 "공용"인 이유

개발 AI 대시보드도, 운영 AI 대시보드도 **같은 제어평면**으로 조작된다. 그래서 제어평면은 어느
기둥에도 속하지 않는 **공용 층**이며, `control-plane/` 아래에 모은다.

```
control-plane/
├── dispatch.ts   메서드 처리 (전송과 무관한 프로토콜)
├── ipc.ts        프로세스 IPC 전송 (데스크톱이 코어를 fork할 때)
└── ws.ts         WebSocket 전송 (원격 접속)
```

전송이 늘어도 `dispatch.ts`는 그대로다 — **프로토콜과 전송을 분리**해 둔다.
