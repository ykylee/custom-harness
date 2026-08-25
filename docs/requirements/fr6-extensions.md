<!-- standard-ai-workflow-kit: v1.4.0 -->

# FR-6 상세 — 확장 (후순위 확정)

- 문서 목적: [REQUIREMENTS](../REQUIREMENTS.md) FR-6 그룹의 상세 요구사항. M4 에서 go/no-go 재평가 후 착수하는 항목들 — 지금은 범위·전제조건만 고정한다.
- 상태: approved (v1, 2026-08-25 사용자 승인)
- 최종 수정일: 2026-08-25
- 근거 문서: [게이트웨이 호환 조사](../reference/gateway-compatibility.md), [확장 공유 조사](../reference/extension-sharing.md)

## FR-6.1 opencode 편입 (L, M4)

- 어댑터: `opencode serve` spawn 후 REST + SSE (paseo 실측 경로).
- 게이트웨이: `opencode.json` 의 `provider.<id>` 에 `npm: "@ai-sdk/openai-compatible"` + `options.baseURL/apiKey` 주입.
- **편입 전제조건 (폐쇄망 요건)**:
  - 프로바이더 npm 패키지의 런타임 Bun 설치를 무력화 — `~/.cache/opencode/node_modules/` 사전 캐시를 번들에 동봉하거나 내부 npm 레지스트리 미러 확보
  - `models.dev/api.json` 시작 페치 차단 검증 (`OPENCODE_DISABLE_MODELS_FETCH=1` 이 "부분적"이라는 보고 — 실측 필수)
  - ripgrep·LSP 온디맨드 다운로드 경로 확인·차단
- go/no-go 기준: 위 3건이 번들 동봉만으로 해결되는지. 유지 비용이 크면 편입 보류.

## FR-6.2 claude / codex 편입 (L, M4)

- **선행 결정**: 변환 계층 형태 — LiteLLM 류 프록시 1대(`/v1/messages` + `/v1/responses` 노출) vs 자체 구현. 배포 위치(개별 PC 동봉 vs 사내 공용 서버)도 함께 결정.
- claude (Claude Code): `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` 오버레이, `DISABLE_TELEMETRY`·`DISABLE_AUTOUPDATER`·`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 등 차단 스위치, WebSearch 등 서버측 툴 비활성. 변환 손실(프롬프트 캐싱, adaptive thinking, beta 헤더) 수용 여부 평가.
- codex: `~/.codex/config.toml` `[model_providers]` 블록 생성(`wire_api = "responses"`, `requires_openai_auth = false`). Responses→Chat 브리지의 reasoning 연속성 손실 평가.
- **재배포 조건 재확인 필수**: 두 하네스 모두 비오픈소스 — 번들 동봉이 불가하면 "설치 안내 + 설정 주입만 제공" 형태로 축소.

## FR-6.3 조직 공용 스킬/MCP 세트 (C, M4 — 구현 부담 낮아 우선 검토)

- 정본 번들 형식 ([확장 공유 조사 §4](../reference/extension-sharing.md)):

```
<extension>/
├── skills/<name>/SKILL.md   # 전 하네스 무변환
├── mcp.json                 # 중립 스키마 (stdio: command/args/env | http: url/headers)
└── manifest.json
```

- FR-6.3.1 스킬: 정본을 `~/.agents/skills/` 에 두고 하네스별 디렉토리(`~/.claude/skills` 등)로 **해시 매니페스트 기반 복사 동기화** (심링크 금지 — 샌드박스 호환). omp·opencode 는 타 디렉토리를 스스로 읽으므로 작업 불필요.
- FR-6.3.2 MCP: 중립 스키마 → 하네스별 형식 변환. 데몬이 세션 spawn 시 주입하는 방식을 우선(설정 파일 직접 수정 최소화). 중립 스키마는 최소공배수 필드로 한정 (인증 표기·타임아웃은 하네스별 편차 주의).
- FR-6.3.3 번들에 조직 공용 세트를 동봉하고, 번들 업데이트로 세트를 갱신한다 (개별 마켓플레이스류 없음).
- FR-6.3.4 스킬 frontmatter 는 name/description 최소 필드만 사용 (하네스별 확장 필드 해석 차이 회피).
