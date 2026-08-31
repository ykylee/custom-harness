---
type: entity
status: active
updated: 2026-08-31
last_ingested_from: docs/requirements/fr2-gateway.md, docs/reference/gateway-compatibility.md, packages/daemon/src/gateway/service.ts
related_pages: [credential-injection, closed-network-self-containment, zero-config-bundle]
---

# 커스텀 게이트웨이 (Gateway)

사내에서 운영하는 **OpenAI 호환 LLM 게이트웨이**. 모든 모델 추론 호출의 유일한 목적지다(NFR-2).

## 이 제약이 하네스 편성을 결정했다

게이트웨이가 제공하는 것은 **OpenAI Chat Completions 호환 API 뿐**이다. 하네스가 다른 형식을 쓰면 변환 계층이 필요하다.

- 1차 타깃 pi · omp · grok 은 **전부 Chat Completions 직결** → 변환 프록시 불필요, **설정 주입만으로 성립**
- claude(Anthropic Messages 전용) · codex(OpenAI Responses 전용) 는 변환 계층이 필요 → 후순위(M4 T3)
- antigravity 는 게이트웨이 연결이 사실상 불가로 **지원 목록에서 제외**(2026-08-24)

즉 "오픈소스 우선"([[decisions/open-source-first-harnesses]])과 "Chat Completions 직결"이 맞물려 1차 타깃 3종이 정해졌다.

## 우리가 하는 일

1. 하네스별 설정 파일·환경변수에 **엔드포인트와 키를 주입**한다 → [[concepts/credential-injection]]
2. 모델 카탈로그를 게이트웨이에서 읽어 UI 에 노출한다(`/v1/models`)
3. 기동 시 **트래픽 경계 검사**(FR-2.5) — 하네스 설정에 게이트웨이 아닌 목적지가 있으면 경고

## 미실측 — C-1

**실 게이트웨이로는 아직 한 번도 측정하지 못했다.** 지금까지의 모든 검증은 목 게이트웨이(OpenAI 호환 SSE) 기준이다. 사내 협조 대기 항목(C-1)이고, 이것이 **M1 완료 선언의 마지막 조건**이다(1.7.3 수용 시나리오).

확인해야 할 것:

- **SSE 스트리밍 품질** — 게이트웨이가 중계 과정에서 버퍼링하면 NFR-6(스트리밍 체감)이 우리 통제 밖에서 깨진다
- 비표준 응답 형태 → compat 플래그 확정 (pi·omp·grok 주입 모두 compat 전달 경로는 보유)
- `/v1/models` 응답 형태
- 사용자별 키 발급 API 유무 (C-4) → 자동 프로비저닝 가능 여부

이 회신 전까지 M1·M2 는 **완료 선언을 못 한 채** 기능만 완성돼 있는 상태다.
