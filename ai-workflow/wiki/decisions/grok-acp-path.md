---
type: decision
status: active
updated: 2026-08-31
last_ingested_from: docs/reference/grok-integration-paths.md, docs/design/adapter-contract.md, packages/daemon/src/adapters/acp/grok.ts
related_pages: [harness-grok, grok-permission-mode-default, harness-wrapping]
---

# 결정 — grok 은 ACP 경로로 래핑한다

**결정일** 2026-08-25 (M0 WBS 0.1.1, 사용자 승인) · **상태** 유효

`grok agent stdio`(Agent Client Protocol)를 채택한다. headless `grok -p --output-format streaming-json` 은 폴백·단순 배치용으로만 남긴다.

## 왜

데몬의 **핵심 요건 4개가 전부 ACP 쪽에만** 있다.

| 요건 | headless | ACP |
|---|---|---|
| 런타임 승인 중재 (FR-1.5) | **불가** — `--allow/--deny` 사전 규칙 또는 `--yolo` 뿐, 미승인 툴은 그냥 실패 | `session/request_permission` 왕복 |
| 멀티턴 (FR-1.3) | **불가** — 턴마다 재spawn + `--resume` | 장수 프로세스에서 `session/prompt` 반복 |
| 즉시 중단 (FR-1.6) | 프로세스 종료 후 재spawn | `session/cancel` — 세션 유지한 채 즉시 재사용 |
| MCP 세션 주입 | 파일 기반만 | `session/new` 의 `mcpServers[]` |

스트리밍 세분성은 **동급**이다 — headless 의 NDJSON 은 ACP 업데이트의 파생 포맷이라, 여기서는 headless 의 이점이 없다.

## 이 결정이 만든 비대칭

pi·omp 는 JSONL RPC 로 공용 base 를 쓰고 grok 만 ACP 다. 어댑터가 두 갈래로 갈리지만, 대신 **grok 쪽은 표준 프로토콜이라 승인·취소·재개가 우리 계약과 거의 그대로 맞는다.** 실제로 ACP 표준 `kind`(`allow_always`/`allow_once`/`reject_once`)를 grok 이 정확히 보내서, 영속 승인을 1회 승인으로 오라벨링하는 문제가 없었다.

## 실측으로 확인한 전제

결정 시점에 9개 항목을 스파이크 목록으로 남기고 grok 1.0.5 로 측정했다. 특히:

- `initialize` 의 `loadSession: true` 광고 — 재개 가능
- **`session/load` 응답 *전에* 리플레이가 온다** — 응답을 기다린 뒤 처리하는 구현은 놓친다
- `session/cancel` 후 동일 세션 재프롬프트 일관성, SIGTERM 시 세션 저장
- 무로그인 콜드 스타트(`auth.json` 부재) + 커스텀 base_url 로 목 서버 직결 성립 — **폐쇄망 성립의 선결 조건이었다**

## 잔여

headless 는 `--yolo` 배치 실행 용도로만 남아 있고 현재 코드 경로에 없다. 필요해지면 그때 어댑터를 추가한다.
