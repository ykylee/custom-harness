---
type: concept
status: active
updated: 2026-08-31
last_ingested_from: docs/design/packaging.md, docs/requirements/fr4-packaging.md, bundle/build-bundle.mjs
related_pages: [closed-network-self-containment, credential-injection, harness-wrapping]
---

# 동봉 배포와 zero-config

**하네스는 사용자가 따로 설치하는 것이 아니라 이 도구의 설치 패키지에 들어 있다.** 폐쇄망에서 이것은 편의가 아니라 **성립 조건**이다.

paseo 를 비롯한 개방망 도구는 "각 하네스를 사용자가 npm/brew 로 설치하고 로그인해 두었다"는 전제 위에서 동작한다. 사내망에서는 외부 레지스트리 접근이 막혀 **그 전제 자체가 성립하지 않는다**.

## zero-config 는 세 가지의 결합이다

1. **하네스 동봉** — 설치하면 하네스도 같이 설치된다
2. **게이트웨이 설정 주입** — 하네스가 게이트웨이만 보도록 설정이 이미 들어가 있다 → [[concepts/credential-injection]]
3. = 사용자는 하네스별 설치·인증·엔드포인트 설정 없이 UI 에서 바로 쓴다

부수 효과가 하나 더 있다: **버전 호환이 검증된 하네스 세트**를 조직 단위로 통제·배포할 수 있다.

## 라이선스가 편성을 결정했다

동봉 재배포가 전제이므로 **재배포 가능한 라이선스가 1차 조건**이다. 그래서 1차 타깃이 pi(MIT) · omp(MIT) · grok build(Apache 2.0) 이고, 재배포 조건이 폐쇄적인 claude·codex 는 후순위다. → [[decisions/open-source-first-harnesses]]

`licenses/` 에 NOTICE 와 원문 전체를 동봉하는 것을 빌드가 자동화한다. 반입 출처·해시·수집일은 `bundle/licenses-src/PROVENANCE.md` 에 기록한다(grok 은 upstream NOTICE 부재를 확인).

## 배포 형태

OS 별 **단일 오프라인 아카이브** — macOS arm64 / Windows x64 / Linux x64. manifest 가 불변 버전 세트를 선언하고, 업데이트는 전체 번들 교체. 사용자 홈에 설치.

- 무결성: manifest 체크섬 + `dirHash`, `--verify` 로 검증 (NFR-8)
- 원자성: 심링크 전환 전까지 기존 설치본과 사용자 데이터 불변
- Windows 는 grok 제외 축소안(pi + omp 조건부)

## 버전 세트 불변성은 자동으로 지켜지지 않는다

FR-4.7 이 요구하는 "매니페스트 선언 = 동봉 실물"이 **조용히 깨진 상태**가 발견됐다(2026-08-31).

`sources.json` 의 grok `darwin-arm64` 만 `localFile: ~/.grok/bin/grok` 로 로컬 설치본을 복사하는데, 빌드가 그 경로에 대해 sha256 검증도 버전 대조도 하지 않고 매니페스트에는 고정 버전을 기입한다. 로컬 grok 이 자동 갱신되면서 **manifest 1.0.5 vs 실물 1.0.13** 으로 어긋났고, 체크섬은 복사본 기준이라 `--verify` 는 통과한다.

pi 에는 `piPackage.version !== sources.pi.version` 경고가 있다 — grok 의 `localFile` 경로에만 그 검사가 없었다. TASK-2026-08-31-main-002.

## 조달의 제약

grok linux-x64 는 x.ai CDN(primary) / GCS(fallback) **이중 소스 sha256 교차 검증**으로 조달한다 — 공식 체크섬이 공개돼 있지 않다는 것을 실측으로 확인했기 때문이다. 번들 갱신 시마다 교차 검증을 재수행해야 한다.
