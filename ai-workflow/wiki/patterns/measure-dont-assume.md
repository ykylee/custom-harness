---
type: pattern
status: active
updated: 2026-08-31
last_ingested_from: docs/reference/harness-mcp-support.md, docs/design/credential-injection-design.md, scripts/mcp-probe.mjs
related_pages: [deny-by-default-allowlist, single-policy-point, harness-wrapping]
---

# 패턴 — 하네스 동작은 실측으로만 확정한다

이 프로젝트에서 가장 자주 값을 한 작업 방식. **문서·README·이름이 말하는 것과 실물이 다른 경우가 계속 나왔다.**

우리는 우리가 만들지 않은 바이너리 3종을 래핑한다([[concepts/harness-wrapping]]). 그 바이너리들은 빠르게 바뀌고, 설정 키의 의미는 문서화돼 있지 않은 경우가 많다. 여기서 추측은 **나중에 런타임에서 터진다.**

## 규칙

1. **설계에 쓰기 전에 실물로 잰다.** 못 재면 "미실측"으로 명시하고, 통과로 세지 않는다.
2. **대조군을 둔다.** 값 하나만 보면 그게 무엇 때문인지 모른다.
3. **버전을 함께 기록한다.** 실측은 버전에 묶인 사실이다.
4. **재실측 조건을 남긴다.** "번들 갱신 시" 같은 트리거를 문서에 박아 둔다.

## 이 규칙이 실제로 건진 것들

| 무엇 | 가정 | 실물 |
|---|---|---|
| Electron `safeStorage` | 데몬에서 쓸 수 있다 | `ELECTRON_RUN_AS_NODE` 에서는 `require('electron')` 이 **경로 문자열만 반환** → 0600 폴백으로 설계 개정 |
| grok 권한 모드 | 이름으로 고르면 된다 | `acceptEdits`·`dontAsk`·`plan` 이 **MCP 툴을 묻지 않고 실행**. 둘 다 승인 대상인 모드는 `default` 뿐 |
| pi `mcpInjection` | 주입 플래그가 있다 | 0.84.1 에 **부재**. MCP 자체가 설계상 배제 |
| omp 격리 | pi 와 다를 것이다 | `PI_CODING_AGENT_DIR` **동일 지원**(소스 실측) — 좋은 쪽으로 틀렸다 |
| omp 오프라인 | `PI_OFFLINE` 이 될 것이다 | **미지원**. 스위치 3개를 각각 내려야 한다 |
| omp 네트워크 | 게이트웨이만 본다 | lm-studio·ollama·llama.cpp·vllm **자동 탐지** → 로컬 :1234 에 실제 접속 |
| `node-pty` | Electron 재빌드가 필요하다 | **N-API** — 같은 prebuilt 가 Node ABI 141·Electron ABI 149 동작 |
| `git rev-parse --show-toplevel` | 준 경로를 그대로 준다 | **심링크를 푼다**(`/tmp`→`/private/tmp`) → `--show-prefix` 로 전환 |
| omp MCP 로딩 | 세션 시작이면 준비됐다 | rpc 경로는 **비동기** — 1턴째 미노출, 2턴째부터 |

## 대조군이 결정적이었던 사례

[[concepts/home-isolation]] 에서 `--no-home-isolation` 대조군을 만들어 **`foreign=40` → `0`** 을 나란히 쟀다. 격리 적용 후의 `0` 만 봤다면 "원래 0 이었는지, 우리가 막은 것인지" 구분할 수 없다.

`scripts/mcp-probe.mjs` 는 아예 **판정 축 5개**(initialized / registered / exposure / invoked / returned)를 나눠 잰다. "된다/안 된다" 한 칸이면 *어디서* 끊겼는지 모른다.

## 부하도 측정이다

단위 테스트로는 안 나오고 **동시 세션에서만** 재현된 버그가 2건 있었다(`meta.json` 쓰기 경합, PID 원장 쓰기 경합). 혼합 6세션 부하 검증에서 검출됐다.

## 도구

- `scripts/mcp-probe.mjs` (+ `mcp-probe/mock-mcp-server.mjs`) — MCP 왕복 5축
- `scripts/grok-permission-probe.mjs` — 권한 모드 행렬
- `scripts/nfr1-smoke.mjs` — 외부 접속 0 (자손 프로세스 트리 감시)
- `npm run smoke:terminal` — 번들 실물 pty 왕복
