---
type: concept
status: active
updated: 2026-08-31
last_ingested_from: docs/design/credential-injection-design.md, packages/daemon/src/gateway/service.ts, packages/daemon/src/gateway/key-store.ts
related_pages: [home-isolation, zero-config-bundle, closed-network-self-containment]
---

# 크리덴셜·설정 주입 (Credential & Config Injection)

게이트웨이 API 키를 저장하고, 하네스가 그 게이트웨이만 보도록 설정을 주입한다. [[concepts/zero-config-bundle]] 의 성립 조건.

## 원칙 — 사용자 홈을 건드리지 않는다

**격리·env 우선, 파일 주입은 최후 수단.** 사용자가 개인적으로 쓰던 `~/.pi`·`~/.grok` 설정을 우리가 덮어쓰면, 이 도구를 지운 뒤에도 흔적이 남는다.

| 하네스 | 격리 변수 | 주입물 |
|---|---|---|
| pi 0.84.1 | `PI_CODING_AGENT_DIR` | `models.json` 커스텀 프로바이더(`openai-completions` + apiKey + authHeader), `PI_OFFLINE=1` |
| omp 17.3.8 | `PI_CODING_AGENT_DIR` (pi 와 **동일 지원** — 소스 실측) | `models.yml` 프로바이더 블록 + `config.yml` 오프라인 프리셋 |
| grok 1.0.13 | `GROK_HOME` | `config.toml` — 커스텀 모델·기본 모델 고정·오프라인 스위치 |
| **3종 공통** | `HOME`·`USERPROFILE`·XDG 4종 | [[concepts/home-isolation]] (M7 7.2.0a) |

**하네스마다 같은 개념의 표기가 다르다** — 추측하면 틀린다:

- pi 는 `models.json` 의 apiKey 에 `$VAR` 형식, omp 는 `models.yml` 에 **bare 환경변수명**
- omp 는 `PI_OFFLINE` 을 **지원하지 않는다** — 대신 `startup.checkUpdate`·`marketplace.autoUpdate`·`dev.autoqa` 를 각각 내려야 한다
- grok 은 `config.toml` 의 `env_key` + `[cli]`/`[features]` 오프라인 3스위치

키 자체는 **spawn env 로만** 하네스에 전달한다. 어떤 설정 파일·로그에도 평문으로 남기지 않는다.

## 키 저장 — 설계가 실측에 한 번 꺾였다

원래 결정은 Electron `safeStorage`(macOS Keychain / Windows DPAPI / Linux libsecret)였다. 셸이 Electron 이니 추가 의존성 0.

**실측이 뒤집었다 (2026-08-25)**: 데몬은 `ELECTRON_RUN_AS_NODE` 로 뜨는데, 그 모드에서 `require('electron')` 은 **API 없는 바이너리 경로 문자열만 반환**한다. 데몬 프로세스에서 safeStorage 직접 사용은 불가능하다.

→ M1 은 **파일 권한 0600 폴백 + 경고 표기**로 확정. 폴백 여부는 doctor 와 설정 화면에 노출한다. `SecretCipher` 주입 인터페이스는 구현해 뒀고, 셸 경유 IPC 위임 배선은 M2 개정 포인트로 남아 있다.

설계서 v1.1 개정 사유가 이것이다 — [[patterns/measure-dont-assume]] 의 대표 사례.

## 주입 시점과 드리프트

설치 스크립트에서 1차 주입, 데몬 기동 시 검증·복구. **드리프트를 감지해도 자동으로 덮어쓰지 않는다** — 경고 후 사용자 확인. 하네스가 런타임에 자기 설정을 다시 쓰는 경우가 있어서, 자동 덮어쓰기는 사용자 변경을 조용히 지우는 길이 된다.

## 미해결

사용자별 키 **자동 프로비저닝**은 게이트웨이 운영 주체의 발급 API 유무(체크리스트 C-4) 회신 대기. 회신 전까지 수동 입력으로 확정, 자동화 보류.
