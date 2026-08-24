<!-- standard-ai-workflow-kit: v1.4.0 -->

# Session Handoff

- Purpose: Compact restore context for the next AI agent session.
- Scope: current focus, task status, key changes, next actions, risks
- Audience: AI agents, maintainers
- Status: draft
- Updated: 2026-08-24
- Related docs: [Project Profile](../../docs/PROJECT_PROFILE.md), [Work Backlog](./work_backlog.md)

## Current Focus

- 컨셉 정의 단계 — paseo 류 멀티 하네스 오케스트레이션 도구, **사내망(폐쇄망) 전용**. 핵심 제약: 모든 LLM 트래픽은 커스텀 게이트웨이(OpenAI 호환만) 경유, 외부 참조 최소화, 토큰 제약. 컨셉 전달 진행 중(완료 선언 전), 진행 범위는 설계까지(구현 금지). 레퍼런스·게이트웨이·확장 공유 조사 완료. 코드 없음, 기술 스택 미정.

## Work Status

-
- N/A: blocked
- TASK-001 표준 AI 워크플로우 초기 도입: done
- TASK-002 컨셉 정의 및 레퍼런스(paseo)·확장 하네스 조사: done
- TASK-003 사내망 제약 반영: 게이트웨이 호환·확장 공유 조사: done

## Key Changes

- docs/CONCEPT.md — §5 운영 환경 제약(사내망·게이트웨이·토큰) 신설, 차별점 논의는 보류
- docs/reference/paseo-analysis.md — paseo 4영역 상세 분석 + 확장 3축(Skill/MCP/Plugin)
- docs/reference/harness-interfaces.md — omp/grok build/antigravity 인터페이스 (셋 다 CLI 래핑 가능)
- docs/reference/gateway-compatibility.md — 게이트웨이 연결: pi/omp/grok 직결, claude/codex 변환 프록시(LiteLLM 류 1대로 해결), opencode 조건부, antigravity 사실상 불가
- docs/reference/extension-sharing.md — 스킬 무변환 공유 가능(SKILL.md 표준), MCP 서버 1개+설정 변환, 플러그인 내용물만
- paseo 레퍼런스 체크아웃: ~/repos/paseo (shallow clone)

## Next Actions

- [ ] antigravity 지원 목록(CONCEPT §4) 제외 여부 — 사용자 결정 대기 (폐쇄망 사실상 불가 판정)
- [ ] 차별점 재검토 (보류 중 — 게이트웨이 호환 계층이 유력 후보) 및 남은 미정(기술 스택, UI 형태) 논의
- [ ] 컨셉 완료 선언 후 설계 단계 진입 — 변환 계층(LiteLLM vs 자체), ACP vs Direct, 데몬 범위

## Risks & Blockers

- Gemini CLI 지속 여부 상충 정보(활성 vs 2026-06 종료) — 대안 검토 시 재확인 필요
