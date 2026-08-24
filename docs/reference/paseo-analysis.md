<!-- standard-ai-workflow-kit: v1.4.0 -->

# Paseo 구성 상세 분석

- 문서 목적: 레퍼런스 프로젝트 paseo(getpaseo/paseo)의 아키텍처를 상세 분석해 custom-harness 설계의 기반 자료로 삼는다.
- 분석 대상: `~/repos/paseo` (shallow clone, v0.5.2, AGPL-3.0-or-later)
- 상태: done (2026-08-24 분석 완료)
- 관련 문서: [CONCEPT](../CONCEPT.md), [PURPOSE](../../ai-workflow/memory/active/PURPOSE.md)
- 분석 방법: 4개 병렬 탐색 (서버·하네스 / 프로토콜·릴레이 / UI·CLI / 플러그인·인프라). 파일 경로는 paseo 저장소 루트 기준 상대경로.

## 1. 한눈에 보기

**Paseo = 데몬(서버) 중심 아키텍처.** 로컬 머신에서 Node 데몬이 코딩 에이전트들을 프로세스로 관리하고, 모든 UI(모바일/웹/데스크톱/CLI)는 WebSocket 클라이언트로 데몬에 붙는다.

```
Mobile(Expo) │ Web │ Desktop(Electron) │ CLI          ← 전부 @getpaseo/client 로 통신
      └──────────────┬───────────────────┘
   [A] 직접 TCP  [B] unix socket/named pipe  [C] 릴레이(E2EE)
                     │
              Daemon (packages/server, Node 22)
                     │  AgentClient / AgentSession 공통 인터페이스
   Claude Code │ Codex │ Copilot(ACP) │ OpenCode │ Pi │ OMP │ 커스텀 ACP
```

11개 npm workspace 모노레포 (TypeScript, React 19, Zod v4):

| 패키지 | 역할 |
|---|---|
| `protocol` | 와이어 스키마 단일 소스 (Zod). 의존성은 zod 하나뿐 |
| `client` | 클라이언트 SDK. 고수준 `PaseoClient` + 저수준 `DaemonClient` |
| `server` | 데몬 본체. 하네스 래핑·세션·터미널·git·플러그인·음성 전부 |
| `app` | Expo 단일 코드베이스 — iOS/Android/웹/Electron 렌더러 겸용 |
| `desktop` | Electron 셸 (렌더러 코드 없음, 데몬 수명주기 관리) |
| `cli` | Commander 기반 CLI (`paseo run/ls/attach/...`) |
| `relay` | E2EE 릴레이 (제로지식 바이트 파이프) |
| `plugin` | 플러그인 SDK |
| `highlight` | Lezer 기반 구문 강조 (RN/웹 공용) |
| `expo-two-way-audio` | AEC 지원 양방향 오디오 네이티브 모듈 (음성 대화용) |
| `website` | paseo.sh (TanStack Start + Cloudflare Workers) |

## 2. 하네스 추상화 계층 (가장 중요한 참고 대상)

### 2.1 공통 계약

`packages/server/src/server/agent/agent-sdk-types.ts` (775줄)가 추상화의 단일 소스. 인터페이스 2개가 축이다:

- **`AgentClient`** — 프로바이더 팩토리: `createSession(config, launchContext?, options?)`, `resumeSession(handle, ...)`, `fetchCatalog(...)` (모델+모드 단일 발견 API), `isAvailable(signal?)`
- **`AgentSession`** — 실행 중인 대화 1개: `startTurn(prompt, options) → {turnId}`, `subscribe(cb)`, `streamHistory()`, `getPendingPermissions()`, `respondToPermission()`, `interrupt()`, `close()`, `describePersistence()` + 선택 메서드 `steerActiveTurn`, `tryHandleOutOfBand`, `setModel`, `revert*` 등

부속 타입:
- `AgentCapabilityFlags` — `supportsStreaming`, `supportsSessionPersistence`, `supportsDynamicModes`, `supportsMcpServers`, `supportsRewind*` 등. 하네스별 기능 편차를 플래그로 협상.
- `AgentStreamEvent` — 프로바이더 중립 이벤트 유니온: `turn_started/completed/failed/canceled`, `timeline`, `permission_requested/resolved`, `usage_updated`, `mode_changed`, `attention_required`, `provider_subagent` 등.
- `AgentTimelineItem` — `user_message / assistant_message / reasoning / tool_call / todo / error / compaction`.
- `ToolCallDetail` — 네이티브 툴을 `shell | read | edit | write | search | fetch | sub_agent | plan | ...`으로 정규화 (프로바이더별 `tool-call-mapper.ts`).
- `AgentPersistenceHandle` — `{provider, sessionId, nativeHandle?, metadata?}`. 재개용 핸들.

### 2.2 통합 패턴 2가지 + 어댑터별 전송 방식

**핵심 발견: 하네스마다 전송 방식이 전부 다르고, paseo는 이를 하나의 인터페이스로 흡수한다.**

| 하네스 | 파일 | 전송 방식 |
|---|---|---|
| Claude Code | `providers/claude/agent.ts` | **SDK** (`@anthropic-ai/claude-agent-sdk`의 `query()`), spawn만 자체 `spawnProcess`로 대체 |
| Codex | `providers/codex-app-server-agent.ts` (235KB) | **CLI spawn + 자체 JSON-RPC(stdio)** (`codex app-server`) |
| Copilot | `providers/copilot-acp-agent.ts` | **ACP** (`copilot --acp`, `@agentclientprotocol/sdk`, ndjson/stdio) |
| OpenCode | `providers/opencode-agent.ts` (172KB) | **로컬 HTTP 서버** (`opencode serve` spawn 후 REST + SSE) |
| Pi | `providers/pi/agent.ts` | **CLI spawn + JSONL RPC(stdio)** (`pi --mode rpc`, 공용 `JsonlRpcProcess`) |
| OMP (Oh My Pi) | `providers/omp/agent.ts` | Pi와 동일 전송 (`omp --mode rpc-ui`), Paseo 툴 네이티브 등록 지원 |
| Cursor/Kimi/Kiro/Trae | `*-acp-agent.ts` | `GenericACPAgentClient` 서브클래스, config `extends: "acp"`로만 활성화 |

통합 패턴은 둘로 정리된다 (`docs/providers.md` "Two Integration Patterns"):
1. **ACP 어댑터** — `ACPAgentClient` 추상 클래스(`providers/acp-agent.ts`, 118KB) 상속. 프로세스 spawn, 세션 관리, 스트리밍, 권한, 파일 IO, 모델/모드 발견을 베이스가 다 처리하고, 서브클래스는 15개 남짓의 optional 훅(`sessionResponseTransformer`, `modeIdTransformer`, `providerModeWriter` 등)만 주입.
2. **Direct 어댑터** — `AgentClient`/`AgentSession` 직접 구현 (Claude/Codex/OpenCode/Pi). 참조 구현은 `mock-load-test-agent.ts`(프로세스 없이 전체 계약 구현).

### 2.3 레지스트리와 확장 포인트

`packages/server/src/server/agent/provider-registry.ts` (934줄):
- `PROVIDER_CLIENT_FACTORIES: Record<string, ProviderClientFactory>` — 등록 지점.
- 프로바이더 매니페스트는 **protocol 패키지**에 있음 (`packages/protocol/src/provider-manifest.ts`): 빌트인 id `claude, codex, copilot, opencode, pi, omp` + dev용 `mock, mock-slow`.
- **코드 없는 확장**: `config.json`의 `agents.providers.<id>`에 `extends: "claude"|"acp"|...` + `command`/`env`/`models` 오버라이드로 파생 프로바이더 생성 (`addDerivedProviders()`).

새 하네스 추가 절차(ACP 기준 6단계): ① 어댑터 클래스 → ② 매니페스트 등록 → ③ 팩토리 등록 → ④ 앱 아이콘 → ⑤ E2E 설정 → ⑥ typecheck.

### 2.4 세션 오케스트레이터: AgentManager

`agent/agent-manager.ts` (4,953줄). 상태 모델: `initializing → idle ⇄ running → (error) → closed` (closed = 삭제가 아니라 "런타임 없음 + 재개 가능").

설계상 주목할 계약들:
- **`turn_started`는 매니저가 직접 발행** — 클라이언트 낙관적 UI 회수를 보장. 사용자 메시지의 정본 타임라인 행도 매니저가 소유(프로바이더 echo는 identity만 부여).
- **Steering** — `steerActiveTurn`이 `unavailable`을 반환하면 interrupt-and-replace로 폴백. 에러는 폴백하지 않고 표면화.
- **`interrupt()`는 멱등** — 이전 턴이 더 이상 실행될 수 없음이 확정될 때 resolve. 소유권이 불확실하면 reject하고 새 작업 거부(split-brain 방지).
- **승인 흐름** — 네이티브 승인 요청 → `AgentPermissionRequest` 정규화 → `permission_requested` 이벤트 → 클라이언트 응답 → 어댑터가 네이티브 응답으로 역변환. `followUpPrompt`(예: Codex plan 승인 → 구현 시작) 지원.
- **영속화** — `$PASEO_HOME/agents/{cwd}/{agent-id}.json` + `AgentPersistenceHandle`로 데몬 재시작 후 재개.
- 헬퍼 프로세스(OpenCode 서버 등)는 `ManagedProcessRegistry`에 PID 원장 기록, 부팅 시 `reapStale()`.

### 2.5 역방향 툴 표면 (에이전트 → paseo)

에이전트가 paseo 자체를 제어하는 40여 개 툴 (`agent/tools/paseo-tools.ts`, 3,217줄): `create_agent`, `wait_for_agent`, `respond_to_permission`, `create_workspace`, `create_terminal`, 스케줄 CRUD 등. 정본은 `PaseoToolCatalog`이고 **MCP(HTTP `/mcp/agents`)는 폴백 어댑터** — 네이티브 등록을 지원하는 프로바이더(OMP)는 MCP 없이 직접 등록. 이것이 멀티 에이전트 오케스트레이션(에이전트가 에이전트를 만드는)의 기반.

별도로 `terminal/agent-hooks/`는 **사용자가 터미널에서 직접 띄운** Claude/Codex/OpenCode CLI를 감지하는 경로 (각 CLI 훅 설정에 paseo 훅 설치 → `POST /api/terminal-activity`).

## 3. 통신 계층

### 3.1 프로토콜 (packages/protocol)

- **Zod v4 단일 소스**, 런타임 의존성 zod 하나. `messages.ts` 6,904줄에 2계층 봉투: WS 레벨 4종(`ping/hello/session/...`) 안에 세션 레벨 **inbound 189 / outbound 203** 브랜치의 discriminatedUnion.
- **RPC 명명 규약**: 신규는 점 표기 `domain.namespace.verb.request/.response`, `requestId`로 상관관계.
- **바이너리 프레임**을 같은 소켓에 혼재: 터미널 `[opcode(1B)][slot(1B)][payload]`, 파일 전송 `0x10~0x12`. 터미널 ID를 1바이트 slot으로 다중화.
- **AOT 검증**: 인바운드 검증 코드를 `zod-aot`로 빌드 시 생성. Hermes(모바일)에서 353KB 페이로드 파싱 10.9ms→2.5ms. 이 때문에 와이어 스키마에 `.transform()/.catch()/.preprocess()` 금지라는 순수성 규칙이 강제됨.

### 3.2 버전 전략 — 와이어 버전을 올리지 않는다

`protocolVersion: 1` 고정. 대신 3중 메커니즘:
1. **클라이언트 capability** (hello의 `capabilities`) — 데몬이 구클라이언트용 다운그레이드 인코딩 선택.
2. **데몬 feature 플래그** (`server_info.features.*`, 60개+) — 클라이언트는 단일 지점에서 검사 후 없으면 "호스트를 업데이트하세요". **fallback 경로 금지**가 규칙.
3. **COMPAT shim** — 모든 호환 코드는 `// COMPAT(name): added in vX, remove after YYYY-MM-DD` 태그 + 만료일. `rg "COMPAT\("`가 곧 정리 백로그.

호환성 원칙: 신규 필드는 반드시 optional, 제거/축소 금지, "6개월 된 앱이 이 메시지를 파싱하는가?"가 판단 기준.

### 3.3 클라이언트 SDK (packages/client)

- 고수준 `createPaseoClient()` — 핸들 패턴 (`agent.send()`, `agent.waitForFinish()`), 저수준 `DaemonClient`(6,244줄) — 189종 RPC 메서드 + 타입 안전 이벤트 구독.
- **트랜스포트 추상화** (`DaemonTransportFactory`): WebSocket / unix socket / named pipe / E2EE 릴레이를 동일 인터페이스로. E2EE는 URL이 릴레이 형식일 때만 자동 래핑.
- 재연결: 지수 백오프(1.5s→30s), 10초 주기 애플리케이션 레벨 ping/pong, 2회 실패 시 소켓 폐기. 끊김 시 **모든 대기자를 즉시 실패**시키고, 재연결 시 구독(checkout diff/터미널/파일) 자동 복원. 연결 중 요청은 큐잉 후 flush.
- 인증: `Authorization: Bearer` + 브라우저용 `Sec-WebSocket-Protocol: paseo.bearer.<pw>` 이중 경로 (브라우저 WS는 커스텀 헤더 불가).
- 상태 동기화(커서/tombstone 리컨실, 오프라인 replica cache)는 SDK가 아니라 **앱 계층 소유** (`app/src/runtime/directory-sync/`, `replica-cache/`).

### 3.4 릴레이 (packages/relay) — 원격 접속

- **제로지식 바이트 파이프**: 릴레이는 Paseo 스키마 의존성이 전혀 없고(tweetnacl, ws뿐) 바이트만 포워딩.
- **E2EE**: Curve25519 ECDH + XSalsa20-Poly1305. 데몬 장기 공개키는 **QR/페어링 링크(URL 프래그먼트)로 대역 외 전달** — 릴레이는 키 배포에 관여하지 않음. 재핸드셰이크 공격(다른 키로 hello) 시 1008로 종료.
- v2 프로토콜: serverId당 컨트롤 소켓 1개 + 클라이언트별 전용 데이터 소켓(각각 독립 세션 키). 데몬이 릴레이로 **아웃바운드** 연결하므로 포트 개방 불필요.
- 셀프호스팅 가능 (`PASEO_RELAY_ENDPOINT`), 기본 비활성. 프로덕션 릴레이는 별도 레포(Elixir), 모노레포 내 Cloudflare DO 구현은 레거시.

## 4. UI 계층

### 4.1 하나의 앱, 네 개의 플랫폼

`packages/app` 하나가 iOS/Android/웹/Electron 렌더러를 전부 담당 (Expo SDK 54 / RN 0.81 / React 19 / Expo Router 파일 기반 라우팅). 플랫폼 분기는 **런타임 if문 대신 Metro 파일 확장자** (`.web.tsx` / `.native.ts` / `.electron.tsx`)로 빌드타임에 해석 — 예: `voice/audio-engine.native.ts` vs `audio-engine.web.ts`.

상태 관리: Zustand 다층 스토어(세션/레이아웃/패널) + React Query + `HostRuntimeStore`(여러 데몬 동시 연결·재연결 소유). 오프라인 복원은 replica-cache(AsyncStorage/IndexedDB).

### 4.2 데스크톱과 CLI의 관계

- `packages/desktop`에는 **렌더러 React 코드가 없다.** Expo web export를 `paseo://` 커스텀 스킴으로 서빙하는 셸이며, 창·데몬 수명주기·네이티브 브리지만 담당.
- 데몬은 **detached 자식 프로세스**로 spawn (앱이 죽어도 생존). Electron 바이너리를 `ELECTRON_RUN_AS_NODE=1`로 Node 런타임으로 재사용 — 별도 Node 번들 불필요.
- `$PASEO_HOME/paseo.pid`의 `{pid, desktopManaged}` 플래그로 소유권 구분 — 사용자가 직접 띄운 데몬은 건드리지 않음.
- 위임 구조: desktop → (번들된) cli → daemon. CLI는 Docker 스타일 명령 체계 (`paseo run/ls/attach/logs/stop`, `daemon start/pair/stop`, `schedule`, `permit` 등).

### 4.3 멀티 에이전트 UI 패턴 (4축 직교 분해)

1. **호스트 다중화** — 라우트가 `/h/[serverId]/...`로 데몬 스코프. 여러 데몬 동시 연결.
2. **워크스페이스 덱 + 분할 페인 + 탭** — 에이전트도 파일·터미널·브라우저와 동등한 "탭"(13종 탭 타깃). 여러 에이전트 동시 표시 = 여러 agent 탭을 다른 페인에 배치.
3. **사이드바/커맨드 센터** — 상태 버킷별 에이전트 그룹핑, ⌘K로 호스트 횡단 검색.
4. **서브에이전트 트랙** — 부모-자식 팬아웃은 컴포저 위 플로팅 pill 바로 표현. paseo 관리 서브에이전트(완전 대화형)와 프로바이더 네이티브 서브에이전트(읽기 전용)를 구분. 혼합 상태를 "가장 급한 것 하나"로 접지 않고 모든 상태를 각자 카운트로 나열.

특징적 규칙: **탭 닫기 ≠ archive** (루트 에이전트 탭 닫기는 archive, 서브에이전트 탭 닫기는 레이아웃 변경일 뿐).

### 4.4 음성

제품 정체성의 일부 ("voice-controlled development environment"). 딕테이션(STT→컴포저)과 보이스 에이전트(실시간 대화, AEC 필수라 자체 네이티브 모듈 `expo-two-way-audio` vendoring) 두 모드. 서버 측 STT/TTS는 sherpa-onnx 로컬 모델.

## 5. 확장 3축: Skill / MCP / Plugin

paseo는 확장을 서로 겹치지 않는 세 축으로 분리한다. **스킬 = 하네스에게 주는 것(파일 동기화), MCP = 하네스와 주고받는 것(정방향 주입 + 역방향 폴백 툴 표면), 플러그인 = paseo 자신을 바꾸는 것(컴파일 타임 경계 + 프로세스 격리).**

### 5.1 Skill — 에이전트에게 주입하는 지식

- 저장소 `skills/`에 오케스트레이션 스킬 번들(SKILL.md): `paseo`(기반), `paseo-handoff`, `paseo-committee`, `paseo-advisor`, `paseo-help`, `paseo-plugin`.
- 처리 방식은 **파일 동기화**: 빌드 시 데몬 dist에 복사 → 런타임에 `server/orchestration-skills/`가 각 하네스의 스킬 디렉터리(`~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`)로 설치·동기화. paseo가 스킬 실행을 제어하는 게 아니라 하네스들이 각자 읽어간다.
- 선택 상태는 데몬 config(`agents.skills.selection`), 시작 시 자동 업데이트, 중단된 설치 트랜잭션 복구 로직 포함(`orchestration-skills/internal/transaction.ts`).
- 클라이언트 노출: `AgentSkills*` RPC 5종 + `skillManagement` feature 플래그 (설정 UI 토글).
- `paseo-help` 스킬은 런타임에 `https://paseo.sh/llms.txt`를 fetch해 최신 문서를 우선 신뢰 — public-docs가 에이전트의 원격 지식 베이스를 겸함.

### 5.2 MCP — 양방향, 그리고 "폴백"이라는 위치

- **정방향 (에이전트에게 MCP 서버 붙이기)**: `AgentSessionConfig.mcpServers`에 `McpServerConfig`(stdio | http | sse 판별 유니온)로 선언 → 각 어댑터가 하네스 네이티브 형식으로 변환. 지원 여부는 `supportsMcpServers` capability로 협상, claude/codex/opencode만 `supportsExactMcpPreapproval`(MCP 툴 사전 승인) 지원.
- **역방향 (paseo 자신이 에이전트의 툴)**: 데몬이 `/mcp/agents` HTTP 엔드포인트(streamable HTTP)로 MCP 서버가 되어 40여 개 툴 노출(§2.5). 세션 생성 시 `withRuntimePaseoMcpServer()`가 `{type:"http", url:"…/mcp/agents?callerAgentId=<id>"}`를 자동 주입 — 에이전트가 에이전트를 만드는 오케스트레이션의 통로.
- **MCP는 폴백 어댑터**: 정본은 `PaseoToolCatalog`(`agent/tools/types.ts`). 네이티브 툴 등록을 지원하는 하네스(`supportsNativePaseoTools: true`, 현재 OMP)는 MCP를 거치지 않고 `launchContext.paseoTools`로 직접 등록, 중복 주입은 `stripInternalPaseoMcpServer()`로 제거.

### 5.3 Plugin — paseo 자체 확장

- SDK `@getpaseo/plugin`: 확장 포인트 7종 — 서버 RPC 핸들러(`handle`), 전역 서피스, 사이드바 항목, 워크스페이스/에이전트 패널, ⌘K 항목, 컴포저 첨부 소스, 테마.
- **파일명 기반 런타임 경계**: `*.client.tsx` / `*.server.ts` / `*.shared.ts`. 자체 컴파일러(Babel AST + esbuild)가 타깃별 번들 2개를 만들며 반대편 등록 호출을 소스 레인지 단위로 삭제, 교차 import는 컴파일 에러.
- 서버 플러그인은 `child_process.fork` 서브프로세스로 격리 — 각 플러그인이 `ipc://plugin/<id>`로 전용 데몬 세션 보유. 클라이언트 번들은 화이트리스트 모듈(react, zod 등)만 주입되는 `eval`.
- 보안 모델은 샌드박스가 아니라 **신뢰된 코드** — 루트 `pluginsEnabled` 플래그를 사용자 동의 없이 켜지 않는 것이 규칙.

## 6. 개발/배포 인프라

- **스택**: Node 22, TypeScript 5.9 (emit) + tsgo (typecheck), oxlint/oxfmt (oxc 툴체인), vitest, knip, lefthook, patch-package.
- **핵심 서버 의존성**: `@anthropic-ai/claude-agent-sdk`, `@openai/*`, `@opencode-ai/sdk`, `@agentclientprotocol/sdk`(ACP), `@modelcontextprotocol/sdk`(MCP), `node-pty` + `@xterm/headless`(터미널), `express` + `ws`, `zod`, `esbuild`(플러그인 컴파일).
- **배포 4경로**: npm 패키지 7종 / Docker(`ghcr.io/getpaseo/paseo`, 에이전트 CLI는 의도적 미포함 — 확장 Dockerfile 패턴) / Nix(nft 정적 추적으로 데몬 클로저 최소화, NixOS 모듈) / Electron(electron-builder, 단계적 롤아웃).
- **문서 이분법**: `docs/`(기여자·에이전트용, 배포 안 됨, 42개) vs `public-docs/`(사용자용, paseo.sh 발행 + `/llms.txt`로 에이전트 원격 지식 베이스 겸용). CLAUDE.md(=AGENTS.md 심링크)가 문서 인덱스와 강한 규칙(프로토콜 호환 계약, "Integrate, don't append" 등)을 규정.

## 7. 설계 판단 요약 (custom-harness가 배울 것)

1. **데몬 중심 + 얇은 클라이언트.** 하네스 프로세스 관리·상태·영속화는 전부 데몬에, UI는 WS 클라이언트일 뿐. 이 분리가 모바일/원격/멀티클라이언트를 공짜로 만든다.
2. **하네스 추상화는 인터페이스 2개면 충분.** `AgentClient`(팩토리) + `AgentSession`(대화) + capability 플래그. 전송 방식(SDK/stdio RPC/HTTP/ACP)이 제각각이어도 이 뒤로 숨는다.
3. **ACP를 "공통 경로"로, Direct를 "예외 경로"로.** 신규 하네스는 ACP 지원 시 훅 주입만으로 통합. 단, 주력 하네스(Claude/Codex)는 결국 Direct 어댑터가 됨 — 네이티브 기능(steering, rewind, 서브에이전트)을 살리려면 ACP만으로 부족.
4. **프로토콜은 zod 단일 소스 + capability 협상 + COMPAT 만료일.** 와이어 버전을 올리지 않고 진화하는 검증된 전략.
5. **스트림 이벤트·타임라인·툴콜의 프로바이더 중립 정규화**가 UI 재사용의 열쇠. `ToolCallDetail` 정규화 덕에 하네스가 몇 개든 렌더러는 하나.
6. **권한(승인) 흐름을 1급 개념으로.** `permission_requested/resolved` + attention 정책 + 푸시 알림 + 자동 승인(unattended 모드)까지 일관된 파이프라인.
7. **원격 접속은 릴레이 + E2EE + 대역 외 키 교환.** 릴레이 운영자를 신뢰 대상에서 제외하는 구조.
8. **탭/트랙 이중 구조의 멀티 에이전트 UI.** 형제 세션은 공간(페인/탭)으로, 부모-자식은 트랙으로.
9. **확장 3축의 분리 (§5).** 스킬(하네스에게 주는 파일) / MCP(하네스와 주고받는 프로토콜, 폴백) / 플러그인(자기 자신의 확장)을 겹치지 않게 나눈 것 자체가 설계 결정.

## 8. 발견된 문제점 (참고)

- `provider-registry.ts`의 `wrapSessionProvider`/`wrapClientProvider`가 optional 메서드(`steerActiveTurn`, `shutdown`, `listCommands` 등)를 누락 — `extends` 파생 프로바이더에서 steering 등이 조용히 손실.
- `docs/providers.md`의 매니페스트 위치 안내가 stale (실제는 protocol 패키지), CLAUDE.md의 Biome 언급도 stale (실제는 oxfmt).
- `src/tasks/`는 데드 코드. `session.ts` 7,524줄 / `agent-manager.ts` 4,953줄 등 거대 파일 문제는 자체 분해 계획 문서 존재.
- CLI `plugin init`이 SDK 타입 선언을 문자열로 복제 — 타입 3중 중복 드리프트.

## 9. 미해결 질문 (설계 단계로 넘길 것)

- custom-harness의 1차 타깃(claude, codex, pi)은 셋 다 paseo에 Direct 어댑터가 존재 — ACP 우선 전략을 취할지, 처음부터 Direct로 갈지.
- ~~oh my pi, grok build, antigravity의 통합 인터페이스 조사 필요~~ → 조사 완료: [확장 타깃 하네스 인터페이스 조사](./harness-interfaces.md). 셋 다 CLI 래핑으로 통합 가능.
- 데몬/클라이언트 분리 수준 — paseo 수준의 원격/모바일 지원이 목표인지, 로컬 우선인지에 따라 relay 계층 필요성이 갈림.
