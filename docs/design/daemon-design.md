<!-- standard-ai-workflow-kit: v1.4.0 -->

# 데몬 상세 설계 (M0 WBS 0.3)

- 문서 목적: 세션 영속화 포맷, 프로세스 관리, 데이터 디렉토리 배치를 확정한다.
- 상태: approved (v1.2, 2026-09-01 — §5 타임라인 검색 색인 추가(M7 7.4.1). v1.1: 2026-08-31 하네스 홈 격리. v1: 2026-08-25 사용자 승인)
- 최종 수정일: 2026-09-01
- 입력: [어댑터 설계서](./adapter-contract.md), [프로토콜 설계](./protocol-design.md), [FR-1](../requirements/fr1-harness-sessions.md), [FR-4.3](../requirements/fr4-packaging.md)

## 1. 데이터 디렉토리 배치 (0.3.3)

```
~/.custom-harness/
├── versions/<bundleVersion>/     # 번들 해제본 (불변) — app/ harnesses/ config-templates/ licenses/ manifest.json
├── current -> versions/<ver>/    # 원자적 전환 대상 (Windows: junction)
├── data/                         # 버전 무관 사용자 데이터 — 롤백 영향 없음 (FR-4.4.2)
│   ├── sessions/<sessionId>/     # §2 세션 영속화
│   ├── grok-home/                # grok 격리 GROK_HOME (FR-2.1.3)
│   ├── harness-home/<harness>/   # 하네스 HOME 격리 (M7 7.2.0a, NFR-1) — 빈 홈 + allowlist 반입
│   ├── daemon.token              # 프로토콜 인증 토큰 (0600)
│   ├── daemon.pid                # {pid, managedBy, bundleVersion} (FR-5.2)
│   ├── processes.json            # PID 원장 (§3)
│   ├── settings.json             # 앱 설정 (기본 모델, 알림 등 — 키는 제외, §키저장 참조)
│   └── search-index.db           # 타임라인 검색 색인 (§5) — 파생물, 지워도 재생성
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

- **spawn 규약**: 어댑터가 인자 조립, 데몬이 실행. 실행 파일은 `current/harnesses/<h>/` 절대 경로 (PATH 금지, FR-1.1.1). env 오버레이 = 게이트웨이 키(env 전달) + 오프라인 스위치 + grok `GROK_HOME=data/grok-home` + **홈 격리**(`HOME`·win32 `USERPROFILE`·XDG 4종 → `data/harness-home/<harness>/`, M7 7.2.0a).
- **PID 원장** `processes.json`: `{ pid, sessionId, harness, spawnedAt, bundleVersion }` append → 종료 시 제거. 데몬 기동 시 원장 스캔: 살아있는 프로세스는 **소유 세션이 재개 가능하면 연결 복원 시도 없이 정리**(1차 단순화 — 어댑터 재접속은 하지 않고 graceful kill 후 세션은 재개 경로로), 죽은 항목은 제거. (프로세스 재접속 지원은 과설계로 판단, 필요 시 개정)
- **종료 단계화**: graceful(프로토콜 종료/ SIGTERM) → 5초 → SIGKILL. grok 은 SIGTERM 세션 저장 보장이 잔여 실측 — 결과에 따라 종료 전 `session/cancel` 선행 여부 결정.
- **데몬 수명**: 셸이 detached spawn(FR-1.1.5), `daemon.pid` 의 `managedBy` 로 소유 구분(FR-5.2). 데몬 셧다운 시: 실행 중 턴 interrupt → 하네스 정리 → 원장 비우기 → 토큰 파일 삭제.

### 4.1 턴 개시 구간의 이벤트 보류 (M7 7.5.1)

`prompt()` 는 `startTurn()` 이 turnId 를 돌려준 **뒤에야** `activeTurnId` 를 세우고 매니저 소유
행(`user_message`·`turn_started`)을 발행할 수 있다. 어댑터가 그 사이에 — `await` 한 번 만에 —
턴을 끝내면 둘이 깨진다:

1. **타임라인이 뒤집힌다.** `turn_completed` 가 `user_message` 보다 낮은 seq 를 받는다.
2. **세션이 영구히 busy 가 된다.** 이미 끝난 턴 id 가 `activeTurnId` 에 얹히고 아무도 지우지
   않는다 → 이후 모든 프롬프트가 `busy` 로 거부되고 상태가 `running` 에 머문다.

그래서 개시 구간 동안 어댑터 이벤트를 `eventHold` 에 잡아 두고, 매니저 행을 낸 뒤 순서대로
흘린다. 실제 하네스는 그만큼 빠르지 않아 오래 드러나지 않았고, mock 하네스로 프롬프트를
연달아 보내는 CLI 경로(FR-9.6)에서 재현됐다.

**종료 시 쓰기 대기**: `shutdown()` 은 세션별 emit 체인을 기다린다. 기다리지 않으면 "종료
완료"를 알린 뒤에도 `timeline.jsonl` 이 써진다 — 그 파일이 SSOT 이고 검색 색인이 다시 읽는
대상(§5)이므로 종료가 쓰기를 앞지르면 안 된다.

## 5. 타임라인 검색 색인 (M7 7.4.1, FR-9.4)

`data/search-index.db` — SQLite FTS5. **파생물이다**: SSOT 는 §2 의 `timeline.jsonl` 이고,
이 파일은 언제 지워도 기동 시 다시 만들어진다.

### 5.1 검색 단위는 이벤트가 아니라 세그먼트

`message_delta` 는 조각이라 검색어가 두 델타에 걸치면(`인덱` + `스 전략`) 원본 줄 어디에도
그 문자열이 없다. 그래서 색인 대상은 **턴 단위로 합친 텍스트**다.

| 종류 | 출처 | 비고 |
|---|---|---|
| `user` | `user_message` | 이벤트 하나가 곧 세그먼트 |
| `assistant` | `message_delta` 연속 구간 | 다른 종류의 사건이 오면 확정 |
| `reasoning` | `reasoning_delta` 연속 구간 | 발화와 섞지 않는다(가짜 매치 방지) |
| `tool` | `tool_execution_started` | `toolName` + `summary` + `rawInput`(2000자 상한) |

결과의 `seq` 는 세그먼트를 **여는** 이벤트를 가리킨다 — 팔레트(7.4.2)의 타임라인 점프 앵커다.

### 5.2 엔진과 토크나이저

- **`node:sqlite`(Node 내장)**: 새 의존성도 네이티브 프리빌드도 늘지 않는다 — 폐쇄망 3-OS
  아카이브(G2)에 얹을 것이 없다. 데몬은 번들 Node 위에서 돈다(실측: Electron 44 / Node 24.18.1,
  FTS5 사용 가능). 정적 `import` 는 못 쓴다: Node 가 이 모듈을 접두사 붙은 이름으로만 노출해
  (`builtinModules` 에 `sqlite` 없음) Vite 5 가 접두사를 떼고 찾다 실패한다 → `createRequire`.
- **토크나이저는 `trigram`**: 기본 `unicode61` 은 "전략을"을 한 토큰으로 끊어 "전략" 질의가
  0건이고 "인덱스 전략" 같은 구 검색도 어미가 붙는 순간 어긋난다(실측). 대가는 3자 미만
  질의를 못 쓴다는 것 — 그 항만 `LIKE` 로 떨어뜨린다(느리지만 빈손으로 돌려주지 않는다).
- 질의는 공백으로 끊어 **AND**. 정렬은 **최근 세션 우선** — `bm25` 랭킹은 MATCH 경로에서만
  성립해서, 그걸 쓰면 질의 길이에 따라 정렬 규칙이 조용히 바뀐다.

### 5.3 색인 유지

- **따라잡기(기동 시)**: 세션별 `indexed_seq` 워터마크와 `timeline.jsonl` 의 마지막 seq 를
  비교해 밀린 세션만 **통째로** 다시 만든다. 증분이 아닌 이유는 세그먼트가 여러 이벤트에
  걸쳐 있어서 워터마크가 그 중간에 떨어지면 잘린 세그먼트가 남기 때문. 사라진 세션의 행도
  여기서 걷어낸다(열 수 없는 세션이 결과에 남으면 안 된다).
- **실행 중**: 세션 매니저 이벤트를 구독해 확정된 세그먼트만 덧붙인다. 이게 없으면 방금 한
  대화가 다음 기동까지 안 잡힌다. 쓰기는 직렬 큐 — 메타 조회가 비동기라 순서가 뒤집히면
  워터마크가 뒤로 간다.
- **실패는 삼킨다**: 색인 열기·갱신 실패가 대화를 막을 이유는 없다. 검색이 빠질 뿐이고,
  다음 기동의 따라잡기가 메운다. 스키마 변경도 마이그레이션 대신 폐기 후 전량 재생성.

### 5.4 알려진 한계

- **기간 필터는 세션 시각 기준**이다. 이벤트 봉투에 타임스탬프가 없고(`sessionId` + `seq` 뿐)
  이벤트별 시각은 프로토콜 변경인 데다 이미 쌓인 타임라인에 소급되지 않는다. 세션 타임라인은
  그 세션의 수명 안에 갇혀 있으므로 겹침 판정으로 거른다.

## 4. 세션 매니저 핵심 계약 (구현 지침)

- `turn_started` 는 매니저가 직접 발행, 사용자 메시지 타임라인 행도 매니저 소유 (FR-1.4).
- `interrupt()` 멱등·소유권 불확실 시 신규 턴 거부 (FR-1.6).
- 승인 대기는 세션 상태와 독립 트랙(pending 목록) — 재연결·재기동 후 `getPendingPermissions()` 복원 (FR-1.5).
- 동시성: 세션당 활성 턴 1개(추가 프롬프트는 큐잉이 아니라 거부 — 1차 단순화, 컴포저 UX 는 FR-3.2.6 에서 비활성 처리). 세션 수 상한 settings(기본 8).
