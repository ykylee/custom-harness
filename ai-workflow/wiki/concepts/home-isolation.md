---
type: concept
status: active
updated: 2026-08-31
last_ingested_from: packages/daemon/src/gateway/home-isolation.ts, docs/reference/harness-mcp-support.md
related_pages: [closed-network-self-containment, credential-injection, reverse-tools]
---

# 하네스 홈 격리 (Home Isolation)

하네스를 **사용자의 실제 홈 디렉토리가 보이지 않는 상태**로 띄운다. M7 WBS 7.2.0a 에서 도입.

## 왜 설정 홈 격리만으로는 부족했나

원래는 하네스별 설정 홈만 갈랐다 — pi·omp 는 `PI_CODING_AGENT_DIR`, grok 은 `GROK_HOME`. 이 경로들이 우리 데이터 디렉토리를 가리키니 게이트웨이 설정 주입은 잘 동작했고, 오랫동안 충분해 보였다.

7.2.1 MCP 실측에서 깨졌다. **`$HOME` 뿌리의 외부 도구 설정은 그대로 읽히고 있었다.**

- omp: 프로브 서버 1개 외에 **MCP 툴 40여 개가 추가 노출**. 바이너리에 `~/.claude.json`·`~/.cursor/mcp.json`·`.vscode/mcp.json`·Claude 플러그인 마켓플레이스 `.mcp.json` 로더가 들어 있다.
- grok: `grok mcp doctor` 가 소스를 직접 찍는다 — `plugin: standard-ai-workflow  1 server`. 로그에 `"HOME": "/Users/yklee"`.

같은 뿌리에서 **두 번째 증상**도 나왔다: grok 이 `~/.claude/settings.json` 의 `permissions.defaultMode="auto"` 를 Claude 호환 import 로 읽어 auto 모드로 들어갔고, auto 는 목록에 없는 툴을 *묻지 않고* 거절했다 → [[decisions/grok-permission-mode-default]].

## 조치 — 환경 변수로 덮는다

omp 에는 이 탐색을 끄는 설정 키가 **없다**(`skills.enableClaudeUser`·`commands.enableClaudeUser` 는 있으나 MCP 용은 부재). 그래서 설정으로 막는 대신 **홈 자체를 바꿨다**.

`GatewayService.buildEnv` 가 하네스별 빈 홈(`data/harness-home/<harness>/`)을 만들고 덮는 변수:

- `HOME` (win32 는 `USERPROFILE`)
- `XDG_CONFIG_HOME` · `XDG_DATA_HOME` · `XDG_STATE_HOME` · `XDG_CACHE_HOME`

XDG 를 함께 덮는 이유: `XDG_CONFIG_HOME` 이 명시된 환경에서는 `HOME` 만 바꿔도 설정이 새어 나간다.

**거부 기본값 + allowlist 반입** — 격리 홈은 빈 디렉토리에서 시작하고, `harness.homeLinks`(기본 `.gitconfig`·`.ssh`)만 실제 홈으로 심볼릭 링크한다. 하네스 안에서 git 을 쓰기 위한 최소 표면이다. → [[patterns/deny-by-default-allowlist]]

**격리 실패는 삼키지 않는다.** 격리 홈 생성에 실패하면 세션 생성이 실패한다 — 격리는 성립하거나 시작하지 않거나 둘 중 하나다. 끄는 방법은 `harness.homeIsolation`(env `CUSTOM_HARNESS_HOME_ISOLATION`) 하나뿐이고, 꺼져 있으면 데몬이 기동 경고를 남긴다.

## 대조 실측 (2026-08-31)

| 조건 | 외부 유래 MCP 툴 | 프로브 왕복 |
|---|---|---|
| `--no-home-isolation` | **40** | `returned=true` |
| 격리 on (기본) | **0** | `returned=true` |

부작용 판정: `.gitconfig` 링크 상태에서 `git config --global user.name/user.email` 정상 해석, 저장소 `git status` 정상, omp·grok 왕복 CLI·데몬 양 경로 PASS. **회귀 없음.**

## 잔여

- **Windows 미검증** — `USERPROFILE` 덮기와 심볼릭 링크 반입(권한 필요)이 동일하게 성립하는지. C-5 실기기 항목. 반입 실패 시 경고만 남기고 격리는 유지하도록 구현했다(반입 없이도 격리는 성립).
- grok 의 `disabled_mcp_servers`·`managed_mcps.enabled` 선호 항목으로 부분 차단 여지가 있다 — 필요 시 병용.
