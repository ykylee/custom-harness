<!-- standard-ai-workflow-kit: v1.4.0 -->

# 스킬 / MCP / 플러그인 단일 형태 공유 가능성 조사

- 문서 목적: 사용자 정의 확장(스킬·MCP·플러그인)을 하네스마다 따로 만들지 않고 단일 형태로 관리·배포할 수 있는지 조사한다.
- 조사일: 2026-08-24 (공식 문서·표준 사이트 직접 확인 + paseo 소스 실측)
- 관련 문서: [CONCEPT](../CONCEPT.md), [paseo 분석 §5 확장 3축](./paseo-analysis.md), [게이트웨이 호환 조사](./gateway-compatibility.md)

## 0. 핵심 결론

| 확장 종류 | 단일 형태 공유 | 방법 |
|---|---|---|
| **스킬 (SKILL.md)** | **가능 — 사실상 표준 성립** | 정본 1벌 + 하네스별 디렉터리 동기화(복사/심링크). 무변환. |
| **MCP** | **가능** | 서버 1개 공유 + 설정만 하네스별 변환(JSON/TOML 트랜스파일 또는 스폰 시점 주입). |
| **플러그인** | **불가 (컨테이너 기준)** | 컨테이너는 하네스 종속. 단, 내용물(스킬+MCP)을 정본으로 두고 하네스별 컨테이너를 생성하는 방식은 현실적. |

폐쇄망 적합성: 셋 다 본질이 "폴더 + 텍스트 파일 + 로컬 프로세스"라 외부 레지스트리 없이 성립. 마켓플레이스류는 전부 배제 가능.

## 1. 스킬 — 사실상 표준 성립

**타임라인**: 2025-10 Anthropic Agent Skills 공개(SKILL.md + YAML frontmatter) → 2025-12 OpenAI가 ChatGPT·Codex에 채택, Anthropic이 **agentskills.io 오픈 스탠다드**로 공개 → 2026-08 현재 공식 클라이언트 쇼케이스에 Claude Code, Codex, Gemini CLI, OpenCode, pi, Cursor, Copilot 등 **~40개 도구 등재** (직접 확인).

**하네스별 스킬 디렉터리**:

| 하네스 | 경로 | 비고 |
|---|---|---|
| claude | `~/.claude/skills/`, `.claude/skills/` | 원조 |
| codex | `~/.codex/skills/`, `.agents/skills/`(프로젝트) | 2025-12 채택 |
| pi | agentskills.io 공식 클라이언트 등재 | pi-skills 리포가 "Claude Code·Codex 호환" 명시 |
| omp | **타 하네스 설정 상속** (`.claude`, `.codex`, `.gemini` 등 자동 인식) | 추가 작업 불필요 |
| opencode | 자체 경로 + `~/.claude/skills/`, `~/.agents/skills/` 등 **타 디렉터리도 스캔** | 추가 작업 불필요 |
| grok build | `.grok/skills/`, `~/.grok/skills/`, config.toml `[skills] paths` | Anthropic 스킬 호환 표방(2차 출처) |
| gemini cli / antigravity | `~/.gemini/skills/` 계열 | antigravity 전역 경로는 2차 출처 간 상이 — 실기기 확인 필요 |

**핵심 사실**: 스펙은 스킬 폴더의 *내용*만 정의하고 *설치 위치*는 정의하지 않음. 이를 메꾸는 관행 두 가지 — ① `.agents/skills/` 중립 디렉터리(codex·cursor·copilot·opencode가 스캔), ② 크로스 하네스 설치 CLI `npx skills`(vercel-labs/skills, 76+ 에이전트, 정본 + 심링크/복사, 로컬 경로 설치 지원).

**paseo 실측**: paseo 자신이 "단일 소스 + 멀티 타깃 동기화"의 실증 사례 — 번들 스킬을 `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills` 3곳에 설치하며, **해시 매니페스트 기반 복사 동기화**(`orchestration-skills/internal/sync.ts`, 심링크 경로는 오히려 에러 처리)를 쓴다. 심링크는 단순하나 일부 샌드박스 미지원 → 복사 동기화가 더 견고.

**AGENTS.md와의 관계**: 상보적 — AGENTS.md는 상시 컨텍스트, Skills는 매칭 시 로드되는 온디맨드 지식(progressive disclosure).

## 2. MCP — 서버 1개, 설정만 변환

MCP는 프로토콜 자체가 표준이므로 **서버 프로세스 1개를 모든 하네스가 공유하는 것이 성립**. 갈라지는 것은 등록 설정 형식뿐:

| 하네스 | 설정 위치 | 형식 |
|---|---|---|
| claude | `.mcp.json` / `~/.claude.json` | JSON `mcpServers` |
| codex | `~/.codex/config.toml` | TOML `[mcp_servers.*]` (Streamable HTTP + OAuth 지원) |
| pi | `--mcp-config <json>` / `~/.pi/agent/mcp.json` | JSON (코어 미내장, 확장 경유) |
| omp | 타 도구 설정 상속 (`.mcp.json` 등) | — |
| opencode | `opencode.json` `"mcp"` | JSON (`type: local/remote`), 런타임 API 주입도 가능 |
| grok build | `~/.grok/config.toml` | TOML (codex와 거의 동일) |
| gemini/antigravity | `settings.json` / `mcp_config.json`, `.agents/mcp_config.json` | JSON |

**paseo 실측 — 변환 계층이 이미 구현돼 있음**: 중립 스키마 `McpServerConfig`(stdio/http/sse) → codex TOML(`providers/codex/options.ts`), opencode(`toOpenCodeMcpConfig()`), pi(`toPiMcpConfig()` + `--mcp-config`)로 각각 변환. omp는 MCP 대신 네이티브 host-tools로 같은 카탈로그를 전달 — MCP가 유일한 통로가 아니어도 됨을 보여주는 사례.

**주의 (변환 손실 필드)**: 인증 표기(codex `bearer_token_env_var` vs claude `headers`), 타임아웃 필드, OAuth 플로우 지원은 하네스별 편차 — 최소공배수(stdio: command/args/env, http: url/headers)로 중립 스키마를 잡는 것이 안전.

## 3. 플러그인 — 컨테이너 공유 불가, 내용물은 가능

- Claude Code plugin(`.claude-plugin/plugin.json`)과 Gemini extension(`gemini-extension.json`)은 둘 다 **"스킬+MCP+커맨드의 포장 컨테이너"** — 새 능력이 아니라 기존 구성요소의 배포 형식.
- pi/omp extensions, OpenCode plugins, paseo plugin은 각자 TS/JS API에 바인딩된 코드 플러그인 — 상호 호환 불가. 플러그인 API 수준의 표준화 움직임은 미미.
- 예외적으로 Grok Build가 Claude Code 플러그인 읽기 호환 레이어를 제공한다는 2차 출처 있음(공식 문서 확인 불가).
- **현실적 접근**: 내용물(스킬+MCP)을 정본으로 두고, 필요 시 `.claude-plugin`·`gemini-extension.json` 컨테이너를 정본에서 **생성**(트랜스파일).

## 4. custom-harness 실현 방안 제안

**정본(canonical) 번들 형식**:

```
my-extension/
├── skills/<name>/SKILL.md   # 전 하네스 무변환 배포
├── mcp.json                 # 중립 스키마 {name: {type: stdio|http, command/args/env | url/headers}}
└── manifest.json            # 이름/버전/설명 (오케스트레이터 메타)
```

- **(a) 스킬**: 정본을 `~/.agents/skills/`에 두고 각 하네스 디렉터리로 **해시 매니페스트 기반 복사 동기화** (paseo sync.ts가 참조 구현). opencode·omp는 스스로 읽으므로 작업 불필요.
- **(b) MCP**: 중립 스키마에서 하네스별 형식으로 트랜스파일. 파일 직접 수정보다 하네스 CLI(`claude mcp add` 등)·런타임 API(opencode)·플래그(pi) 사용이 사용자 설정 파손 위험이 적고, 오케스트레이터가 에이전트를 스폰한다면 **스폰 시점 주입이 가장 깨끗함** (paseo 방식).
- **(c) 플러그인**: 하네스 네이티브 플러그인 API는 흡수하지 않고, 오케스트레이터 자체 플러그인 형식으로 정의하되 내용물이 스킬+MCP면 (a)(b) 파이프라인으로 풀어서 배포.
- **폐쇄망**: 정본은 git 저장소/파일 복사로 배포. `npx skills`는 외부 npm 접근이 필요하므로 벤더링하거나 자체 동기화 코드(수백 줄 수준)로 대체.

**확인 불가로 남긴 항목**: 스킬 frontmatter 확장 필드의 하네스별 해석 차이(최소 필드 name/description만 쓰면 안전), antigravity 스킬 전역 경로, grok build의 Claude 플러그인 호환 레이어 공식 여부.
