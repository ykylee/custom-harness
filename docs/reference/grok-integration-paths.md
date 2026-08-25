<!-- standard-ai-workflow-kit: v1.4.0 -->

# grok build 통합 경로 비교 조사 (M0 WBS 0.1.1)

- 문서 목적: grok build 를 데몬이 래핑하는 두 경로 — headless(streaming-json) vs ACP(`grok agent stdio`) — 의 기능 커버리지 비교와 잠정 결론. 어댑터 설계서(0.1.2)의 입력.
- 조사일: 2026-08-25 (웹 조사 — 공식 문서·ACP 스펙·실 클라이언트 구현) + **동일 자로 로컬 스파이크 실측 수행 (§3)**
- 관련: [ROADMAP M0](../roadmap/m0-design.md) 0.1.1, [FR-1.2.4](../requirements/fr1-harness-sessions.md)

## 0. 잠정 결론

**ACP 경로(`grok agent stdio`)를 1순위로 권장.** headless 는 폴백/단순 배치용.

| 항목 | A. headless (`grok -p --output-format streaming-json`) | B. ACP (`grok agent stdio`) |
|---|---|---|
| 승인 흐름 | **대화형 승인 불가** — `--allow/--deny` 사전 규칙 또는 `--yolo` 뿐, 미승인 툴은 실패 (공식 명시) | **표준 지원** — `session/request_permission` 왕복 (`allow_once/allow_always/reject_once/reject_always`) |
| 멀티턴 | 단일 프로세스 멀티턴 불가 (공식 명시) → 턴마다 재spawn + `--resume` | 장수 프로세스에서 `session/prompt` 반복 |
| 중단 | SIGINT/SIGTERM 로 프로세스 종료 후 재spawn+resume | `session/cancel` → 세션 유지한 채 즉시 재사용 |
| 세션 재개 | `--resume/--continue/--fork-session` (공식) | `session/load` + `x.ai/session/*` 확장 — **initialize 의 loadSession 광고는 실측 필요** |
| 스트리밍 세분성 | thought/text/tool_call(+update)/usage/plan/end 등 NDJSON — **ACP 업데이트의 파생 포맷** | `session/update`(message/thought chunk, tool_call, plan) — A 와 동급 |
| MCP 주입 | 파일 기반만 문서화 (config.toml, `.mcp.json` 호환) | `session/new` 의 `mcpServers[]` 로 **세션 단위 프로그래매틱 주입** |
| 모델 | `-m --model`, `--effort` (호출 단위) | 기동 플래그 전역 — 세션별 오버라이드는 실측 필요 |

권장 근거: 데몬의 핵심 요건인 **런타임 승인 중재(FR-1.5)·멀티턴·즉시 중단(FR-1.6)·MCP 세션 주입**이 모두 ACP 쪽에만 있다. 스트리밍 세분성은 동급이라 headless 의 이점이 아니다.

headless 의 잔여 용도: `--yolo` 배치 실행, `end` 이벤트의 usage 메타 회계 (ACP 경로에서 usage 를 어떻게 받는지는 실측 항목).

## 1. 스파이크 실측 검증 목록 (0.1.1 잔여 — 어댑터 설계 확정 전 필수)

1. `initialize` 응답의 `agentCapabilities.loadSession`·`promptCapabilities` 실측
2. `session/load` 재개 시 과거 대화 replay 방식 + headless 세션과의 상호 재개 호환성
3. `session/request_permission` 의 options 구성·`allow_always` 영속 여부·`--allow/--deny` 규칙과의 상호작용
4. ACP 세션별 모델 오버라이드 지원 여부
5. headless `--mcp-config` 류 호출 단위 주입 플래그 존재 여부 (`grok --help`)
6. `session/cancel` 후 동일 세션 재프롬프트 시 상태 일관성 (partial 툴 결과 처리)
7. `x.ai/session/fork` 등 확장 메서드 시그니처
8. ACP 경로의 usage/비용 메타 수신 형태 (FR-3.7 데이터원)
9. `grok agent stdio` 프로세스 SIGTERM 시 세션 저장 보장 (데몬 셧다운 시나리오)

> 실측 전제: grok build 설치 + 인증(XAI_API_KEY 또는 구독). 사외 개발 환경에서 수행 가능 — 게이트웨이 불필요(로컬 프로토콜 실측이므로).

## 3. 스파이크 실측 결과 (2026-08-25, grok 1.0.5, macOS — 로컬 목 OpenAI 호환 서버 사용)

격리 `GROK_HOME`(auth.json 부재 = 미로그인 콜드 스타트) + `[model.mock]`(base_url=로컬 목 서버, `api_key` 자체 키)로 실측. **커스텀 LLM 연결과 무로그인 동작이 headless·ACP 양쪽에서 확정됐다.**

| # (§1 목록) | 결과 |
|---|---|
| 커스텀 LLM 연결 (전제) | ✅ **확정** — `[model.<name>]` (base_url + api_backend="chat_completions" + api_key) 로 임의 OpenAI 호환 엔드포인트 동작. 요청은 `Authorization: Bearer <자체키>` 로 전송. **xAI 로그인 전혀 불요** (ACP `authMethods` 에도 "api_key/env_key in config.toml" 공식 등재) |
| 1. initialize capability | ✅ `loadSession: true`, `sessionCapabilities: {list, resume, close}`, `mcpCapabilities: {http, sse}`, promptCapabilities.embeddedContext |
| 4. 세션별 모델 오버라이드 | ✅ **`session/set_model` 지원 확인** (`{sessionId, modelId}`) — 커스텀 모델이 ACP `availableModels` 에도 노출되고, set_model 후 `model_changed` 알림 수신 |
| 8. usage 수신 형태 | ✅ `session/prompt` 응답 `_meta.usage` + `_x.ai/session_notification` 의 `response_completed`/`turn_completed`(usage 포함) — FR-3.7 데이터원 성립 |
| 3(부분). 스트리밍 | ✅ `agent_message_chunk` 델타 스트림 수신 확인 (목 서버 SSE → ACP 알림 변환 정상) |

**추가 발견 (설계 반영 필요)**:

- **`[model.*]` 는 글로벌 config 전용** — 프로젝트 `.grok/config.toml` 은 mcp_servers/plugins/permission 만 병합 [공식 05-configuration.md]. 대신 **`GROK_HOME`(홈 전체 격리)·`GROK_CONFIG_PATH`(추가 오버레이 파일)** 환경변수 지원 → **데몬은 사용자의 `~/.grok` 를 건드리지 않고 번들 관리 `GROK_HOME` 격리로 spawn 하는 방식이 최적** (설정 주입 FR-2.1.3 설계 변경 후보)
- **config 스키마 드리프트 실증**: 기존 조사의 `telemetry = false` 는 v1.0.5 에서 파싱 에러(구조체로 변경됨). 오프라인 스위치 3종(auto_update/telemetry/remote_fetch)의 현행 구문 재확인 필요
- **grok 는 런타임에 config.toml 을 재작성**함(`[marketplace]` 블록 자동 추가 확인) — 관리 블록 주입 시 재작성 내성 필요, GROK_HOME 격리 방식이면 무관
- headless 실측 중 **세션 제목 생성 등 보조 호출이 기본 모델 id(`grok-4.6`)로 커스텀 엔드포인트에 전송**됨 — 게이트웨이가 미지의 모델 id 를 거부하면 보조 기능 실패 가능. 기본 모델을 커스텀 모델로 고정하는 설정 확인 필요

**잔여 실측 항목**: §1 의 5(--mcp-config 플래그), 7(fork 시그니처) — 필요 시 후속. 나머지는 §3-1 에서 해소.

## 3-1. 잔여 실측 해소 (2026-08-25, WBS 2.2 — grok 1.0.5, 목 게이트웨이 ACP 프로브)

| # (§1 목록) | 결과 |
|---|---|
| 2. session/load replay | ✅ **load 응답이 오기 전에** 과거 대화가 `session/update` 알림(user/agent_message_chunk·tool_call·turn_completed(usage 포함))으로 리플레이된다. 어댑터는 load 완결까지 대화 이벤트를 드롭해야 함 (구현: suppressReplay 가드) |
| 3. request_permission options | ✅ 기본 권한 모드에서 **allow-once/reject-once 2종만** 노출 (`{optionId, name, kind}`) — allow_always 는 기본 미노출이라 영속 문제 자체가 1차 범위 밖. 응답은 `{outcome:{outcome:'selected',optionId}}` / `{outcome:{outcome:'cancelled'}}`. 요청에 `toolCall{toolCallId,kind,title,rawInput,_meta['x.ai/tool']}` 동봉 |
| 3-보충. 거부 의미론 | ✅ reject-once 는 **툴만 실패시키고 턴은 end_turn 으로 완결** (모델이 거부를 안고 계속) — pi(거부=턴 취소)와 다름, 계약 스위트에 옵션으로 반영 |
| 6. cancel 후 상태 | ✅ `session/cancel`(알림) → 진행 중 prompt 가 `stopReason:'cancelled'` 로 귀결(x.ai turn_completed 알림에 cancellationCategory:MidTurnAbort). **동일 세션 재프롬프트 정상** |
| 9. SIGTERM 세션 저장 | ✅ SIGTERM 시 `GROK_HOME/sessions/<cwd-인코딩>/<sessionId>/` 에 저장 확인 — 재spawn+session/load 재개 성립 |
| config.toml 현행 구문 | ✅ 오프라인 스위치: `[cli] auto_update=false`, `[features] telemetry=false / remote_fetch=false / managed_config=false` (구 top-level `telemetry=` 는 폐기). 보조 호출 유출 방지: `[models] default·web_search` 를 커스텀 모델로 고정. `[model.<id>]` 에 `env_key`(환경변수명 키 참조 — 평문 불요)·`api_backend="chat_completions"` 1.0.5 실기 파싱·동작 확인 |

## 2-1. 결론 갱신

실측으로 **ACP 1순위 권장이 확정 수준으로 강화**됐다: 커스텀 게이트웨이 모델 + 무로그인 + session/set_model + usage 스트림이 모두 ACP 경로에서 실동작 확인됨.

## 2. 출처

- [공식] xai-org/grok-build user-guide 14(headless)·15(agent mode)·07(MCP), docs.x.ai (headless-scripting, sessions, overview)
- [표준] agentclientprotocol.com schema
- [2차] Grok-UI (ACP 클라이언트 구현 사례), Zed ACP agent 등재
