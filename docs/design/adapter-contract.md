<!-- standard-ai-workflow-kit: v1.4.0 -->

# 어댑터 설계서 — 공통 세션 계약 (M0 WBS 0.1.2~0.1.5)

- 문서 목적: 하네스 어댑터의 공통 계약(인터페이스·상태·에러 모델), capability 플래그, 툴콜 정규화 매핑, 승인 흐름을 확정한다. FR-1 의 설계 구체화.
- 상태: approved (v1.4, 2026-08-31 — §4 grok 권한 모드 `--permission-mode default` 명시 고정 + 승인 옵션 3종(영속 노출) 재실측(M7 7.2.0b). v1.3: 2026-08-25 사용자 승인 — 개정: §2 grok compaction 1차 하향(/compact 슬래시 커맨드 경로뿐, 계약 메서드 부재) + §4 grok 승인 실측 반영(기본 옵션 2종·거부=턴 완결) + §6 grok 잔여 실측 해소, WBS 2.2 구현 중 발견분. v1.2: §2 omp capability 하향 + §4·§6 omp 실측. v1.1: §2 pi capability 보정 + §4 pi 승인 채널)
- 최종 수정일: 2026-08-31
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
| `mcpInjection` (세션 단위 주입) | **✗ (v1.1 실측 보정)** — pi 0.84.1 에 `--mcp-config` 류 주입 플래그 부재. MCP 는 확장(extension) 경유만 | ✗ (host tools 로 대체) | ✓ (session/new mcpServers) | 실측(0.84.1) |
| `nativeToolRegistration` | ✗ | **✗ 1차 (v1.2 보정)** — 17.3.8 에 `set_host_tools` RPC 실존하나 계약에 등록 경로 없어 보류 | ✗ | 실측(17.3.8) |
| `steering` (실행 중 조종) | ✗ 1차 (v1.1 주기: 0.84.1 에 steer/follow_up RPC 실존 — 계약에 메서드 없어 보류, 도입 시 계약 확장과 함께 상향) | **✗ 1차 (v1.2 보정)** — steer RPC 실존, pi 와 동일 논리로 보류 | ✗ (확인 안 됨) | 실측(0.84.1/17.3.8) |
| `usageReporting` | ✓ | ✓ | ✓ (turn_completed usage — 실측) | 실측 |
| `compaction` | ✗ 1차 (v1.1 주기: 0.84.1 에 compact RPC 실존 — steering 과 동일하게 보류) | **✗ 1차 (v1.2 보정)** — compact RPC 실존, 동일 보류 | **✗ 1차 (v1.3 보정)** — /compact 슬래시 커맨드 경로뿐, 계약 메서드 부재로 보류 | 실측(0.84.1/17.3.8/1.0.5) |

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

- **pi** (v1.1 실측 보정): 전용 승인 프레임이 없다 — 승인·선택은 **`extension_ui_request`(confirm/select) 채널**로 도착하며, 어댑터가 이를 중립 모델로 매핑한다(confirm → allow_once/reject_once 2옵션, select → 옵션 목록 투영). `input`/`editor` 요청은 1차 취소 격하(M2 개정 포인트). 기본 내장 툴 실행 자체에는 승인 게이트가 없음(0.84.1 실측) — 툴 실행 중재 필요 시 pi 확장 훅 도입을 M2 에서 검토.
- **omp — 1차 결정: 런타임 중재 포기, `--approval-mode` 고정** (`runtimePermission: false`). 근거: rpc-ui 모드의 승인이 범용 `extension_ui_request` 다이얼로그로 도착해 텍스트 휴리스틱 파싱이 필요(취약, paseo 도 동일 문제). 세션 생성 시 approvalPolicy 를 spawn 인자로 번역: `mediate → --approval-mode write`(보수 프리셋 — v1.2 보정: `always-ask` 값 자체는 17.3.8 에 실존하나 위 파싱 문제로 채택 보류), `auto → yolo`. **`extension_ui_request` 파싱 채택은 보류** — omp 가 전용 승인 프레임을 제공하면 재검토 (COMPAT 여지로 기록). 구현(2.1.2): 입력성 요청(confirm/select/input/editor)은 취소 응답으로 우아한 격하, 표시성 요청은 무시.
- **grok** (v1.4 실측 보정, M7 7.2.0b): ACP `session/request_permission` 의 options 를 그대로 중립 옵션으로 투영. **권한 모드는 `--permission-mode default` 로 명시 고정**한다 — 지정하지 않으면 grok 이 사용자 환경에서 모드를 주워오고(Claude 호환 import), auto 모드는 승인 요청 **없이** 툴을 거절해 승인 채널이 조용히 사라진다(실측). 모드 행렬상 MCP 툴과 내장 파괴적 툴이 **동시에** 승인 대상인 모드는 `default` 뿐이다. options 는 1.0.5 의 2종에서 **3종**으로 늘었다 — MCP 툴 `always-allow`(`allow_always`)/`allow-once`/`reject-once`, 파일 쓰기 `allow-edits-session`(`allow_always`)/`allow-once`/`reject-once`. 즉 v1.3 의 "`allow_always` 가 노출되면 재실측" 조건이 발동했다: grok 이 ACP 표준 `kind` 를 정확히 보내 매핑 오류는 없고, 영속 범위는 격리 `GROK_HOME` 안으로 한정되지만 **영속 승인의 UI 표기·감사 기록은 FR-1.5 후속 과제**로 남는다. 상세 [하네스 MCP 지원 실측 §3.3](../reference/harness-mcp-support.md). 응답은 `{outcome:{outcome:'selected',optionId}}` / `{outcome:{outcome:'cancelled'}}`. **거부 의미론 주의**: reject-once 는 툴만 실패시키고 턴은 end_turn 으로 완결된다(pi 의 거부=턴 취소와 다름) — 계약 테스트·UI 표시가 이 차이를 전제해야 함.
- 공통: 미응답 요청은 어댑터가 보관, `getPendingPermissions()` 로 재조회 (FR-1.5). `auto` 정책은 명시적 opt-in (FR-3.4.3)이며 감사 로그에 남긴다.

## 5. 전송 계층 배치

```
daemon/adapters/
├── contract.ts        # §1 인터페이스 + 이벤트 (protocol 패키지의 이벤트 스키마 재사용)
├── jsonl-rpc/         # pi·omp 공용 base: spawn+ndjson framing, id 상관, 타임아웃
│   ├── pi.ts          # pi --mode rpc
│   └── omp.ts         # omp --mode rpc-ui: v2 협상 + rpc_chunk 청킹(64MiB), 리플레이 드롭
├── acp/               # ACP 공용 클라이언트 (JSON-RPC/ndjson, initialize·session/*)
│   └── grok.ts        # GROK_HOME 격리, --permission-mode default 고정, session/set_model, x.ai/* 확장은 optional 처리
└── mock.ts            # 전 계약 구현 (프로세스 없음) — 계약 테스트·UI 개발용 (FR-1 수용 기준의 기준점)
```

- ACP 클라이언트는 grok 전용으로 시작하되 **표준 부분(x.ai/* 제외)을 분리**해 두면 이후 ACP 하네스(gemini cli 등)가 훅 주입만으로 편입 가능 — 단 1차 범위에선 분리만 하고 일반화 구현은 하지 않는다 (과설계 방지).

## 6. 잔여 실측 → 구현 전 확인 (grok-integration-paths §3 잔여와 동일)

**grok 실측 확정 (v1.3, WBS 2.2 — grok 1.0.5 + 목 게이트웨이 ACP 프로브, 상세는 [grok-integration-paths §3-1](../reference/grok-integration-paths.md))**: session/load 는 응답 전에 히스토리를 `session/update` 로 리플레이(어댑터 드롭 가드 필요), request_permission options 는 기본 2종(§4), cancel 후 동일 세션 재프롬프트 정상, SIGTERM 시 세션 저장(GROK_HOME/sessions). config.toml 오프라인 스위치 현행 구문·`[models]` 고정·`env_key` 참조도 확정. 잔여는 `--mcp-config` 플래그·`x.ai/session/fork` 시그니처뿐 — 필요 시 후속.

**omp 실측 확정 (v1.2, WBS 2.1 — 공개 소스 can1357/oh-my-pi v17.3.8(MIT) + 바이너리 행동 실측)**:
- v2 청킹 실동작 확인: `ready`(supportedProtocolVersions [1,2], 1MiB/64MiB 한도) → `negotiate_protocol` 요청/응답 → 초과 프레임은 `rpc_chunk`(chunkId·index·count·byteLength·base64 256KiB, 연속·비인터리브) 수신. **stdin(송신) 방향은 서버에 재조립기가 없어 1MiB 라인 한도가 하드 리밋** — 어댑터는 초과 송신을 명시 에러 처리.
- 재개(`--session <file>`): 17.3.8 에서 기동 시 이벤트 리플레이 **없음**(실물 2턴 실측). agent_end.messages 는 당회 런 분량만 포함. 리플레이 드롭 가드는 버전 드리프트 방어용으로 유지.
- 격리 env: omp 도 pi 와 동일한 `PI_CODING_AGENT_DIR` 지원 (dirs.ts 실측) — credential-injection-design §2 의 "M2 확인" 해소.
- models.yml `apiKey` 는 **bare env 변수명**으로 해석(`resolveConfigValue` — pi 의 `$VAR` 표기와 다름). 오프라인 차단은 `PI_OFFLINE` 미지원이라 config.yml 프리셋(startup.checkUpdate·marketplace.autoUpdate·dev.autoqa)으로 수행.
