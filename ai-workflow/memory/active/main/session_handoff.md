<!-- standard-ai-workflow-kit: v1.4.0 -->

# Session Handoff

- Purpose: Compact restore context for the next AI agent session.
- Scope: current focus, task status, key changes, next actions, risks
- Audience: AI agents, maintainers
- Status: draft
- Updated: 2026-08-24
- Related docs: [Project Profile](../../docs/PROJECT_PROFILE.md), [Work Backlog](./work_backlog.md)

## Current Focus

- 컨셉 정의 단계 — paseo 류 멀티 하네스 오케스트레이션 도구. 컨셉 전달이 진행 중(사용자 완료 선언 전)이며, 합의된 진행 범위는 설계까지(구현 금지). 레퍼런스 조사는 완료: paseo 상세 분석 + 확장 하네스 3종 인터페이스 조사. 코드는 아직 없고 기술 스택 미정.

## Work Status

-
- N/A: blocked
- TASK-001 표준 AI 워크플로우 초기 도입: done
- TASK-002 컨셉 정의 및 레퍼런스(paseo)·확장 하네스 조사: done

## Key Changes

- docs/CONCEPT.md — 컨셉 문서 (지원 하네스 7종, 1차 타깃 claude/codex/pi)
- docs/reference/paseo-analysis.md — paseo 4영역 상세 분석 (하네스 추상화, 통신, UI, 확장 3축 Skill/MCP/Plugin)
- docs/reference/harness-interfaces.md — oh my pi / grok build / antigravity 조사 (셋 다 CLI 래핑 가능, 어댑터 계보 3갈래)
- paseo 레퍼런스 체크아웃: ~/repos/paseo (shallow clone)

## Next Actions

- [ ] 컨셉 전달 계속 수신 (미정: 기술 스택, UI 형태, paseo 와의 차별점)
- [ ] 컨셉 완료 선언 후 설계 단계 진입 — paseo-analysis.md §9 미해결 질문(ACP vs Direct, 데몬/릴레이 범위)부터

## Risks & Blockers

- N/A
