<!-- standard-ai-workflow-kit: v1.4.0 -->

# 크리덴셜·설정 주입 설계 (M0 WBS 0.4.1 / 0.4.2 / 0.4.3)

- 문서 목적: 게이트웨이 API 키의 저장 방식과 하네스별 설정 주입 전략을 확정한다. OPEN-2 처리.
- 상태: approved (v1.3, 2026-08-31 — §2 에 HOME 격리 행 추가(M7 7.2.0a). v1.2: 2026-08-25 사용자 승인 — 개정: §2 omp 격리 env 실측 확정(PI_CODING_AGENT_DIR 동일 지원, WBS 2.1). v1.1: §1 headless 실측 확정 반영)
- 최종 수정일: 2026-08-31
- 입력: [FR-2](../requirements/fr2-gateway.md), [grok 실측](../reference/grok-integration-paths.md) §3, [데몬 설계](./daemon-design.md)

## 1. 키 저장 방식 (0.4.1 — 결정)

**Electron `safeStorage` 채택** (OS 키체인 연동 암호화: macOS Keychain / Windows DPAPI / Linux libsecret) — 암호문을 `data/credentials.enc` 에 저장, 복호화는 데몬 프로세스에서만.

- 근거: 셸이 Electron 확정이라 추가 의존성 0. 3 OS 커버.
- **폴백**: `safeStorage.isEncryptionAvailable() === false`(일부 Linux 데스크톱 — libsecret 부재) 시 평문 대신 **파일 권한 0600 + 경고 표기** 저장. 폴백 여부를 doctor(FR-5.3)와 설정 화면에 노출.
- ~~데몬이 headless(셸 없이 CLI 기동) 인 경우에도 `ELECTRON_RUN_AS_NODE` 프로세스에서 safeStorage 사용 가능 여부는 **M1 첫 구현 태스크에서 실측**~~ → **실측 확정 (2026-08-25, v1.1)**: `ELECTRON_RUN_AS_NODE` 에서는 `require('electron')` 이 API 없는 바이너리 경로 문자열만 반환 — 데몬 프로세스에서 safeStorage 직접 사용 불가. **M1 은 0600 폴백으로 확정**(폴백 여부는 설정 화면·doctor 에 노출 — 구현됨), **safeStorage 는 셸 경유 IPC 위임(SecretCipher 주입 인터페이스는 구현 완료)으로 M2 에서 배선**.
- 키는 어떤 설정 파일·로그에도 평문 기록 금지. 하네스에는 **spawn env 로만 전달** (FR-2.1.4).

## 2. 하네스별 주입 전략 (0.4.2 — 결정)

원칙: **사용자 홈의 하네스 설정을 가능한 한 건드리지 않는다.** 격리·env 우선, 파일 주입은 최후 수단.

| 하네스 | 전략 | 상세 |
|---|---|---|
| **grok** | **완전 격리 (파일 주입 없음)** | `GROK_HOME=data/grok-home` — 번들 설치 시 config.toml(커스텀 모델 + 기본 모델 고정 + 오프라인 스위치) 생성. 사용자 자체 `~/.grok` 와 완전 분리. grok 의 런타임 config 재작성도 격리 홈 안에서만 발생 |
| **pi** | **완전 격리 — 실측 확정 (2026-08-25 스파이크)** | **`PI_CODING_AGENT_DIR` 로 홈 격리 동작 확인** (pi 0.84.1): 격리 디렉토리의 `models.json` 커스텀 프로바이더(`openai-completions` + apiKey + authHeader)로 목 게이트웨이 직결·Bearer 키 전송 성공, `PI_OFFLINE=1` 에서도 게이트웨이(LLM) 호출은 정상. 사용자 `~/.pi` 완전 불간섭 |
| **omp** | **완전 격리 — 실측 확정 (2026-08-25, WBS 2.1.3)** | **pi 와 동일한 `PI_CODING_AGENT_DIR` 지원 확인** (oh-my-pi 17.3.8 dirs.ts 소스 실측). 격리 홈에 `models.yml` 관리 프로바이더 블록(`apiKey` 는 **bare env 변수명** — pi 의 `$VAR` 와 다름) + `config.yml` 관리 항목(modelRoles.default + 오프라인 프리셋: startup.checkUpdate·marketplace.autoUpdate·dev.autoqa off — omp 는 `PI_OFFLINE` 미지원). 드리프트·백업 정책은 pi 와 동일 |
| **HOME (3하네스 공통)** | **격리 — M7 7.2.0a (2026-08-31)** | 위 설정 홈 격리만으로는 **사용자 실제 `$HOME` 의 외부 도구 MCP 설정**(`~/.claude.json`·Claude Code 플러그인 `.mcp.json`·`~/.cursor/mcp.json`)이 그대로 읽힌다(7.2.1 실측 — omp 에서 툴 40여 개 유입). 그래서 spawn 시 `HOME`·win32 `USERPROFILE`·`XDG_{CONFIG,DATA,STATE,CACHE}_HOME` 을 하네스별 빈 홈 `data/harness-home/<harness>/` 로 덮는다. **거부 기본값** 위에 `harness.homeLinks`(기본 `.gitconfig`·`.ssh`)만 심볼릭 링크로 반입 — git 신원은 유지된다. 구현 `gateway/home-isolation.ts` |

- 주입 시점: 설치 스크립트(초기) + 데몬 기동 시 검증·복구(드리프트 감지 시 재주입 여부는 경고 후 사용자 확인 — 자동 덮어쓰기 금지).
- 템플릿: `current/config-templates/` 에 하네스·버전별 보관, manifest 에 버전 기록 (FR-4.2). **grok telemetry 스위치 구문은 v1.0.5 스키마로 재작성** (실측 발견 반영 — 구조체 형식).

## 3. 온보딩·키 수명주기

- 최초 실행: 키 입력 → `config.key.test`(게이트웨이 Chat Completions 1회 호출) → safeStorage 저장 → 완료 (FR-3.8). 실패 시 원인별 안내(네트워크/401/형식).
- 변경·삭제: 설정 화면(FR-3.6.1). 변경 시 실행 중 세션에는 다음 spawn 부터 적용됨을 고지.
- 키 회전 대응: 401 계열 에러를 어댑터가 `AdapterError('auth')` 로 분류 → UI 가 키 재입력 유도.

## 4. 자동 프로비저닝 (0.4.3 — 조건부 보류)

- 게이트웨이 운영 주체의 발급 API 유무 확인은 [체크리스트 C-4](../roadmap/m0-internal-checklist.md) 대기. **회신 전까지 "수동 입력(§3)으로 확정, 자동화 보류"** 로 기록한다. 회신 후 API 가 존재하면 M3+ 별도 트랙 (FR-2.3.4).
