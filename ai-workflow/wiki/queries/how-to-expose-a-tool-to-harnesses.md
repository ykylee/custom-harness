---
type: query
status: active
updated: 2026-08-31
last_ingested_from: docs/design/reverse-tool-catalog.md, docs/reference/harness-mcp-support.md, packages/protocol/src/tools.ts
related_pages: [reverse-tools, tool-catalog-in-protocol, harness-pi]
---

# 질문 — 새 툴을 하네스에게 노출하려면?

## 짧은 답

`packages/protocol/src/tools.ts` 의 `TOOL_CATALOG` 에 `ToolSpec` 을 추가한다. **경로별로 따로 정의하지 않는다** — 노출 경로 2개가 이 배열을 읽는다.

## 체크리스트

1. **이름** — 소문자·숫자·`_`, **3~24자**(`TOOL_NAME_PATTERN`). 하네스가 재접두사를 붙이므로 짧아야 한다(omp `mcp__ch_*`, grok `ch__*`).
2. **`effect`** — `read` / `write`. write 면 **자동으로 승인 대상**이다. 이 판단을 우회하지 않는다.
3. **파라미터** — `z.object`(엄격). `looseObject` 를 쓰지 않는 이유는 [[decisions/tool-catalog-in-protocol]] §3.
4. **설명 문구** — grok 의 `search_tool` → `use_tool` 규약을 깨는 문구를 쓰지 않는다.
5. **테스트** — write/read ↔ 승인 대응이 테스트로 고정돼 있다. 새 툴도 그 표에 들어간다.

## 노출 경로별로 알아야 할 것

| 하네스 | 경로 | 함정 |
|---|---|---|
| omp | 데몬 MCP stdio 서버 · 격리 홈 `mcp.json` | **`tools.xdev=false` 를 동반 설정**해야 top-level 노출. 기본값은 `xd://` 은닉 |
| omp | 데몬 경로(`--mode rpc`) | MCP **비동기 로딩** — 1턴째 미노출. 준비 완료 게이트 필요 |
| grok | 같은 MCP 서버 · **`grok mcp add` 위임** | `search_tool` 선행 필수. TOML 을 직접 쓰지 않는다 |
| pi | **`pi.registerTool()` 확장** | MCP 없음(설계상 배제). 기동 후 등록 가능 |

## 함께 볼 것

- 서버명은 프로젝트 `.mcp.json` 에 **선점당할 수 있다** — 접두사·선점 탐지가 7.2.4
- `session_new` 계열은 **재귀 위험** — opt-in(기본 off) + 깊이·개수 상한
- 툴 **결과** 스키마는 아직 미고정 (7.2.3)
