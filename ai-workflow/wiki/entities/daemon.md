---
type: entity
status: active
updated: 2026-08-31
last_ingested_from: docs/design/daemon-design.md, packages/daemon/src/session-manager.ts, packages/daemon/src/processes.ts
related_pages: [harness-wrapping, attention-state, workspace-three-layer]
---

# 데몬 (Daemon)

**이 시스템의 정본이 사는 곳.** 하네스 프로세스, 세션 타임라인, 워크스페이스 레지스트리, 터미널 pty, 주의 상태를 전부 데몬이 소유한다. 셸(Electron)은 수명주기만 관리하고, 렌더러는 얇은 클라이언트다.

패키지: `packages/daemon`. 127.0.0.1 단일 포트 WebSocket (NFR-3).

## 데이터 디렉토리

```
~/.custom-harness/
├── versions/<bundleVersion>/     # 번들 해제본 (불변)
├── current -> versions/<ver>/    # 원자적 전환 대상 (Windows: junction)
├── data/                         # 버전 무관 — 롤백 영향 없음
│   ├── sessions/<sessionId>/     # meta.json + timeline.jsonl
│   ├── grok-home/                # grok 격리 GROK_HOME
│   ├── harness-home/<harness>/   # HOME 격리 (M7 7.2.0a)
│   ├── daemon.token              # 인증 토큰 (0600)
│   ├── daemon.pid                # { pid, managedBy, bundleVersion }
│   ├── processes.json            # PID 원장
│   └── settings.json
└── logs/
```

**`versions/` 는 불변, `data/` 는 버전 중립.** 마이그레이션은 additive 전용 — 롤백해도 사용자 데이터가 살아남는 이유다.

## 세션 영속화

`timeline.jsonl` 은 **append-only**. 쓰기 실패 내성(마지막 줄이 파손되면 그 줄만 드롭)과 재연결 갭 재동기화(`seq`)가 여기서 나온다. 네이티브 핸들(pi·omp 세션 파일 경로, grok ACP sessionId)은 `meta.json` 에. **재개에 실패해도 timeline 열람은 항상 가능**하다.

## 프로세스 관리

- **spawn**: 어댑터가 인자를 조립하고 데몬이 실행한다. 실행 파일은 `current/harnesses/<h>/` **절대 경로** — PATH 금지. 사용자 PC 에 같은 이름의 다른 바이너리가 있을 수 있다(grok 은 동명의 비공식 CLI 가 여럿).
- **env 오버레이**: 게이트웨이 키 + 오프라인 스위치 + `GROK_HOME` + [[concepts/home-isolation]]
- **PID 원장** `processes.json` — 기동 시 스캔해 죽은 항목 제거. 프로세스 **재접속은 하지 않는다**(과설계 판단): 살아있으면 graceful kill 하고 세션은 재개 경로로 보낸다.
- **종료 단계화**: graceful → 5초 → SIGKILL

## 매니저의 계약

- `turn_started` 와 사용자 메시지 타임라인 행은 **매니저가 발행**한다 — 어댑터가 아니라. 하네스마다 턴 시작 정의가 다르기 때문
- `interrupt()` 멱등
- **승인 대기는 세션 상태와 독립 트랙** — 재연결·재기동 후 복원된다
- 세션당 활성 턴 **1개**. 추가 프롬프트는 큐잉이 아니라 **거부**(1차 단순화)
- 세션 수 상한 기본 8

## 부하가 잡아낸 동시성 버그 2건

M2 2.7 혼합 6세션 부하 검증에서 **`meta.json` 쓰기 경합**과 **PID 원장 쓰기 경합**이 검출됐다. 둘 다 단위 테스트로는 나오지 않고 동시 세션에서만 재현됐다 → 쓰기를 직렬화(`metaChain`)해 해소. [[patterns/measure-dont-assume]] 의 부하 판.
