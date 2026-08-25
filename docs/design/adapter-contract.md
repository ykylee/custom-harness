<!-- standard-ai-workflow-kit: v1.4.0 -->

# 어댑터 설계서 — 공통 세션 계약 (M0 WBS 0.1.2~0.1.5)

- 문서 목적: 하네스 어댑터의 공통 계약(인터페이스·상태·에러 모델), capability 플래그, 툴콜 정규화 매핑, 승인 흐름을 확정한다. FR-1 의 설계 구체화.
- 상태: approved (v1, 2026-08-25 사용자 승인)
- 최종 수정일: 2026-08-25
- 입력: [FR-1](../requirements/fr1-harness-sessions.md), [grok 경로 비교·실측](../reference/grok-integration-paths.md), [하네스 인터페이스 조사](../reference/harness-interfaces.md), paseo 패턴(분석 문서 매개 — 코드 참조 금지)
- 확정 전제: grok 는 ACP 경로 (2026-08-25 승인). 시그니처는 설계 수준 TypeScript — 구현 시 세부 조정 허용, 의미 변경은 본 문서 개정 필요.

## 1. 계약 개요 (0.1.2)

어댑터는 2-인터페이스 + 이벤트 유니온으로 데몬과 만난다. 전송(JSONL RPC / ACP)은 어댑터 내부에 숨는다.

```ts
// ── 팩토리: 하네스 종류당 1개 ──────────────────────────────
interface AgentAdapter {
  readonly id: HarnessId;                    // 'pi' | 'omp' | 'grok' | 'mock'
  readonly capabilities: CapabilityFlags;    // §2 — 정적 선언 (버전 검증 후 보정 가능)
  /** 번들 내 실행 파일 존재·버전 검증(manifest 대조, FR-1.8). 실패 사유 포함 반환 */
  probe(): Promise<ProbeResult>;             // { available, version, verified, warnings[] }
  createSession(config: SessionConfig): Promise<AgentSession>;
  resumeSession(handle: PersistenceHandle, config: SessionConfig): Promise<AgentSession>;
  listModels(): Promise<ModelInfo[]>;        // 게이트웨이 카탈로그 반영 (FR-2.4)
}

interface SessionConfig {
  cwd: string;
  modelId?: string;
  env: Record<string, string>;               // 데몬이 조립: 게이트웨이 키·오프라인 스위치·GROK_HOME 등 (FR-2.1.4)
  mcpServers?: McpServerConfig[];            // capability 미지원 시 무시 금지 — 명시 에러 (§2 규칙)
  approvalPolicy: 'mediate' | 'auto';        // §4
}

// ── 세션: 대화 1개 ────────────────────────────────────────
interface AgentSession {
  readonly sessionId: string;                // 데몬 부여 ID (네이티브 ID 는 핸들에)
  startTurn(prompt: string): Promise<{ turnId: string }>;
  subscribe(listener: (e: AgentEvent) => void): Unsubscribe;
  interrupt(): Promise<void>;                // 멱등 (FR-1.6)
  respondToPermission(requestId: string, outcome: PermissionOutcome): Promise<void>;
  getPendingPermissions(): Promise<PermissionRequest[]>;
  setModel?(modelId: string): Promise<void>; // capability: modelSwitch
  describeHandle(): PersistenceHandle;       // { harness, nativeHandle, metadata } (FR-1.3.2)
  close(): Promise<void>;                    // 프로세스 정리, 세션은 재개 가능 상태로 (closed)
}
```

- **turn_started 는 데몬(세션 매니저)이 발행**하고 어댑터는 하네스 유래 이벤트만 올린다 (FR-1.4).
- 에러 모델: 어댑터는 `AdapterError { kind: 'spawn'|'protocol'|'auth'|'model'|'interrupted'|'unknown', retriable, nativeDetail }` 로 분류해 던진다. 프로세스 비정상 종료는 예외가 아니라 `session_status_changed(error)` 이벤트.
- 상태 모델은 FR-1.3.5 (`initializing → idle ⇄ running → closed`, +error) — 상태 전이는 데몬 소유, 어댑터는 신호만.

## 2. Capability 플래그 (0.1.3)

| 플래그 | pi | omp | grok(ACP) | 근거 |
|---|---|---|---|---|
| `streaming` (텍스트 델타) | ✓ | ✓ | ✓ (agent_message_chunk) | 실측·조사 |
| `reasoningStream` | ✓ | ✓ | ✓ (agent_thought_chunk) | 조사 |
| `sessionResume` | ✓ (세션 파일) | ✓ (세션 파일 + 리플레이 드롭 필요) | ✓ (session/load — 실측 loadSession:true) | 실측 |
| `runtimePermission` (런타임 승인 중재) | ✓ | **✗ 1차** (`--approval-mode` 고정 — §4) | ✓ (request_permission) | 결정 §4 |
| `modelSwitch` (세션 중 전환) | ✓ (set_model) | ✓ (set_model) | ✓ (session/set_model — 실측) | 실측 |
| `mcpInjection` (세션 단위 주입) | ✓ (`--mcp-config`) | ✗ (host tools 로 대체) | ✓ (session/new mcpServers) | 조사 |
| `nativeToolRegistration` | ✗ | ✓ (set_host_tools) | ✗ | 조사 |
| `steering` (실행 중 조종) | ✗ | ✓ (steer) | ✗ (확인 안 됨) | 조사 |
| `usageReporting` | ✓ | ✓ | ✓ (turn_completed usage — 실측) | 실측 |
| `compaction` | ✗ | ✓ (compact) | ✓ (/compact 커맨드) | 조사 |

규칙:
- UI 는 플래그로 기능 노출/숨김. **미지원 기능 호출은 silent no-op 금지** — `AdapterError('unsupported')`.
- 플래그는 정적 선언이 기본, `probe()` 가 버전에 따라 하향 보정 가능 (상향 금지).
- 플래그 추가는 optional 로만 (프로토콜 진화 규칙과 동일).

## 3. 툴콜 정규화 매핑 (0.1.4)

중립 분류: `shell | read | edit | write | search | fetch | sub_agent | plan | other` (FR-1.2.5).

| 중립 | pi/omp (네이티브 툴명) | grok ACP (`tool_call.kind` 기반) |
|---|---|---|
| shell | bash / run 계열 | `execute` |
| read | read_file / read | `read` |
| edit | edit / hashline-edit(omp) | `edit` |
| write | write_file / create | `edit`(신규 파일 포함 시) — rawInput 경로 존재 여부로 write 세분 |
| search | grep / glob / find 계열, omp semantic 검색 | `search` |
| fetch | fetch / web 계열 | `fetch` |
| sub_agent | omp 서브에이전트 이벤트 | (미확인 — other 로 통과 후 실측 보정) |
| plan | plan 모드 산출 | `think` / plan 업데이트 |
| other | 매핑 불가 전부 — **원본 페이로드 보존, 드롭 금지** | `other`, `move`, `delete`(→ write 로 승격 검토) |

- 매핑표는 어댑터별 데이터 테이블로 구현(코드 분기 최소화). 미지 툴명은 `other` + 원본 보존.
- grok ACP 는 kind 를 프로토콜이 제공하므로 매핑 비용 최소. pi/omp 는 툴명 문자열 테이블 — 버전 드리프트에 대비해 관대 매핑.
- `delete`/`move` 의 중립 분류 승격 여부는 M1 mock·pi 구현에서 UI 요구 확인 후 확정 (개정 포인트로 기록).

## 4. 승인 흐름 (0.1.5)

중립 모델:

```ts
interface PermissionRequest {
  requestId: string;
  kind: 'shell' | 'file_write' | 'fetch' | 'mcp' | 'other';
  summary: string;              // UI 1줄 표시용
  detail: unknown;              // 원본 (펼침 표시)
  options: PermissionOption[];  // { optionId, label, kind: 'allow_once'|'allow_always'|'reject_once'|'reject_always' }
}
type PermissionOutcome = { optionId: string } | { cancelled: true };
```

하네스별 배선:

- **pi**: JSONL RPC 승인 요청 ↔ 중립 모델 직접 매핑. 옵션은 allow_once/reject_once 기본.
- **omp — 1차 결정: 런타임 중재 포기, `--approval-mode` 고정** (`runtimePermission: false`). 근거: rpc-ui 모드의 승인이 범용 `extension_ui_request` 다이얼로그로 도착해 텍스트 휴리스틱 파싱이 필요(취약, paseo 도 동일 문제). 세션 생성 시 approvalPolicy 를 spawn 인자로 번역: `mediate → --approval-mode always-ask 불가하므로 write`(보수 프리셋), `auto → yolo`. **`extension_ui_request` 파싱 채택은 보류** — omp 가 전용 승인 프레임을 제공하면 재검토 (COMPAT 여지로 기록).
- **grok**: ACP `session/request_permission` 의 options 를 그대로 중립 옵션으로 투영 (kind 4종). `allow_always` 의 영속 범위(세션 vs 홈)는 잔여 실측 — 영속이 홈 단위면 GROK_HOME 격리 덕에 번들 데이터로 한정됨.
- 공통: 미응답 요청은 어댑터가 보관, `getPendingPermissions()` 로 재조회 (FR-1.5). `auto` 정책은 명시적 opt-in (FR-3.4.3)이며 감사 로그에 남긴다.

## 5. 전송 계층 배치

```
daemon/adapters/
├── contract.ts        # §1 인터페이스 + 이벤트 (protocol 패키지의 이벤트 스키마 재사용)
├── jsonl-rpc/         # pi·omp 공용 base: spawn+ndjson framing, id 상관, 타임아웃
│   ├── pi.ts          # pi --mode rpc
│   └── omp.ts         # omp --mode rpc-ui: v2 협상 + rpc_chunk 청킹(64MiB), 리플레이 드롭
├── acp/               # ACP 공용 클라이언트 (JSON-RPC/ndjson, initialize·session/*)
│   └── grok.ts        # GROK_HOME 격리, session/set_model, x.ai/* 확장은 optional 처리
└── mock.ts            # 전 계약 구현 (프로세스 없음) — 계약 테스트·UI 개발용 (FR-1 수용 기준의 기준점)
```

- ACP 클라이언트는 grok 전용으로 시작하되 **표준 부분(x.ai/* 제외)을 분리**해 두면 이후 ACP 하네스(gemini cli 등)가 훅 주입만으로 편입 가능 — 단 1차 범위에선 분리만 하고 일반화 구현은 하지 않는다 (과설계 방지).

## 6. 잔여 실측 → 구현 전 확인 (grok-integration-paths §3 잔여와 동일)

session/load replay 방식, request_permission options 실구성·allow_always 영속, cancel 후 상태 일관성, SIGTERM 세션 저장, omp v2 청킹 실동작. — M1/M2 각 어댑터 구현 첫 태스크에 편입.
