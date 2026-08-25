<!-- standard-ai-workflow-kit: v1.4.0 -->

# FR-1 상세 — 하네스 실행·세션 관리 (데몬)

- 문서 목적: [REQUIREMENTS](../REQUIREMENTS.md) FR-1 그룹의 상세 요구사항. 데몬이 하네스 프로세스와 에이전트 세션을 소유하는 방식.
- 상태: approved (v1, 2026-08-25 사용자 승인)
- 최종 수정일: 2026-08-25
- 근거 문서: [paseo 분석 §2·§7](../reference/paseo-analysis.md), [하네스 인터페이스 조사](../reference/harness-interfaces.md)

## FR-1.1 하네스 프로세스 수명주기

| ID | 요구사항 | 우선순위 | 단계 |
|---|---|---|---|
| FR-1.1.1 | 데몬은 세션 시작 시 하네스를 자식 프로세스로 spawn 한다. spawn 인자(실행 파일 경로·모드 플래그·환경변수)는 어댑터가 조립하며, 실행 파일은 **번들 내 절대 경로**로 지정한다 (PATH 탐색 금지 — grok 바이너리명 충돌 대응) | M | M1 |
| FR-1.1.2 | 세션 종료·앱 종료 시 하네스 프로세스를 정상 종료(graceful)하고, 응답 없으면 단계적 강제 종료한다 | M | M1 |
| FR-1.1.3 | 하네스 프로세스의 비정상 종료를 감지해 세션을 에러 상태로 전이하고 UI 에 표출한다. 대화 이력은 보존되어 재개 가능해야 한다 | M | M1 |
| FR-1.1.4 | 데몬이 spawn 한 모든 프로세스는 PID 원장에 기록되고, 데몬 기동 시 이전 실행이 남긴 stale 프로세스를 회수(reap)한다 | M | M2 |
| FR-1.1.5 | 데몬 자체는 셸(Electron)이 detached 로 spawn 하여 앱 창이 닫혀도 세션이 유지된다. 데몬 소유권 구분은 FR-5.2 | S | M2 |

**수용 기준**: 세션 실행 중 하네스 프로세스를 외부에서 kill → 5초 내 UI 에 에러 표출, 세션 재개 가능. 데몬 강제 종료 후 재기동 → stale 하네스 프로세스 0개.

## FR-1.2 어댑터 계약과 하네스별 어댑터

### FR-1.2.1 공통 세션 계약 (M, M1)

- 클라이언트 팩토리(세션 생성/재개/모델 카탈로그/가용성 확인)와 세션 인터페이스(턴 시작, 이벤트 구독, 이력 스트림, 승인 조회·응답, 중단, 종료, 영속 핸들 기술)의 2-인터페이스 구조로 정의한다.
- 하네스별 기능 편차는 **capability 플래그**(스트리밍, 영속화, 모델 전환, 승인 모델, 네이티브 툴 등록 등)로 선언하고, 데몬·UI 는 플래그를 보고 기능을 노출/숨김한다. 미지원 기능의 silent 실패는 금지.
- 세부 인터페이스 정의는 M0 어댑터 설계서에서 확정한다 (OPEN-1).

### FR-1.2.2 pi 어댑터 (M, M1)

- `pi --mode rpc` 를 spawn 하고 stdio 위 JSONL RPC 로 통신한다.
- 지원 명령(최소): prompt, abort, 상태 조회, 모델 설정. 세션 파일 경로를 영속 핸들로 저장한다.
- pi 계열 JSONL RPC 전송 계층은 omp 와 공유 가능하게 **공용 base** 로 구현한다.

### FR-1.2.3 omp 어댑터 (M, M2)

- `omp --mode rpc-ui` + JSONL RPC. pi 어댑터 base 의 확장으로 구현한다 (별도 어댑터 아님).
- **프로토콜 v2 협상 + `rpc_chunk` 청킹(64MiB)을 구현**한다 — 미구현 시 `get_available_models` 급 큰 응답이 깨진다. 최소 지원 버전 16.3.9.
- 승인: 1차는 `--approval-mode` 고정 운용을 기본으로 하고, `extension_ui_request` 다이얼로그 파싱(취약)은 M0 설계에서 채택 여부 결정.
- omp 확장 명령(steer, follow_up, branch, compact, host tools)은 capability 플래그 뒤에 두고 S 우선순위로 단계 도입.

### FR-1.2.4 grok build 어댑터 (M, M2) — 2026-08-25 개정 (경로 확정)

- **통합 경로: ACP(`grok agent stdio`) 확정** (2026-08-25 사용자 승인, [비교·실측](../reference/grok-integration-paths.md)) — 장수 프로세스 + `session/prompt` 멀티턴, `session/cancel` 중단, `session/request_permission` 승인 중재, `session/new` 의 `mcpServers[]` 주입, `session/set_model` 모델 전환.
- spawn 시 **번들 관리 `GROK_HOME` 격리** 주입 (FR-2.1.3) — 사용자 `~/.grok` 불간섭.
- 기동 시 `grok --version` 으로 정품·버전 검증 (커뮤니티 동명 CLI 오인 방지).
- 세션 재개는 `session/load`(initialize 의 `loadSession: true` 실측 확인) — 핸들은 ACP sessionId.
- 승인: ACP `request_permission` 왕복 (`allow_once/allow_always/reject_once/reject_always` — allow_always 영속성은 잔여 실측 항목).
- Windows 는 지원 범위 외 (2026-08-25 승인 — Windows 번들에서 grok 제외).

### FR-1.2.5 툴콜 정규화 (M, M1)

- 하네스 네이티브 툴 실행을 중립 분류(`shell | read | edit | write | search | fetch | sub_agent | plan | other`)로 매핑해 UI 렌더러가 하네스 무관하게 동작하게 한다.
- 매핑 불가 툴은 `other` + 원본 페이로드 보존 (드롭 금지).

## FR-1.3 세션 영속화·재개

| ID | 요구사항 | 우선순위 | 단계 |
|---|---|---|---|
| FR-1.3.1 | 세션 메타(하네스, 작업 디렉토리, 모델, 상태)와 정규화된 타임라인을 데몬 데이터 디렉토리에 저장한다 | M | M1 |
| FR-1.3.2 | 하네스 네이티브 재개 수단(pi/omp 세션 파일 경로, grok 세션 ID)을 영속 핸들로 함께 저장한다 | M | M1 |
| FR-1.3.3 | 데몬 재시작 후 저장된 세션을 목록으로 복원하고, 선택 시 네이티브 핸들로 재개한다. 재개 실패 시 이력 열람은 가능해야 한다 | M | M1 |
| FR-1.3.4 | 재개 시 하네스가 리플레이하는 과거 이벤트를 중복 표출하지 않는다 (omp 리플레이 드롭 처리) | M | M2 |
| FR-1.3.5 | 세션 상태 모델: `initializing → idle ⇄ running → closed` (+error). closed 는 삭제가 아니라 "런타임 없음, 재개 가능" | M | M1 |

## FR-1.4 스트리밍 이벤트 정규화 (M, M1)

프로바이더 중립 이벤트 유니온(최소 집합):

- `turn_started` / `turn_completed` / `turn_failed` / `turn_canceled` — **turn_started 는 데몬이 직접 발행** (UI 낙관적 표시 회수 보장)
- `message_delta` (텍스트) / `reasoning_delta` (사고 과정)
- `tool_execution_started` / `tool_execution_updated` / `tool_execution_completed` (FR-1.2.5 분류 포함)
- `permission_requested` / `permission_resolved` (FR-1.5)
- `usage_updated` (토큰 사용량 — FR-3.7 의 데이터원)
- `session_status_changed`, `error`

수용 기준: 동일 시나리오(파일 1개 수정 작업)를 pi/omp/grok 에서 실행했을 때 UI 렌더러 코드 분기 없이 세 하네스 모두 대화·툴 카드가 표시된다.

## FR-1.5 승인(권한) 흐름 (M, M1)

- 하네스의 네이티브 승인 요청을 중립 모델(요청 ID, 종류, 대상 요약, 원본 상세)로 정규화 → `permission_requested` 이벤트 → UI 응답(허용/거부) → 어댑터가 네이티브 응답으로 역변환.
- 응답 전까지 해당 턴은 대기 상태로 유지되고, 세션 목록에 "승인 대기" 상태가 표시된다 (FR-3.3 상태 버킷).
- 데몬 재시작·UI 재연결 후에도 미응답 승인 요청은 조회 가능해야 한다 (`getPendingPermissions` 상당).
- 세션 단위 자동 승인 모드(YOLO 류)는 명시적 opt-in 으로만 제공 (S, M2).

## FR-1.6 턴 중단 (M, M1)

- `interrupt()` 는 멱등: 이미 중단됐거나 실행 중이 아니어도 에러 없이 완료된다.
- 중단 완료는 "이전 턴이 더 이상 실행될 수 없음이 확정"된 시점에 resolve. 프로세스 소유권이 불확실하면 실패로 처리하고 새 턴을 거부한다 (split-brain 방지).

## FR-1.7 멀티 세션 (M, M2)

- 하네스 혼합 포함 동시 세션 N개 (1차 목표 최소 5, 상한은 설정 가능) 안정 동작.
- 세션 간 이벤트 스트림·영속화가 간섭하지 않는다 (세션 ID 스코프).

## FR-1.8 버전 검증·호환성 (S, M2)

- 어댑터는 기동 시 하네스 실행 파일의 버전을 manifest(FR-4.2)의 검증 버전과 대조하고, 불일치 시 경고 이벤트를 올린다 (동작 차단은 하지 않음).
- 이벤트 파싱은 관대(passthrough — 미지 필드 보존, 미지 이벤트는 `other` 로 통과)해야 하며, 버전별 차이는 COMPAT 정책(만료일 태그)으로 관리한다 (NFR-5).
