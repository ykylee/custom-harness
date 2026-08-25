<!-- standard-ai-workflow-kit: v1.4.0 -->

# 데몬 상세 설계 (M0 WBS 0.3)

- 문서 목적: 세션 영속화 포맷, 프로세스 관리, 데이터 디렉토리 배치를 확정한다.
- 상태: approved (v1, 2026-08-25 사용자 승인)
- 최종 수정일: 2026-08-25
- 입력: [어댑터 설계서](./adapter-contract.md), [프로토콜 설계](./protocol-design.md), [FR-1](../requirements/fr1-harness-sessions.md), [FR-4.3](../requirements/fr4-packaging.md)

## 1. 데이터 디렉토리 배치 (0.3.3)

```
~/.custom-harness/
├── versions/<bundleVersion>/     # 번들 해제본 (불변) — app/ harnesses/ config-templates/ licenses/ manifest.json
├── current -> versions/<ver>/    # 원자적 전환 대상 (Windows: junction)
├── data/                         # 버전 무관 사용자 데이터 — 롤백 영향 없음 (FR-4.4.2)
│   ├── sessions/<sessionId>/     # §2 세션 영속화
│   ├── grok-home/                # grok 격리 GROK_HOME (FR-2.1.3)
│   ├── daemon.token              # 프로토콜 인증 토큰 (0600)
│   ├── daemon.pid                # {pid, managedBy, bundleVersion} (FR-5.2)
│   ├── processes.json            # PID 원장 (§3)
│   └── settings.json             # 앱 설정 (기본 모델, 알림 등 — 키는 제외, §키저장 참조)
└── logs/                         # 데몬·하네스 stderr 로그 (회전: 크기 기준)
```

- 원칙: `versions/` 는 불변, `data/` 는 버전 중립 스키마(마이그레이션은 additive 전용).

## 2. 세션 영속화 (0.3.1)

```
data/sessions/<sessionId>/
├── meta.json        # { sessionId, harness, cwd, modelId, status, createdAt, updatedAt, handle: PersistenceHandle }
└── timeline.jsonl   # 정규화 이벤트 append-only (AgentEvent + seq)
```

- **append-only JSONL** — 쓰기 실패 내성(마지막 줄 파손 시 그 줄만 드롭), 재연결 갭 재동기화(`seq`)와 직결.
- 네이티브 핸들(`handle.nativeHandle`): pi/omp 세션 파일 경로, grok ACP sessionId. 재개 실패 시 timeline 열람은 항상 가능 (FR-1.3.3).
- 삭제는 명시 조작만(디렉토리 제거). closed 는 상태 필드일 뿐 데이터 유지.
- 용량: 세션당 상한 없음 1차, `logs/` 만 회전. (사용량 증가 시 M3 에서 보관 정책 재검토 — 개정 포인트)

## 3. 프로세스 관리 (0.3.2)

- **spawn 규약**: 어댑터가 인자 조립, 데몬이 실행. 실행 파일은 `current/harnesses/<h>/` 절대 경로 (PATH 금지, FR-1.1.1). env 오버레이 = 게이트웨이 키(env 전달) + 오프라인 스위치 + grok `GROK_HOME=data/grok-home`.
- **PID 원장** `processes.json`: `{ pid, sessionId, harness, spawnedAt, bundleVersion }` append → 종료 시 제거. 데몬 기동 시 원장 스캔: 살아있는 프로세스는 **소유 세션이 재개 가능하면 연결 복원 시도 없이 정리**(1차 단순화 — 어댑터 재접속은 하지 않고 graceful kill 후 세션은 재개 경로로), 죽은 항목은 제거. (프로세스 재접속 지원은 과설계로 판단, 필요 시 개정)
- **종료 단계화**: graceful(프로토콜 종료/ SIGTERM) → 5초 → SIGKILL. grok 은 SIGTERM 세션 저장 보장이 잔여 실측 — 결과에 따라 종료 전 `session/cancel` 선행 여부 결정.
- **데몬 수명**: 셸이 detached spawn(FR-1.1.5), `daemon.pid` 의 `managedBy` 로 소유 구분(FR-5.2). 데몬 셧다운 시: 실행 중 턴 interrupt → 하네스 정리 → 원장 비우기 → 토큰 파일 삭제.

## 4. 세션 매니저 핵심 계약 (구현 지침)

- `turn_started` 는 매니저가 직접 발행, 사용자 메시지 타임라인 행도 매니저 소유 (FR-1.4).
- `interrupt()` 멱등·소유권 불확실 시 신규 턴 거부 (FR-1.6).
- 승인 대기는 세션 상태와 독립 트랙(pending 목록) — 재연결·재기동 후 `getPendingPermissions()` 복원 (FR-1.5).
- 동시성: 세션당 활성 턴 1개(추가 프롬프트는 큐잉이 아니라 거부 — 1차 단순화, 컴포저 UX 는 FR-3.2.6 에서 비활성 처리). 세션 수 상한 settings(기본 8).
