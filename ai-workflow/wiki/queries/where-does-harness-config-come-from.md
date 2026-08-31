---
type: query
status: active
updated: 2026-08-31
last_ingested_from: docs/design/credential-injection-design.md, packages/daemon/src/gateway/home-isolation.ts, docs/design/daemon-design.md
related_pages: [credential-injection, home-isolation, harness-omp]
---

# 질문 — 하네스가 읽는 설정은 어디서 오나?

하네스가 "이상한 설정을 물고 있다" 싶을 때 확인 순서.

## 1. 우리가 주입하는 것

| 하네스 | 격리 변수 | 우리가 쓰는 파일 |
|---|---|---|
| pi | `PI_CODING_AGENT_DIR` | `models.json` |
| omp | `PI_CODING_AGENT_DIR` | `models.yml` · `config.yml` · `mcp.json` |
| grok | `GROK_HOME` | `config.toml` (`grok mcp add` 위임) |

키는 파일이 아니라 **spawn env** 로만 간다. 실행 파일은 `current/harnesses/<h>/` **절대 경로**(PATH 금지).

## 2. 홈에서 새어 들어오는 것 — 여기가 함정이었다

설정 홈만 격리하면 **`$HOME` 뿌리의 외부 도구 설정은 그대로 읽힌다.**

omp·grok 바이너리에 이 로더들이 들어 있다:

- `~/.claude.json` · `~/.claude/settings.json`
- Claude Code 플러그인 마켓플레이스의 `.mcp.json`
- `~/.cursor/mcp.json` · `.vscode/mcp.json`

이것이 **두 가지 증상**을 냈다: MCP 툴 40여 개 유입, 그리고 grok 이 `permissions.defaultMode="auto"` 를 물고 승인 요청 없이 툴을 거절.

→ 지금은 `HOME`·`USERPROFILE`·XDG 4종을 `data/harness-home/<harness>/` 로 덮는다. [[concepts/home-isolation]]

## 3. 프로젝트(cwd)에서 오는 것

프로젝트 스코프 `.mcp.json` 이 **사용자 스코프 서버명을 덮는다**(grok·omp 공통). 워크스페이스가 임의 저장소를 여는 구조에서는 **저장소가 우리 툴 이름을 선점할 수 있다.**

omp 는 `mcp.enableProjectConfig`(기본 true)로 cwd 의 `mcp.json`/`.mcp.json` 을 읽는다.

## 진단 명령

```bash
grok inspect          # 권한 소스와 로드 개수를 직접 찍는다
grok mcp doctor       # 소스별 서버 수 + handshake + 툴 개수
node scripts/mcp-probe.mjs --only omp --daemon
node scripts/mcp-probe.mjs --only omp --no-home-isolation   # 대조군
```

`grok inspect` 의 `Permissions └ Source:` 줄이 우리 격리 홈이 아니면 격리가 새고 있는 것이다.

## 4. 하네스가 스스로 다시 쓰는 것

하네스는 런타임에 자기 설정을 재작성한다. 그래서 데몬은 기동 시 드리프트를 검사하되 **자동으로 덮어쓰지 않는다** — 경고 후 사용자 확인. 격리 홈 안이라 영향 범위는 번들 데이터로 한정된다.
