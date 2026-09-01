<!-- standard-ai-workflow-kit: v1.7.0 -->

# 하네스 MCP 지원 실측 보고 (M7 WBS 7.2.1)

- 문서 목적: 1차 하네스 3종(pi / omp / grok)이 **MCP 서버를 실제로 띄우고, 툴을 모델에 노출하고, 모델의 호출을 실행해 결과를 대화로 되돌리는지**를 실물 바이너리로 측정하고, M7 역방향 툴 표면(WP 7.2)의 경로를 확정한다.
- 범위: MCP 지원 여부·등록 경로·노출 방식·호출 왕복·격리 경계. MCP 서버 **구현**(7.2.3)은 범위 밖.
- 대상 독자: 유지보수자, 설계자, AI agent
- 상태: approved (v1.4, 2026-09-01 — §4.1 에 위임 루프 실측 추가(7.3.1, 3하네스 PASS). v1.3: §4.1 write 툴 왕복 실측 추가(7.2.4, 3하네스 PASS). v1.2: §3.3 grok 권한 모드를 WBS 7.2.0b 로 확정(원인이 §3.1 누수였음을 실측). v1.1: §3.1 격리 누수 봉쇄. v1.0: 7.2.1 실측)
- 최종 수정일: 2026-09-01
- 측정 도구: [`scripts/mcp-probe.mjs`](../../scripts/mcp-probe.mjs) + [`scripts/mcp-probe/mock-mcp-server.mjs`](../../scripts/mcp-probe/mock-mcp-server.mjs) + [`scripts/grok-permission-probe.mjs`](../../scripts/grok-permission-probe.mjs) (권한 모드 행렬, §3.3)
- 측정 대상: 번들 실물 (`bundle/out/custom-harness-0.1.0-darwin-arm64/harnesses/`) — pi 0.84.1, omp 17.3.8, grok 1.0.13(§6 참조)
- 측정 환경: darwin arm64. 목 게이트웨이(OpenAI 호환 SSE) + 목 MCP stdio 서버. 외부 프록시 블랙홀(NFR-1 전제와 동일)
- 관련 문서: [m7-orchestration](../roadmap/m7-orchestration.md), [FR-9](../requirements/fr9-orchestration.md), [adapter-contract](../design/adapter-contract.md), [credential-injection-design](../design/credential-injection-design.md)

## 0. 결론 요약

**게이트 통과 — 역방향 툴은 MCP 를 주 경로로 간다.** 3종 중 2종(omp·grok)이 MCP 를 네이티브로 지원하고 **왕복(등록 → 노출 → 호출 → 결과 반영)이 실물로 확인**됐다. pi 만 MCP 를 의도적으로 배제하며, 대신 1급 확장 API(`pi.registerTool()`)가 있어 **동일한 툴 카탈로그를 확장으로 노출**할 수 있다. 따라서 7.2.3 은 "MCP 서버 + pi 확장 어댑터"의 2경로 구성으로 확정하고, CLI(7.5)를 자동화의 주 경로로 승격할 필요는 없다.

다만 **그대로 켜면 안 되는 조건이 4건** 나왔다(§3). 특히 §3.1 격리 누수는 M7 이전에 고쳐야 하는 현행 결함이다.

| 하네스 | MCP 지원 | 등록 경로(우리 격리 홈 기준) | 모델 노출 방식 | 왕복 실측 |
|---|---|---|---|---|
| **omp** 17.3.8 | ✅ 네이티브 (stdio·http·sse) | `$PI_CODING_AGENT_DIR/mcp.json` | 기본은 `xd://` 디바이스로 **은닉**, `tools.xdev=false` 면 `mcp__<server>_<tool>` 로 top-level 노출 | **PASS** (CLI·데몬 양 경로) |
| **grok** 1.0.13 | ✅ 네이티브 (stdio·http·sse) | `$GROK_HOME/config.toml` — `grok mcp add` 가 정본 창구 | 항상 메타 툴 `search_tool` → `use_tool` 뒤에 은닉 (`<server>__<tool>`) | **PASS** (CLI·데몬 양 경로, 조건부 §3.3·§3.4) |
| **pi** 0.84.1 | ❌ 없음 (설계상 배제) | — (관례 경로 4곳 모두 무반응) | — | 서버 기동조차 없음 |

## 1. 측정 방법

목 MCP stdio 서버는 줄 단위 JSON-RPC 2.0 으로 `initialize` / `tools/list` / `tools/call` 만 구현하고 수신 메시지를 JSONL 로 남긴다. 목 게이트웨이는 요청 body 의 `tools[]` 를 관측해 프로브 툴이 보이면 `tool_calls` 로 응답하고, 다음 턴 요청에 그 결과가 실려 오는지까지 본다. 판정 축 5개:

| 축 | 의미 | 근거 |
|---|---|---|
| `initialized` | MCP 서버 프로세스가 뜨고 handshake 성립 | MCP 로그의 `initialize` |
| `registered` | 하네스가 툴 목록을 가져감 | MCP 로그의 `tools/list` |
| `exposure` | 그 툴이 모델에게 닿는 방식 (`direct` / `meta`) | 게이트웨이 요청의 `tools[]` |
| `invoked` | 모델의 호출이 실제 MCP `tools/call` 로 실행됨 | MCP 로그의 `tool_called` |
| `returned` | 그 결과가 다음 턴 요청 메시지에 실림 (왕복 완결) | 요청 messages 의 `CH_MCP_PROBE_OK` |

**CLI 경로**(하네스를 `-p` 로 직접)와 **데몬 경로**(우리 어댑터: omp `--mode rpc`, grok ACP `agent stdio`)를 **모두** 측정했다 — 둘의 결과가 다르기 때문이다(§3.2).

재현:

```bash
# 전체 매트릭스 (권장 조건)
node scripts/mcp-probe.mjs --daemon --grok-permission-mode bypassPermissions
# 하네스 1종만
node scripts/mcp-probe.mjs --only omp --daemon
```

## 2. 하네스별 실측

### 2.1 omp 17.3.8 — 네이티브 지원, 기본 설정에서는 은닉

- **등록**: 사용자 스코프는 `<configDir>/mcp.json`. 우리 격리 홈(`PI_CODING_AGENT_DIR`)에 그대로 놓으면 읽는다. 프로젝트 스코프는 `mcp.enableProjectConfig`(기본 true)로 cwd 의 `mcp.json`/`.mcp.json`.
- **전송**: `mcp/transports/{stdio,http,sse}` 모두 존재. `/mcp add … [--url <url> --transport http|sse] [-- <command...>]` 슬래시 명령 보유(전용 CLI 서브커맨드는 없음).
- **노출**: 기본값 `tools.xdev = true` 는 **MCP·확장 툴의 스키마를 매 요청에 싣지 않고** `xd://` 디바이스로 마운트해 `read`/`write` 로 구동한다(`tools.xdevDocs = builtins` 는 "MCP and extension tools stay on-demand"). 그래서 `tools[]` 만 보면 MCP 툴이 **없는 것처럼 보인다** — 서버는 이미 떠 있고 `tools/list` 도 끝난 상태다.
- **왕복**: `tools.xdev = false` 로 내리면 `mcp__ch_probe_echo` 가 top-level 로 실리고 호출→결과 반영까지 PASS.

### 2.2 grok 1.0.13 — 네이티브 지원, 메타 툴 경유

- **등록**: `grok mcp {list,add,remove,enable,disable,doctor}` 가 1급 서브커맨드다. `grok mcp add <name> --scope user -e K=V -- <command...>` 가 `$GROK_HOME/config.toml` 의 `[mcp_servers.<name>]` 을 쓴다. **우리가 TOML 스키마를 추측할 필요가 없다** — 등록은 하네스 자신의 CLI 에 위임하는 것이 정본.
- **진단**: `grok mcp doctor` 가 소스별 서버 수 + handshake + 툴 개수를 찍는다. 온보딩·doctor(M3) 에 그대로 물릴 수 있는 표면이다.

  ```
  ch-probe (stdio: … mock-mcp-server.mjs)
    ✓ command found  ✓ server started (0.0s)  ✓ handshake OK (protocol 2025-11-25)  ✓ 1 tools discovered
  ```

- **노출**: 항상 `search_tool`(키워드 검색 + 스키마 조회) → `use_tool`(`<server>__<tool>` 호출) 2단 메타 툴 뒤에 있다. top-level 인라인 옵션은 없다. 세션 시작 시 시스템 리마인더로 연결된 서버 목록과 "`use_tool` 전에 반드시 `search_tool`" 규약을 주입한다.
- **왕복**: 그 규약을 지키면(`search_tool` 선행) PASS, 재현율 3/3. 지키지 않으면 간헐 실패(§3.4).

### 2.3 pi 0.84.1 — MCP 없음, 확장이 대체 경로

- README·docs 가 명시적으로 배제한다: *"It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode, to-dos, or background bash."* / *"**No MCP.** Build CLI tools with READMEs, or build an extension that adds MCP support."*
- 실측도 일치: `mcp.json` / `.mcp.json` / `agent/mcp.json` / 프로젝트 `.mcp.json` 4곳에 서버를 깔아도 **프로세스 자체가 뜨지 않고**(`initialized=false`), `tools[]` 는 내장 4종(`read`·`bash`·`edit`·`write`)뿐. CLI 에도 MCP 플래그가 없다.
- **대체 경로**: `pi.registerTool({ name, description, parameters, execute })` 가 1급 API 이며 **기동 후에도 등록 가능**(`session_start`·명령 핸들러 안에서 호출해도 같은 세션에 즉시 반영). 확장은 `--extension <path>` 로 명시 로드하거나 격리 홈의 확장 디렉토리에 둔다. 즉 **7.2.2 툴 카탈로그를 그대로 pi 확장으로 다시 노출**하면 되고, 별도 MCP 폴백 어댑터를 pi 용으로 만들 필요는 없다.

## 3. 그대로 켜면 안 되는 조건 (7.2.3·7.2.4 선행 과제)

### 3.1 [결함] 격리 누수 — omp·grok 이 **사용자 실제 `$HOME`** 의 MCP 설정을 읽어 서버를 띄운다

`PI_CODING_AGENT_DIR` / `GROK_HOME` 로 설정 홈을 격리해도 **`$HOME` 뿌리의 외부 도구 설정은 그대로 읽힌다.**

- omp: 측정 PC 에서 프로브 서버 1개 외에 **MCP 툴 40여 개가 추가로 노출**됐다 — Claude Code 플러그인 마켓플레이스의 `.mcp.json`, `~/.claude.json`, `~/.cursor/mcp.json`, `.vscode/mcp.json` 로더가 바이너리에 존재한다. `HOME` 을 임시 디렉토리로 바꾸면 **0개**로 떨어진다(대조 실측).
- grok: `grok mcp doctor` 가 소스를 직접 찍는다 — `plugin: standard-ai-workflow  1 server`, `~/.claude.json  0 servers`. 로그에도 `"HOME": "/Users/yklee"` 가 남는다. 바이너리 문자열에 `Loaded MCP servers from ~/.claude.json` / `Loaded Cursor MCP servers from ~/.cursor/mcp.json` 가 있다.

왜 문제인가:

1. **NFR-1(외부 접속 0) 우회 통로**다. 사용자 PC 에 http/sse 원격 MCP 서버가 하나라도 설정돼 있으면 하네스가 그리로 붙는다 — 게이트웨이 경계 밖이다. 지금까지 안 걸린 이유는 측정 PC 의 외부 서버가 전부 stdio 였고, `nfr1-smoke` 의 lsof 감시가 **PID 원장의 하네스만** 보기 때문이다(MCP 자식 프로세스는 원장에 없다).
2. **재현성**이 깨진다. 모델이 보는 툴 표면이 사용자 PC 마다 다르다.
3. omp 기본값(`tools.xdev=true`)에서는 이 툴들이 `tools[]` 에 안 보여 **눈에 띄지 않는다** — 그래도 서버 프로세스는 떠 있다.

**조치 — 2026-08-31 WBS 7.2.0a 로 봉쇄 완료.**

- omp 에는 이 탐색을 끄는 설정 키가 **없다**(`skills.enableClaudeUser`·`commands.enableClaudeUser` 는 있으나 MCP 용은 부재). 따라서 **`HOME`(win32 는 `USERPROFILE`)을 격리 홈으로 덮는 것**이 유일한 봉쇄 수단이었다. 데몬이 `buildEnv` 에서 하네스별 빈 홈(`data/harness-home/<harness>/`)을 만들고 `HOME`·`USERPROFILE`·`XDG_{CONFIG,DATA,STATE,CACHE}_HOME` 을 그리로 고정한다(`gateway/home-isolation.ts`). XDG 를 함께 덮는 이유는 `XDG_CONFIG_HOME` 이 명시된 환경에서 `HOME` 만으로는 새어 나가기 때문이다.
- **거부 기본값 + allowlist 반입**: 격리 홈은 빈 디렉토리에서 시작하고, `harness.homeLinks`(기본 `.gitconfig`·`.ssh`)만 실제 홈으로 심볼릭 링크한다. 하네스 안에서 git 을 쓰기 위한 최소 표면이다.
- **부작용 판정 결과**: 격리 홈 + `.gitconfig` 링크 상태에서 `git config --global user.name/user.email` 정상 해석, 저장소 `git status` 정상. omp·grok 왕복도 전 경로 PASS(아래 대조 실측) — 회귀 없음.
- **대조 실측 (2026-08-31)**: `node scripts/mcp-probe.mjs --only omp --no-home-isolation` → `foreign=40`(사용자 홈 유래 MCP 툴). 격리 on(기본) → **`foreign=0`**, `mcp__ch_probe_echo` 왕복은 그대로 `returned=true`.
- `nfr1-smoke` 감시 대상을 **하네스의 자손 프로세스 트리 전체**로 확장했다(v3). `ps -Ao pid=,ppid=` 로 원장 pid 의 자손을 BFS 로 모은다 — 손자(= 하네스가 띄운 MCP 서버) 포착을 별도 확인했고, 스모크 실행 시 감시 폭이 8개로 늘었다.
- 격리 홈의 **원격(http/sse) MCP 등록**은 트래픽 경계 검사(FR-2.5)의 위반 항목으로 추가했다 — omp `mcp.json` 의 `mcpServers.*.url`, grok `config.toml` 의 `[mcp_servers.*].url`. stdio 등록은 목적지가 없으므로 위반이 아니다.
- 격리는 `harness.homeIsolation`(env `CUSTOM_HARNESS_HOME_ISOLATION`)로만 끌 수 있고, 꺼져 있으면 데몬이 기동 경고를 남긴다.
- 잔여: grok 은 `disabled_mcp_servers` / `managed_mcps.enabled` 선호 항목이 있어 부분 차단 여지가 있다 — 7.2.3 에서 필요 시 병용.

### 3.2 omp 데몬 경로(`--mode rpc`)는 MCP 툴을 **비동기로** 싣는다 — 1턴째에는 없다

`hasUI === true` 분기에서 `discoverAndLoadMCPTools` 가 **백그라운드로 돌고** 끝난 뒤 `refreshMCPTools()` 로 합류한다. 실측: 같은 세션에서 **1턴째 노출 없음 → 2턴째부터 노출·왕복 PASS**. CLI `-p` 경로는 동기 로딩이라 1턴째부터 보인다.

→ 역방향 툴을 "첫 턴부터" 쓰게 하려면 세션 생성 후 **MCP 준비 완료를 기다리는 게이트**가 필요하다. 7.2.3 의 세션 수립 절차에 넣는다.

### 3.3 [결함→해소] grok 이 MCP 툴 호출을 **승인 요청 없이** 거절한다 — 원인은 §3.1 누수였다

권한 모드를 지정하지 않고 `grok agent stdio` 를 띄우면 모델의 `use_tool` 호출이 이렇게 잘렸다:

```
Tool `use_tool` was not executed: Auto mode blocked this action.
Take a safer approach that stays within what the user asked for; do not retry this exact action…
```

**`session/request_permission` 이 오지 않는다** — `permission_requested` 이벤트가 데몬에 도달하지 않아 사용자가 승인할 기회조차 없다. 우리 승인 배선(WBS 2.2.3)은 정상인데 그 앞단에서 잘린다.

**원인 (2026-08-31, WBS 7.2.0b 실측).** grok 의 권한 정책이 **사용자 실제 `$HOME` 에서 들어오고 있었다.** `GROK_HOME` 을 격리해도 `grok inspect` 는 이렇게 찍는다:

```
Permissions
└ Source: /Users/yklee/.claude/settings.json (settings)
└ 12 loaded, 0 skipped
```

측정 PC 의 `~/.claude/settings.json` 에는 `permissions.defaultMode = "auto"` + Bash 전용 allow 규칙 12개가 있었다. grok 의 Claude 호환 import 가 이를 읽어 **auto 모드**로 들어갔고, auto 모드는 목록에 없는 툴을 *묻지 않고* 거절한다. 즉 §3.1 과 같은 뿌리(`$HOME` 누수)의 다른 증상이다.

대조 실측 — 같은 프로브, 홈 격리만 다르게:

| 홈 격리 | MCP 승인 요청 | MCP 실행 | 내장 `write` 승인 요청 | 잘림 사유 |
|---|---|---|---|---|
| **off** (`CUSTOM_HARNESS_HOME_ISOLATION=false`) | ❌ | ❌ | ❌ | `Auto mode blocked this action` |
| **on** (7.2.0a 기본값) | ✅ | ✅ | ✅ | — |

**조치 — 권한 모드를 명시 고정한다.** 격리만으로 증상은 사라지지만 *지정하지 않은 상태*는 grok 의 설정 탐색 결과에 좌우된다(1.0.5 는 물었고 1.0.13 은 누수된 설정 아래서 잘랐다 — 이미 한 번 드리프트했다). 그래서 모드 행렬을 실측하고 하나를 고정했다.

**모드 행렬** (`node scripts/grok-permission-probe.mjs`, grok 1.0.13, 홈 격리 on):

| `--permission-mode` | MCP 툴 승인 요청 | MCP 실행 | 내장 `write` 승인 요청 | 내장 실행 |
|---|---|---|---|---|
| **`default`** | **✅** | ✅ | **✅** | ✅ |
| `acceptEdits` | ❌ | ✅ | ✅ | ✅ |
| `auto` | ❌ | ✅ | ❌ | ✅ |
| `dontAsk` | ❌ | ✅ | ✅ | ✅ |
| `bypassPermissions` | ❌ | ✅ | ❌ | ✅ |
| `plan` | ❌ | ✅ | ✅ | ✅ |
| (미지정) | ✅ | ✅ | ✅ | ✅ |

**MCP 툴과 내장 파괴적 툴이 동시에 승인 대상이 되는 모드는 `default` 하나뿐이다.** 나머지는 최소 한 종류를 조용히 자동 허용한다 — 특히 `acceptEdits`·`dontAsk`·`plan` 은 이름과 달리 **MCP 툴을 묻지 않고 실행**한다.

→ `GrokAdapter` 가 `--permission-mode default` 를 **항상 붙여** spawn 한다(`permissionMode: 'inherit'` 로만 생략 가능, 권장하지 않음). 결과적으로 7.2.0b 의 원래 목표였던 "MCP 툴만 승인 대상" 보다 나은 상태다 — *MCP 툴도, 내장 파괴적 툴도* 승인 대상이고, 자동 승인 정책은 우리 레이어(`autoApprove` 설정)가 소유한다.

**부수 실측 — 승인 옵션이 2종에서 3종으로 늘었다.** 1.0.5 는 `allow-once`/`reject-once` 뿐이었으나 1.0.13 `default` 모드는 영속 승인을 함께 노출한다:

| 대상 | 옵션 (ACP `kind`) |
|---|---|
| MCP 툴 | `always-allow`(`allow_always`) · `allow-once`(`allow_once`) · `reject-once`(`reject_once`) |
| 파일 쓰기 | `allow-edits-session`(`allow_always`) · `allow-once` · `reject-once` |

grok 이 ACP 표준 `kind` 를 그대로 보내므로 어댑터 매핑이 영속 승인을 1회 승인으로 잘못 라벨링하지 않는다(실측 확인). [adapter-contract §4](../design/adapter-contract.md) 의 "`allow_always` 가 노출되면 재실측" 조건이 발동한 지점이며, 영속 승인의 UI 표기·감사 기록은 FR-1.5 후속으로 남긴다(격리 `GROK_HOME` 덕에 영속 범위는 번들 데이터 안으로 한정된다).

### 3.4 grok 은 `use_tool` 앞에 `search_tool` 선행을 요구한다

규약을 어기면 왕복이 **간헐 실패**한다(초기 측정 재현율 약 1/3). 게이트웨이가 `search_tool` → `use_tool` 순서를 지키자 3/3 결정적으로 성공. 우리가 툴을 노출할 때 **툴 설명에 "먼저 search_tool 로 스키마를 조회하라"는 grok 의 규약을 깨지 않도록** 카탈로그 문구를 설계해야 한다(7.2.2).

### 3.5 프로젝트 스코프 `.mcp.json` 이 사용자 스코프를 덮는다 (grok·omp 공통)

프로젝트 루트의 `.mcp.json` 에 **같은 이름의 서버**가 있으면 사용자 스코프 등록을 가린다 — 측정 중 pi 프로브가 깔아 둔 프로젝트 `.mcp.json` 이 grok 의 사용자 스코프 `ch-probe` 를 가려 다른 하네스 측정까지 오염됐다(서버명을 분리해 해소). 워크스페이스가 임의 저장소를 여는 우리 구조에서는 **저장소가 우리 역방향 툴 이름을 선점할 수 있다**는 뜻이다 → 7.2.3 의 서버명에 충돌 회피 접두사, 7.2.4 에 이름 선점 탐지.

## 4. 7.2 경로 확정 (이 실측의 결론)

| WBS | 결정 |
|---|---|
| 7.2.2 툴 카탈로그 | **하네스 무관 단일 카탈로그**로 정의. 이름은 `<prefix>_<verb>_<object>` 형태로 짧게 — grok 은 `<server>__<tool>`, omp 는 `mcp__<server>_<tool>` 로 다시 접두사를 붙이므로 원본이 길면 모델이 다루기 나빠진다 |
| 7.2.3 노출 | **경로 2개**: ① MCP stdio 서버 1개(omp·grok 공용, 데몬이 소유) ② pi 확장(`pi.registerTool`) — 같은 카탈로그를 두 표면으로. **"폴백 어댑터"는 pi 전용 확장을 뜻한다**로 WBS 문구 보정 필요 |
| 7.2.3 등록 | grok 은 `grok mcp add`(하네스 CLI 위임), omp 는 격리 홈 `mcp.json` 직접 기입 + `tools.xdev=false` 동반 설정, pi 는 확장 경로 주입 |
| 7.2.4 안전장치 | §3.1 HOME 격리 **(7.2.0a 완료)** · §3.3 grok 권한 모드 **(7.2.0b 완료 — `--permission-mode default` 고정)** · §3.5 이름 선점 탐지 **(7.2.4 완료 — 세션 생성 시 경고)** |
| 7.5 CLI | 자동화 주 경로 **승격 불필요**. 계획대로 병행 트랙 유지 |

## 4.1 write 툴 왕복 실측 (2026-09-01, 7.2.4)

read 왕복(7.2.3)과 전송은 같지만 **승인 대기**가 끼어든다 — 하네스 자신의 툴 타임아웃이 우리 승인 만료(120초)보다 짧으면 read 경로로는 드러나지 않는다. `mcp-probe --real-server --daemon --write-probe` 로 잰다: 목 모델이 `session_new` 를 부르고, 데몬이 승인 카드를 올리고, 프로브가 자동 승인한 뒤 세션이 실제로 생기는지까지.

| 하네스 | 노출 | write 왕복 | 승인 | 결과 |
|---|---|---|---|---|
| omp 17.3.8 | `direct:mcp__ch_ws_list` | PASS | `origin=reverse_tool` 1건 | 세션 +1, 자식 라벨 `ch.toolDepth=1` |
| grok 1.0.13 | `meta:use_tool` | PASS | `origin=reverse_tool` 1건 | 세션 +1, 자식 라벨 `ch.toolDepth=1` |
| pi 0.84.1 | `direct:session_new` (접두사 없음) | PASS | `origin=reverse_tool` 1건 | 세션 +1, 자식 라벨 `ch.toolDepth=1` |

### 위임 루프 (2026-09-01, 7.3.1)

같은 프로브가 write 왕복 뒤에 **생성 → 전송 → 대기 → 회수**를 이어 돌린다. 부모가 자식을 만들고, 프롬프트를 보내고, 완료를 기다린 뒤, 자식의 응답 본문을 회수한다.

| 하네스 | `session_say` | `session_wait` | `session_result` | 자식 응답 회수 |
|---|---|---|---|---|
| omp 17.3.8 | ok | **done** | ok | 있음 |
| grok 1.0.13 | ok | **done** | ok | 있음 |
| pi 0.84.1 | ok | **done** | ok | 있음 |

자식 세션의 누적 사용량도 부모 쪽에서 조회된다 — 7.3.2 사용량 합산의 입력이 실제로 잡힌다는 확인이다.

**측정 도구 결함 1건 수정**: 프로브가 대화 이력의 **첫** 툴 결과를 붙들고 있었다(`if (found && !obs.toolResultSeen)`). 한 턴만 도는 측정에서는 문제가 없지만 위임 루프처럼 여러 턴을 돌면 새 턴의 첫 요청에서 지난 턴 결과가 굳어, 뒤 턴을 재는 것처럼 보이면서 실제로는 옛 값을 읽는다. 마지막 `role: 'tool'` 메시지를 매번 덮어쓰도록 고쳤다 — 이 결함이 남아 있었다면 `wait=not-done` 이라는 **거짓 실패**를 제품 결함으로 오인할 뻔했다.

부수 확인:

- **3종 모두 승인 대기를 견딘다** — 하네스 쪽에서 툴 호출을 먼저 포기하지 않았다. 다만 프로브의 자동 승인은 즉시 응답이므로 **긴 대기(수십 초)는 여전히 미측정**이다. 실사용에서 사용자가 오래 자리를 비우는 경우는 우리 만료(120초)가 먼저 끊는다.
- grok 은 자기 툴 승인(`origin=harness`) 2건을 별도로 올렸다 — `origin` 필드가 하네스 요청과 우리 요청을 실제로 갈라 준다는 확인이다.
- foreign=0 유지 — 역방향 툴을 켜도 홈 격리 경계(NFR-1)는 그대로다.

## 5. 미해결 (7.2.3 착수 시 확정)

- grok 영속 승인(`always-allow`·`allow-edits-session`)의 UI 표기·감사 기록 — FR-1.5 후속
- Windows(conpty·`USERPROFILE`)에서 §3.1 봉쇄가 동일하게 성립하는지 — **C-5 실기기 항목에 추가**. 심볼릭 링크 반입은 Windows 에서 권한이 필요할 수 있어 실패 시 경고만 남기고 격리는 유지하도록 구현했다(반입 없이도 격리는 성립)
- omp 18.x 에서 `tools.xdev` 기본값·MCP 탐색 소스 재실측 (번들 갱신 주기)

## 6. 측정 중 발견한 번들 결함 (별건)

`bundle/out/custom-harness-0.1.0-darwin-arm64/manifest.json` 은 grok 을 **1.0.5** 로 선언하는데 동봉된 실물은 **1.0.13** 이다.

원인: `bundle/sources.json` 의 grok `darwin-arm64` 만 `localFile: ~/.grok/bin/grok` 로 **로컬 설치본을 그대로 복사**하고, `build-bundle.mjs` 는 그 경로에 대해 ① sha256 검증도 ② 버전 대조도 하지 않은 채 매니페스트에 `sources.grok.version` 을 **무조건** 기입한다(pi 는 `piPackage.version !== sources.pi.version` 경고가 있다). 로컬 grok 이 자동 갱신되면서 어긋났고, 체크섬은 복사본 기준으로 기록되므로 `--verify` 는 통과한다 — **버전 세트 불변성(FR-4.7)이 조용히 깨진 상태**다.

조치 제안: `localFile` 경로에도 pi 와 같은 버전 대조 경고를 넣고, 실측 버전을 매니페스트에 기입하도록 바꾼다. 별도 태스크로 등록 권장.
