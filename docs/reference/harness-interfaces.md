<!-- standard-ai-workflow-kit: v1.4.0 -->

# 확장 타깃 하네스 인터페이스 조사 — oh my pi / grok build / antigravity

- 문서 목적: paseo가 다루지 않(거나 기본 비활성인) 확장 타깃 하네스 3종의 프로그래매틱 통합 인터페이스를 조사해 custom-harness 어댑터 설계의 근거로 삼는다.
- 조사일: 2026-08-24 (웹 조사 + paseo 소스 실측)
- 관련 문서: [paseo 구성 상세 분석](./paseo-analysis.md), [CONCEPT](../CONCEPT.md)

## 0. 결론 요약

| 하네스 | 래핑 판정 | 주 통합 경로 | 비고 |
|---|---|---|---|
| **oh my pi** (`omp`) | **가능 (실증됨)** | `omp --mode rpc-ui` + stdio JSONL RPC | paseo에 어댑터 존재. **pi 어댑터와 전송 계층 공유 가능** |
| **grok build** (`grok`) | **가능** | headless `grok -p` + streaming-json, 또는 ACP `grok agent stdio` | Claude Code/Codex와 동급 통합 표면 |
| **antigravity** (`agy`) | **조건부 가능** | CLI headless `agy -p` + stream-json (IDE 자체는 불가) | 네이티브 ACP 없음(요청 이슈 open). 대안: Gemini CLI(`gemini --acp`) |

세 도구 모두 CLI 래핑으로 통합 가능하며, 1차 타깃(claude/codex/pi) 어댑터 설계가 그대로 확장된다. 특히 **omp는 pi의 포크라서 별도 어댑터가 아니라 pi 어댑터의 확장판**으로 구현하는 것이 맞다.

## 1. Oh My Pi (omp)

### 정체

- badlogic(Mario Zechner)의 **pi(pi-mono) 포크**. 개발자 Can Bölük(can1357) / Stencil Labs. MIT 라이선스.
- 배포: npm `@oh-my-pi/pi-coding-agent`(bin `omp`), Homebrew, `omp.sh/install`. 릴리스 주기가 매우 빠름(주당 수 회, 2026-08-24 기준 v18.0.4).
- pi 대비 확장: hashline 편집, LSP/DAP, 지속형 REPL, 브라우저 자동화, 서브에이전트, plan 모드, 메모리, 네이티브 호스트 툴 등.

### 통합 인터페이스 (paseo 어댑터 실측)

- **Spawn**: `omp --mode rpc-ui [--approval-mode yolo|write|always-ask] [--model] [--thinking] [--session <file>|--no-session]`. 최소 지원 버전 16.3.9.
- **프로토콜**: stdio 위 JSONL RPC. 기동 시 `ready` 핸드셰이크(protocol v2 협상), 요청 `id` 상관, 응답 타임아웃 30초. **v1은 라인당 1MiB 한도 → v2는 `rpc_chunk` 청킹(64MiB)** — 청킹 미구현 시 큰 응답(`get_available_models`)이 깨짐.
- **RPC 명령**: `prompt`, `abort`, `steer`(진행 중 조종), `follow_up`, `branch`(대화 되감기), `compact`, `get_state`, `set_model`, `set_thinking_level`, `set_host_tools`, `handoff` 등.
- **이벤트**: `agent_start → turn_start → message_update(text_delta/thinking_delta) → tool_execution_* → agent_end` + 서브에이전트 3종, auto-retry, goal 등.
- **세션 재개**: 세션 파일(`~/.omp/agent/sessions`) 경로를 핸들로 저장 → `--session <file>` 재spawn. 재개 시 과거 이벤트 리플레이를 드롭하는 처리 필요.
- **권한**: rpc-ui 모드에서 승인이 전용 프레임이 아니라 범용 `extension_ui_request`(select 다이얼로그)로 도착 — paseo는 다이얼로그 텍스트를 휴리스틱 파싱(취약 지점). 무인 실행이면 `--approval-mode yolo`가 단순.
- **네이티브 호스트 툴**: `set_host_tools`로 JSON Schema 툴 등록 → `host_tool_call`/`host_tool_result` 왕복. MCP 없이 오케스트레이터 툴 주입 가능 (paseo는 `supportsMcpServers: false` + `supportsNativePaseoTools: true`로 선언).
- **ACP**: `omp acp` 서브커맨드도 존재하나 paseo는 기능 커버리지가 넓은 자체 rpc-ui를 선택.

### pi와의 겹침 — 어댑터 재사용성 매우 높음

paseo의 `providers/pi/`와 `providers/omp/`는 spawn 인자·전송(`JsonlRpcProcess` 공유)·메시지 스키마가 거의 동일하다(omp가 pi의 RPC 모드를 상속). 차이는 omp 확장분(v2 청킹, host tools, 서브에이전트/branch/steer, approval-mode)뿐. **공용 base(pi 계열 JSONL RPC) + provider별 확장 테이블**로 설계하는 것이 paseo가 실제 취한 구조.

주의점: 빠른 릴리스 주기 → 관대한 스키마 파싱(`.passthrough()`)과 버전 폴백(COMPAT)이 필수. paseo가 omp를 기본 비활성으로 둔 것도 이 호환성 리스크 때문으로 추정.

## 2. Grok Build (grok)

### 정체

- xAI의 공식 터미널 에이전틱 코딩 CLI (Rust TUI). 2026-05 베타 → 2026-07 오픈소스화(Apache 2.0, `xai-org/grok-build`) → 2026-08 v1.0. 기본 모델 grok-4.6.
- **혼동 주의**: 커뮤니티 `superagent-ai/grok-cli` 등 비공식 도구 다수와 바이너리명(`grok`)이 충돌 — 어댑터에서 절대 경로/`grok --version` 검증 필요.
- 2026-07 리포지토리 클라우드 무단 업로드 논란 이력 있음 — 민감 코드베이스 적용 시 데이터 정책 확인.

### 통합 인터페이스

- **Headless**: `grok -p "<prompt>"` + `--output-format streaming-json`(NDJSON 이벤트) — 공식 문서 확인. Claude Code의 `-p --output-format stream-json`과 사실상 동형.
- **세션**: `--resume <id>`, `--continue`, `--session-id <id>`, `--fork-session`.
- **ACP**: `grok agent stdio` (JSON-RPC over stdio) — 공식 지원. ACP 어댑터 경로로도 통합 가능.
- **권한/샌드박스**: `--always-approve`(`--yolo`), `--allow/--deny <RULE>`, `--sandbox <off|workspace|devbox|read-only|strict>`.
- **MCP**: 네이티브 지원 (`grok mcp add/...`, `.mcp.json` 자동 인식).
- **인증**: 브라우저 OAuth → `~/.grok/auth.json` 캐시 (SuperGrok/X Premium+ 구독 필요), 또는 `XAI_API_KEY`. paseo도 quota-fetcher에서 이 auth.json과 `cli-chat-proxy.grok.com/v1/billing`을 이미 참조.
- **SDK**: 공식 SDK 없음 — CLI/ACP 래핑이 전부.

주의: 세부 플래그 상당수는 서드파티 치트시트 출처 — 구현 전 `grok --help` 실측 검증 필요.

## 3. Antigravity (agy)

### 정체 (2026-08 기준)

- 2025-11 "에이전틱 IDE" 단일 제품 → **2026 I/O에서 Antigravity 2.0으로 개편, 4개 표면**: 데스크톱 앱(2.0, 커맨드 센터) / IDE(VS Code 포크) / **CLI `agy`**(Go, v1.1.17) / **Python SDK**(`pip install google-antigravity`, v0.1.13).
- 모델: Gemini 3.5 Flash·3.1 Pro 계열 + Claude Sonnet/Opus 4.6 + gpt-oss-120b (멀티모델). Individual 무료 티어 존재(rate limit), 크레딧 기반.

### 통합 인터페이스

- **CLI headless** (공식 문서 확인, Claude Code와 거의 동형): `agy -p` + `--output-format text|json|stream-json`, **`--input-format stream-json`으로 단일 프로세스 멀티턴 가능**, `--continue`/`--conversation <id>` 재개, `--json-schema` 구조화 출력, `--dangerously-skip-permissions`/settings.json 권한 규칙/`--sandbox`, `--model`/`--effort`/`--agent`, MCP 지원.
- **ACP**: `agy` 네이티브 ACP 없음(요청 이슈 open). Zed 레지스트리에 `antigravity-acp` 항목과 커뮤니티 어댑터(jiridanek/agy-acp)가 있으나 공식 여부 확인 불가.
- **SDK**: 로컬 `Agent` 런타임(커스텀 툴, 훅, 서브에이전트) — 단 IDE/Agent Manager를 원격 조종하는 게 아니라 **별도 로컬 런타임**. IDE를 외부에서 제어하는 공개 인터페이스는 없음.
- **인증**: 대화형 1회 로그인 후 캐시 자격증명 — 완전 무인 프로비저닝은 별도 고려 필요.
- **paseo 실측**: paseo의 antigravity 연동은 "에디터로 열기" 딥링크뿐(에이전트 제어 아님). provider 매니페스트에 antigravity/gemini 항목 없음.

### 대안: Gemini CLI

ACP 표준 통합이 목표라면 현시점 최선은 **Gemini CLI**(`google-gemini/gemini-cli`, 활성 유지): `gemini -p` headless + **네이티브 ACP 모드 `gemini --acp`**(JSON-RPC 2.0/stdio, `newSession`/`loadSession` 세션 재개, MCP 전달 지원). Antigravity는 headless 어댑터로 편입하고, ACP가 공식화되면 승격하는 2단계 전략이 자연스럽다.

## 4. custom-harness 어댑터 전략 시사점

1. **어댑터 계보가 3갈래로 정리된다**:
   - *pi 계열 JSONL RPC*: pi → omp (공용 base + 확장 테이블)
   - *Claude Code 계열 headless stream-json*: claude → grok build, antigravity (프롬프트/이벤트 NDJSON 패턴 동형)
   - *ACP*: grok build(공식), gemini cli(공식), omp(보조), antigravity(미래) — 범용 ACP 어댑터 하나로 수렴 가능
2. **모든 확장 타깃이 세션 재개·권한 플래그·MCP(또는 대체 수단)를 갖췄다** — paseo의 `AgentClient`/`AgentSession` + capability 플래그 모델이 확장 타깃에도 그대로 유효함을 확인.
3. **공통 리스크**: 빠른 릴리스 주기(omp), 서드파티 정보 의존(grok 플래그), 무인 인증(antigravity). 어댑터에 버전 검증 + 관대한 파싱 + COMPAT 정책을 처음부터 설계에 포함할 것.
