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

## 5. 미정 / 후속 결정 사항

- 기술 스택 (paseo 는 TypeScript — 따를지 여부 미정)
- UI 형태 (웹 / 데스크톱 / 모바일 중 어디까지)
- paseo 와의 차별점 — custom-harness 만의 고유 가치

> 진행 범위 합의: 컨셉 → 설계까지만 진행한다. 설계 이후(구현)로는 넘어가지 않는다.
