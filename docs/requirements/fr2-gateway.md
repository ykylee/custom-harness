<!-- standard-ai-workflow-kit: v1.4.0 -->

# FR-2 상세 — 게이트웨이 연결 통제

- 문서 목적: [REQUIREMENTS](../REQUIREMENTS.md) FR-2 그룹의 상세 요구사항. 모든 LLM 트래픽을 사내 게이트웨이(OpenAI 호환 Chat Completions)로 강제하는 방식.
- 상태: approved (v1, 2026-08-25 사용자 승인)
- 최종 수정일: 2026-08-25
- 근거 문서: [게이트웨이 호환 조사](../reference/gateway-compatibility.md)

## FR-2.1 하네스별 게이트웨이 설정 주입

설치 시(및 설정 변경 시) 각 하네스의 네이티브 설정에 게이트웨이 연결을 주입한다. 주입 내용은 하네스별로 다음과 같다.

### FR-2.1.1 pi (M, M1)

- `~/.pi/agent/models.json` 의 `providers.<사내프로바이더>` 블록 생성: `baseUrl`(게이트웨이) + `api: "openai-completions"` + `apiKey: "$<ENV>"`(환경변수 보간 — 키 파일 평문 저장 회피) + `authHeader: true`.
- 게이트웨이가 비표준 응답 특성을 보이면 `compat` 플래그(`supportsDeveloperRole: false` 등)로 대응한다 — M0 게이트웨이 실측에서 필요 여부 확정.
- pi 는 `/model` 시 설정을 리로드하므로 주입 후 재시작 불요.

### FR-2.1.2 oh my pi (M, M2)

- `~/.omp/agent/models.yml` 의 `providers:` 블록(`baseUrl` + `api: openai-completions` + `apiKey` + `models`) + `config.yml` 의 `modelRoles.default` 로 기본 모델 고정.

### FR-2.1.3 grok build (M, M2) — 2026-08-25 개정 (스파이크 실측 반영)

- `[model.<name>]` 블록(base_url + `api_backend = "chat_completions"` + api_key/env_key)로 커스텀 게이트웨이 연결 — **실측 확정: 자체 키만으로 xAI 로그인 불요, headless·ACP 양쪽 동작** ([실측 보고](../reference/grok-integration-paths.md) §3).
- 주입 위치 제약: **`[model.*]` 는 글로벌 config 전용**(프로젝트 config 은 mcp/plugins/permission 만) + grok 가 런타임에 config.toml 을 재작성함. 따라서 사용자 `~/.grok` 직접 수정 대신 **데몬이 spawn 시 번들 관리 `GROK_HOME`(격리 홈) 또는 `GROK_CONFIG_PATH`(오버레이) 환경변수를 주입하는 방식을 우선 후보**로 한다 — 최종 선택은 M0 0.4.2 주입 설계에서 확정.
- 기본 모델을 커스텀 모델로 고정할 것 — 보조 호출(세션 제목 생성 등)이 기본 모델 id 로 전송되는 것을 실측으로 확인, 게이트웨이가 미지 모델 id 를 거부하면 보조 기능이 실패한다.

### FR-2.1.4 주입 공통 규칙 (M, M1)

- **기존 사용자 설정 보존**: 주입은 자사 관리 블록(명명된 프로바이더/모델 항목)만 생성·갱신하고, 사용자가 추가한 항목은 건드리지 않는다. 주입 전 원본 백업.
- 주입 템플릿은 버전 관리되며 manifest(FR-4.2)에 템플릿 버전이 기록된다.
- 데몬이 세션 spawn 시 환경변수 오버레이(키·엔드포인트)를 함께 전달하는 "설정 파일 + env 2단 구조"를 기본 패턴으로 한다.

## FR-2.2 오프라인 스위치 프리셋 (M, M1: pi / M2: 전체)

설치 시 다음이 적용된 상태여야 한다:

| 하네스 | 스위치 |
|---|---|
| pi | `PI_OFFLINE=1` (spawn env 로 주입 — 버전 체크·설치 핑 차단) |
| omp | `omp config set startup.checkUpdate false`, `marketplace.autoUpdate off` 상당의 설정 파일 프리셋 |
| grok build | `auto_update = false`, telemetry·remote_fetch 차단 — **주의(2026-08-25 실측): v1.0.5 에서 `telemetry = false` 불리언 구문은 파싱 에러(구조체로 변경). 현행 구문 재확인 후 프리셋 확정** |

수용 기준: NFR-1 스모크(네트워크 캡처)에서 하네스 기동·1턴 실행 중 게이트웨이 외 목적지 접속 0.

## FR-2.3 게이트웨이 크리덴셜 (API 키) 관리

| ID | 요구사항 | 우선순위 | 단계 |
|---|---|---|---|
| FR-2.3.1 | 최초 실행 시 API 키 입력을 요구하는 온보딩 흐름 제공 (FR-3.8). 키 입력 → 게이트웨이 연결 확인(테스트 호출) → 저장 | M | M1 |
| FR-2.3.2 | 키는 평문 파일 저장을 피하고 OS 자격증명 저장소(Keychain / Credential Manager / libsecret) 사용을 우선 검토한다 — 채택 여부 M0 설계 (하네스에는 spawn 시 env 로만 전달) | S | M1 |
| FR-2.3.3 | 키 변경·삭제 UI 제공. 변경 시 연결 확인 재수행 | M | M1 |
| FR-2.3.4 | 조직 차원의 자동 프로비저닝(발급 시스템 연동)은 OPEN-2 — 게이트웨이 운영 주체와 협의 후 별도 트랙 | C | M3+ |

## FR-2.4 모델 목록 (S, M2)

- 게이트웨이의 모델 목록(`/v1/models` 지원 여부는 M0 실측)을 조회해 세션 생성·설정 UI 에서 선택 가능하게 한다. 미지원 시 manifest 에 정적 모델 카탈로그를 동봉하는 폴백.
- grok build 는 `models_base_url` 자동 페치를 활용 가능. pi/omp 는 주입 설정의 `models` 목록 갱신으로 반영.

## FR-2.5 트래픽 경계 검사 (S, M2)

- 데몬은 기동 시 각 하네스의 유효 설정을 검사해, LLM 엔드포인트가 게이트웨이(또는 화이트리스트) 외 목적지를 가리키면 경고를 표출한다 — 사용자가 설정을 수동 변경해 통제가 깨진 경우의 탐지 장치.
