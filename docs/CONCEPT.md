<!-- standard-ai-workflow-kit: v1.4.0 -->

# Concept

- 문서 목적: custom-harness 의 제품 컨셉을 기록한다. 컨셉 전달이 진행 중이며, 완료 선언 전까지 계속 갱신된다.
- 상태: draft (컨셉 전달 진행 중)
- 최종 수정일: 2026-08-24
- 관련 문서: [PURPOSE](../ai-workflow/memory/active/PURPOSE.md), [PROJECT_PROFILE](./PROJECT_PROFILE.md)

## 1. 한 줄 요약

여러 코딩 에이전트 하네스를 래핑해 하나의 UI에서 선택·사용할 수 있게 하는 오케스트레이션 도구. (paseo 류)

## 2. 핵심 아이디어

- **UI 제공**: 사용자는 하네스별 CLI 를 직접 다루는 대신 통합 UI 를 통해 에이전트를 사용한다.
- **하네스 래핑**: Claude Code 등 여러 코딩 에이전트 하네스를 각각 래핑한다.
- **선택 사용**: 래핑된 하네스 중 원하는 것을 골라 사용할 수 있다.

## 3. 레퍼런스

- **paseo** ([getpaseo/paseo](https://github.com/getpaseo/paseo), 14.9k★) — "One interface for Claude Code, Codex, Copilot, OpenCode, and Pi agents"
  - 로컬 체크아웃: `~/repos/paseo` (shallow clone)
  - **상세 분석 완료**: [paseo 구성 상세 분석](./reference/paseo-analysis.md) — 데몬 중심 아키텍처, 하네스 추상화(`AgentClient`/`AgentSession`), 프로토콜/릴레이, 멀티 에이전트 UI 패턴, 플러그인 시스템, 인프라 전반.

## 4. 지원 하네스

### 1차 타깃

1. claude (Claude Code)
2. codex
3. pi

### 이후 확장

4. opencode
5. oh my pi
6. grok build
7. antigravity

- 확장 타깃 3종(oh my pi / grok build / antigravity)의 통합 인터페이스 조사 완료 — [하네스 인터페이스 조사](./reference/harness-interfaces.md). 셋 다 CLI 래핑으로 통합 가능.
- **게이트웨이 호환 조사 완료** — [게이트웨이 호환 조사](./reference/gateway-compatibility.md). pi/omp/grok build 직결 가능, claude/codex 변환 프록시 필요, opencode 조건부. **antigravity 는 폐쇄망 사실상 불가 → 지원 목록 제외 검토 필요.**
- **확장 공유 조사 완료** — [스킬/MCP/플러그인 공유 조사](./reference/extension-sharing.md). 스킬은 SKILL.md 표준으로 무변환 공유 가능, MCP 는 서버 1개 + 설정 변환, 플러그인은 내용물만 공유 가능.

## 5. 운영 환경 제약 (사내망)

이 도구는 **사내망에서 사용**된다. 이 제약이 컨셉의 성격을 규정한다.

- **외부 네트워크 참조 최소화**: 폐쇄망 전제. 외부 API·CDN·원격 서비스 의존을 최소화해야 한다.
- **모델 연결은 지정 게이트웨이로만**: 하네스가 모델 프로바이더를 직접 호출하지 않고, 모든 LLM 트래픽이 **커스텀 게이트웨이**를 경유해야 한다.
- **게이트웨이는 현재 OpenAI 호환 API만 제공**: 하네스가 다른 API 형식을 쓰면 **변환(컨버전)이 필요**하다.
  - 예: Claude Code 는 Anthropic Messages API, Codex 는 OpenAI Responses API 를 사용 → OpenAI 호환 형식으로 변환해 게이트웨이로 전달.
  - 즉 "하네스 엔드포인트를 게이트웨이로 돌리는 것 + API 형식 호환 계층"이 이 도구의 기본 요건이다.
- **토큰 제약 있음**: 토큰 예산이 제한적이므로, 같은 작업을 여러 하네스에 중복 실행하는 크로스 하네스 오케스트레이션은 가치가 낮을 수 있다.

## 6. 미정 / 후속 결정 사항

- paseo 와의 차별점 — **보류**: 컨셉을 더 정리한 뒤 사내망·게이트웨이 제약을 반영해 재검토 (토큰 제약으로 크로스 하네스 오케스트레이션 축은 후순위 가능성)
- 게이트웨이 변환 계층의 형태 — 프록시 서버로 둘지 하네스별 설정 주입으로 풀지, 어떤 API 형식(Messages / Responses)까지 변환할지
- 기술 스택 (paseo 는 TypeScript — 따를지 여부 미정)
- UI 형태 (웹 / 데스크톱 / 모바일 중 어디까지)

> 진행 범위 합의: 컨셉 → 설계까지만 진행한다. 설계 이후(구현)로는 넘어가지 않는다.
