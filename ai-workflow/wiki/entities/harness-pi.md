---
type: entity
status: active
updated: 2026-08-31
last_ingested_from: docs/design/adapter-contract.md, docs/reference/harness-mcp-support.md, packages/daemon/src/adapters/jsonl-rpc/pi.ts
related_pages: [harness-omp, harness-grok, reverse-tools]
---

# pi (하네스)

**번들 버전 0.84.1** · MIT · 1차 타깃 3종 중 가장 먼저 붙인 하네스이고, 어댑터의 공용 base 가 여기서 나왔다.

폐쇄망 적합성이 가장 높다 — Chat Completions 직결이고 `PI_OFFLINE` 이 완비돼 있다.

## 통합

| 항목 | 값 |
|---|---|
| 전송 | stdio JSONL RPC |
| 설정 격리 | `PI_CODING_AGENT_DIR` (실측 확정, 2026-08-25 스파이크) |
| 게이트웨이 주입 | 격리 홈의 `models.json` — `openai-completions` 프로바이더 + apiKey(**`$VAR` 형식**) + authHeader |
| 오프라인 | `PI_OFFLINE=1` (이 상태에서도 게이트웨이 호출은 정상) |
| 내장 툴 | `read` · `bash` · `edit` · `write` 4종 |

## capability 실측

✓ `streaming` · `reasoningStream` · `sessionResume`(세션 파일) · `runtimePermission` · `modelSwitch`(`set_model`) · `usageReporting`

✗ 로 **하향된 것들** — 전부 실측 근거가 있다:

- `mcpInjection` — 0.84.1 에 `--mcp-config` 류 주입 플래그 **부재**. 설계 초안은 있다고 가정했었다(v1.1 보정)
- `steering` · `compaction` — `steer`/`follow_up`/`compact` RPC 가 **실존하지만** 우리 계약에 메서드가 없어 1차 보류. 도입하려면 계약 확장과 함께 상향

## MCP 는 설계상 배제다

README·docs 가 명시한다:

> *"It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode, to-dos, or background bash."*
> *"**No MCP.** Build CLI tools with READMEs, or build an extension that adds MCP support."*

실측도 일치했다 — `mcp.json` / `.mcp.json` / `agent/mcp.json` / 프로젝트 `.mcp.json` **4곳 모두에 서버를 깔아도 프로세스가 뜨지 않는다.** CLI 에 MCP 플래그도 없다.

**대체 경로**: `pi.registerTool({ name, description, parameters, execute })` 가 1급 API 이고 **기동 후에도 등록 가능**하다(`session_start`·명령 핸들러 안에서 호출해도 같은 세션에 즉시 반영). 확장은 `--extension <path>` 로 명시 로드하거나 격리 홈의 확장 디렉토리에 둔다.

→ [[concepts/reverse-tools]] 의 2경로 중 pi 쪽이 이것이다. pi 전용 MCP 폴백 어댑터를 만들 필요는 없다.

## 잔여

Windows 지원은 **조건부** — Git Bash 전제로 알려져 있고 실기기 판정(C-5)이 남아 있다.
