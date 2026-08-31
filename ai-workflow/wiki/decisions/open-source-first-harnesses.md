---
type: decision
status: active
updated: 2026-08-31
last_ingested_from: docs/CONCEPT.md, docs/reference/gateway-compatibility.md
related_pages: [zero-config-bundle, gateway, harness-wrapping]
---

# 결정 — 하네스 편성은 오픈소스 우선

**결정일** 2026-08-24 (컨셉 확정) · **상태** 유효

1차 타깃: **pi**(MIT) · **oh my pi**(MIT) · **grok build**(Apache 2.0).
확장: opencode(조건부) → 후순위: claude · codex. 제외: antigravity.

## 두 개의 필터가 같은 답을 냈다

### 필터 1 — 재배포 가능한 라이선스

[[concepts/zero-config-bundle]] 이 전제다. 하네스를 설치 패키지에 **동봉해 재배포**하므로, 재배포 조건이 폐쇄적인 하네스는 애초에 쓸 수 없다. claude·codex 가 여기서 걸린다.

### 필터 2 — Chat Completions 직결

[[entities/gateway]] 는 **OpenAI 호환 API 만** 제공한다. 다른 형식을 쓰는 하네스는 변환 계층이 필요하다.

- claude → Anthropic Messages 전용
- codex → OpenAI Responses 전용

두 필터가 **같은 3종을 남겼다.** 그 결과 1차 범위에서는 변환 프록시(LiteLLM 류)가 **필요 없고**, 요건이 "하네스 엔드포인트를 게이트웨이로 돌리는 설정 주입"으로 좁혀졌다.

## 제외·보류

| 하네스 | 판정 | 사유 |
|---|---|---|
| opencode | 확장(조건부) | 오픈소스지만 **런타임 npm 설치·models.dev 페치 의존** — 폐쇄망에서 사전 캐시/내부 미러 구축이 선결 |
| claude · codex | 후순위 (M4 T3) | 재배포 조건 + 변환 계층 필요 |
| antigravity | **제외** | 폐쇄망에서 게이트웨이 연결이 사실상 불가 |

## 부수 이득

omp 가 pi 의 **포크**라 어댑터가 거의 그대로 재사용된다 — 공용 `session-core` 를 추출해 둘이 공유한다. 3종 중 2종의 통합 비용이 사실상 1.3종어치다.

## 이 결정을 다시 볼 조건

변환 계층이 다른 이유로 생기면(M4 T3 착수) 필터 2 가 풀린다. 그때 claude·codex 의 **재배포 조건을 재확인**한다 — 필터 1 은 여전히 남기 때문이다.
