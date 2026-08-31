---
type: entity
status: active
updated: 2026-08-31
last_ingested_from: docs/reference/harness-interfaces.md, docs/reference/harness-mcp-support.md, packages/daemon/src/adapters/jsonl-rpc/omp.ts
related_pages: [harness-pi, harness-grok, home-isolation]
---

# omp / oh my pi (하네스)

**번들 버전 17.3.8** · MIT · badlogic 의 pi 포크(개발 Can Bölük / Stencil Labs). npm `@oh-my-pi/pi-coding-agent`, bin `omp`.

pi 의 포크라 **별도 어댑터가 아니라 pi 어댑터의 확장판**이다 — 공용 `session-core` 를 추출해 둘이 공유한다.

## 통합

| 항목 | 값 |
|---|---|
| 전송 | stdio JSONL RPC. 데몬은 `--mode rpc` |
| 프로토콜 협상 | 기동 시 `ready` 핸드셰이크로 **v2 협상** |
| 청킹 | v1 은 라인당 1MiB 한도 → **v2 `rpc_chunk`(64MiB)**. 미구현 시 큰 응답(`get_available_models`)이 깨진다 |
| 설정 격리 | `PI_CODING_AGENT_DIR` — **pi 와 동일 지원**(17.3.8 `dirs.ts` 소스 실측) |
| 게이트웨이 주입 | `models.yml` 프로바이더 블록 + `config.yml` |
| 재개 | 세션 파일 경로를 핸들로 → `--session <file>`. **과거 이벤트 리플레이를 드롭해야 한다** |

## pi 와 다른 지점 — 추측하면 틀리는 것들

- **`apiKey` 가 bare 환경변수명**이다. pi 의 `$VAR` 형식이 아니다.
- **`PI_OFFLINE` 을 지원하지 않는다.** 대신 `startup.checkUpdate` · `marketplace.autoUpdate` · `dev.autoqa` 를 각각 내린다.
- **로컬 LLM 프로바이더를 자동 탐지한다** — `lm-studio` · `ollama` · `llama.cpp` · `vllm`. M5 검증에서 측정 PC 의 LM Studio(:1234)에 실제로 접속하는 것이 잡혔다(NFR-1 위반). `models.yml` 선점으로 차단하되 사용자 설정 항목은 보존한다. **버전 갱신 시 id 목록 재실측 필요** — 새 id 가 추가되면 우회 통로가 다시 생긴다.
- **승인이 전용 프레임이 아니다** — 범용 `extension_ui_request`(select 다이얼로그)로 도착한다. 1차는 `--approval-mode` 고정으로 우회하고 `runtimePermission` 을 ✗ 로 하향했다.

## MCP — 네이티브 지원, 그러나 기본값에서 은닉

stdio · http · sse 전부 지원. 사용자 스코프 등록은 `$PI_CODING_AGENT_DIR/mcp.json`(격리 홈에 그대로 놓으면 읽는다).

**두 개의 함정이 있다:**

1. **`tools.xdev = true`(기본값)** 는 MCP·확장 툴의 스키마를 매 요청에 싣지 않고 `xd://` 디바이스로 마운트한다. 그래서 요청의 `tools[]` 만 보면 **MCP 툴이 없는 것처럼 보이지만 서버는 이미 떠 있다.** `tools.xdev=false` 로 내려야 `mcp__<server>_<tool>` 로 top-level 노출된다.
2. **데몬 경로(`--mode rpc`)는 MCP 툴을 비동기로 싣는다.** `discoverAndLoadMCPTools` 가 백그라운드로 돌고 `refreshMCPTools()` 로 합류한다 — 실측상 **1턴째 미노출, 2턴째부터 왕복 PASS**. CLI `-p` 경로는 동기 로딩이라 1턴째부터 보인다. → 세션 수립에 **준비 완료 게이트** 필요.

`set_host_tools` RPC 도 실존하지만(MCP 없이 툴 주입 가능) 계약에 등록 경로가 없어 `nativeToolRegistration` 은 보류.

## 유지보수 리스크

**릴리스 주기가 매우 빠르다** — 번들 17.3.8 vs 조사 시점 최신 18.0.4(주당 수 회). 완화는 manifest 버전 고정 + 관대 파싱 + COMPAT 태그이고, 번들 갱신 주기마다 재실측이 필요하다. 특히 `tools.xdev` 기본값과 MCP 탐색 소스는 18.x 재확인 대상.
