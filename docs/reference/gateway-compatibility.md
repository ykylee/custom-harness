<!-- standard-ai-workflow-kit: v1.4.0 -->

# 하네스별 게이트웨이(OpenAI 호환) 연결 조사

- 문서 목적: 지원 하네스 7종을 사내 커스텀 LLM 게이트웨이(OpenAI 호환 Chat Completions 전용)로 연결하는 방법과 난이도를 정리한다.
- 전제: 사내망(폐쇄망). 모든 LLM 트래픽은 지정 게이트웨이 경유. 외부 네트워크 참조 최소화. ([CONCEPT §5](../CONCEPT.md))
- 조사일: 2026-08-24 (공식 문서 + 오픈소스 리포 + paseo 소스 실측)
- 관련 문서: [CONCEPT](../CONCEPT.md), [paseo 분석](./paseo-analysis.md), [하네스 인터페이스 조사](./harness-interfaces.md)

## 0. 종합 판정

| 하네스 | 네이티브 와이어 형식 | 판정 | 폐쇄망 리스크 |
|---|---|---|---|
| **pi** | 멀티 (`openai-completions` 선택 가능) | **직결 가능** | 낮음 (`PI_OFFLINE=1`로 전부 차단) |
| **oh my pi** | 멀티 (pi 계열, `openai-completions` 선택 가능) | **직결 가능** | 낮음 (설정으로 차단 가능) |
| **grok build** | 멀티 (Chat Completions가 커스텀 모델 기본값) | **직결 가능** | 낮음 — 폐쇄망 배포를 공식 설계에 반영 |
| **claude (Claude Code)** | Anthropic Messages 전용 | **변환 프록시 필요** | 중간 (일부 기능이 api.anthropic.com 직행) |
| **codex** | OpenAI Responses 전용 (2026-02부터 `wire_api="chat"` 제거) | **변환 프록시 필요** | 중간 (업데이트 체크 비활성 키 확인 불가) |
| **opencode** | Vercel AI SDK (`@ai-sdk/openai-compatible` = Chat Completions) | **설정만 필요 (조건부)** | **높음**: models.dev 페치 + 런타임 Bun 패키지 설치 → 사전 캐시/내부 미러 전제 |
| **antigravity** | Google 인프라 브로커 (전 모델 Google 경유) | **사실상 불가** | 치명적: OAuth 필수 + 엔드포인트 오버라이드 공식 미지원 → **도입 제외 권고** |

**권장 아키텍처**: 게이트웨이 앞단에 변환 계층(LiteLLM 또는 동급) 1대 — `/v1/messages`(→Claude Code), `/v1/responses`(→Codex)를 노출하고, 나머지(pi/omp/grok/opencode)는 Chat Completions 직결.

## 1. 1차 타깃

### claude (Claude Code) — 변환 프록시 필요

- **형식**: Anthropic Messages 단일 (`POST /v1/messages?beta=true`, Anthropic SSE 스트리밍 — `ping` 포함 이벤트를 게이트웨이가 버퍼링 없이 중계해야 함).
- **오버라이드**: `ANTHROPIC_BASE_URL` + 크리덴셜 3택 — `ANTHROPIC_AUTH_TOKEN`(Bearer) / `ANTHROPIC_API_KEY`(x-api-key) / `apiKeyHelper`(양쪽). 커스텀 헤더 `ANTHROPIC_CUSTOM_HEADERS`. 모델 별칭 `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`.
- **변환**: Messages → Chat Completions 프록시 필수. 선례: **LiteLLM `/v1/messages` 통합 엔드포인트**(사실상 표준 해법), claude-code-proxy, y-router.
- **변환 손실**: 프롬프트 캐싱, interleaved/adaptive thinking(`CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1`), `anthropic-beta` 페어 필드(`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`로 억제), 서버측 WebSearch(paseo도 서드파티 엔드포인트에 `disallowedTools: ["WebSearch"]` 권고).
- **폐쇄망 주의**: fast mode·WebFetch 안전성 체크는 `ANTHROPIC_BASE_URL`을 무시하고 api.anthropic.com 직행(차단돼도 추론은 동작). 차단 스위치: `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`.

### codex — 변환 프록시 필요

- **형식**: OpenAI Responses 전용. **2026-02(v0.84.0)에 `wire_api = "chat"` 완전 제거** — Chat Completions 직결 불가가 확정됨.
- **오버라이드**: `~/.codex/config.toml`의 `[model_providers.<id>]` 블록(`base_url`, `env_key`(Bearer), `wire_api = "responses"`, `http_headers`/`env_http_headers`, `requires_openai_auth = false`)이 유일하게 신뢰 가능한 경로 (`OPENAI_BASE_URL` env는 deprecated/회귀 보고 있음).
- **변환**: 게이트웨이가 `/v1/responses`를 제공하지 않으면 Responses → Chat Completions 브리지 필요(LiteLLM 등). 손실: reasoning item(암호화 reasoning 포함), reasoning summary, `previous_response_id` 서버측 상태 — 프록시가 시뮬레이션해야 하며 GPT-5급 reasoning 연속성 저하 가능.
- **폐쇄망 주의**: 업데이트 체크 비활성 공식 키 확인 불가(요청 이슈 미해결). OTel은 opt-in. ChatGPT 로그인 대신 `env_key` + `requires_openai_auth=false`로 API 키 인증. `web_search` 툴 비활성 권장.

### pi — 직결 가능 (폐쇄망 최적)

- **형식**: 모델별 API 타입 선택 (`openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai`). `openai-completions`가 "most compatible".
- **오버라이드**: `~/.pi/agent/models.json`의 `providers.<name>` — `baseUrl` + `api: "openai-completions"` + `apiKey`(`$ENV` 보간, `!command` 셸 실행 지원) + `authHeader: true`(Bearer) + `headers`. `/model` 열 때마다 리로드(재시작 불필요).
- **비표준 서버 대응**: `compat` 플래그 (`supportsDeveloperRole: false` 등 — vLLM/SGLang류 대응).
- **폐쇄망**: `PI_OFFLINE=1`(또는 `--offline`)로 버전 체크·설치 핑 등 시동 네트워크 동작 전부 차단. SaaS 백엔드 없음.
- 참고: 리포지토리가 badlogic/pi-mono → earendil-works/pi로 리네임됨.

## 2. 확장 타깃

### oh my pi (omp) — 직결 가능

- **형식**: pi 계열 멀티 형식 (`openai-completions` 포함 5종). "60+ 프로바이더"의 실체는 번들 카탈로그 + 멀티 형식 클라이언트.
- **오버라이드**: `~/.omp/agent/models.yml`의 `providers:` 블록 (`baseUrl` + `api: openai-completions` + `apiKey` + `models`). 기본 모델 고정은 `config.yml`의 `modelRoles.default`. 내장 프로바이더의 baseUrl 재지정도 공식 지원(체인지로그에 내부 게이트웨이 라우팅 사용례 명시).
- **폐쇄망**: 카탈로그 번들(외부 페치 없음). 업데이트 체크 `omp config set startup.checkUpdate false`, 마켓플레이스 `marketplace.autoUpdate off`. OAuth는 구독형 프로바이더 전용 — API 키 경로 무관.

### grok build — 직결 가능 (가장 폐쇄망 친화적)

- **형식**: 3종 백엔드 구현(Chat Completions / Responses / Messages), **커스텀 모델 기본값이 Chat Completions**. 기본 xAI 백엔드(cli-chat-proxy.grok.com)는 고정이 아님.
- **오버라이드**: `~/.grok/config.toml` — `[model.<name>] base_url` + `api_backend = "chat_completions"` + `env_key`, `[endpoints] models_base_url`(모델 목록 자동 페치). 환경변수 `GROK_MODELS_BASE_URL` + `XAI_API_KEY`만으로도 가능. **`models_base_url` 설정 시 API 키 인증으로 전환되어 `grok login` 불요** (공식 문서 명시).
- **폐쇄망**: `auto_update = false`, `telemetry = false`, `remote_fetch = false`("firewalled/air-gapped deployments"용으로 공식 주석 명시). 기업 OIDC·외부 인증 헬퍼(`auth_provider_command`, air-gapped용 명시)까지 지원. 세션 토큰은 1st-party URL에만 전송되는 안전장치도 소스 확인.

### opencode — 조건부 (설정은 쉽지만 폐쇄망 준비 필요)

- **형식**: Vercel AI SDK. 커스텀 게이트웨이는 `opencode.json`의 `provider.<id>`에 `npm: "@ai-sdk/openai-compatible"` + `options.baseURL/apiKey/headers` + `models`로 등록 — 공식 지원.
- **폐쇄망 리스크 (높음)**: ① 시작 시 `models.dev/api.json` 페치(`OPENCODE_DISABLE_MODELS_FETCH=1` 워크어라운드는 "부분적"이라는 보고), ② **프로바이더 npm 패키지를 런타임에 Bun으로 설치**(`~/.cache/opencode/node_modules/`) — 사전 캐시 주입 또는 내부 npm 레지스트리 필요, ③ ripgrep·LSP 온디맨드 다운로드. 완전 오프라인 모드는 미해결 기능 요청.

### antigravity — 사실상 불가 (도입 제외 권고)

- 전 모델(Gemini/Claude/GPT-OSS)이 **Google 인프라 브로커 경유** — 클라이언트가 임의 엔드포인트로 직접 추론하는 구조가 아님.
- BYOK/커스텀 엔드포인트 **공식 미지원** (커뮤니티 패치만 존재 — 사내 표준 부적합). Google OAuth/GCP 로그인 필수.
- 폐쇄망에서 Google 인증 서버·추론 브로커 접근이 불가하면 동작 자체가 불가.
- 참고: 조사 중 Gemini CLI의 지속 여부에 대해 상충 정보 확인(활성 유지 vs 2026-06 종료·Antigravity CLI로 대체) — 대안 검토 시 재확인 필요.

## 3. paseo에서 재사용할 패턴 (실측)

- **"env 오버레이 + 하네스 네이티브 설정 파일 주입" 2단 구조**가 실전 검증된 패턴:
  - Claude Code: env만으로 충분 (`docs/custom-providers.md` — `extends: "claude"` + `env` + 정적 `models` + `disallowedTools: ["WebSearch"]`. 사내 게이트웨이 연결에 그대로 복붙 가능).
  - Codex: config 생성 필요 — paseo는 `OPENAI_BASE_URL`/`OPENAI_API_KEY`를 받아 `model_providers` 블록으로 자동 변환 주입 (`codex-app-server-agent.ts`의 `buildCodexCustomProviderConfig()`: `/v1` 정규화, `wire_api: "responses"` 고정). "endpoint must speak the OpenAI **Responses API**" 문서 명시 — chat 제거를 이미 반영한 설계.
  - pi: 엔드포인트를 pi 자체 `models.json`에 위임하고 env를 통째로 전달 (`createProviderEnv()` env 오버레이).

## 4. 컨셉에 주는 시사점

1. **변환 계층은 Claude Code·Codex 두 곳에만 필요**하고, LiteLLM 류 1대로 둘 다 해결 가능(`/v1/messages` + `/v1/responses` 노출). 자체 변환 구현 여부는 설계 단계 결정 사항.
2. **1차 타깃 중 pi가 폐쇄망 적합성 최상** — 직결 + `PI_OFFLINE` 완비. claude/codex는 변환 손실(캐싱, thinking, reasoning 연속성)을 감수해야 함.
3. **확장 타깃 재평가 필요**: grok build·omp는 폐쇄망 적합성이 오히려 1차 타깃(claude/codex)보다 높음. antigravity는 제외 권고. opencode는 사전 캐시 구축 비용이 있음.
