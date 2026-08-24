---
id: TASK-2026-08-24-custom-harness-002
status: done
created_at: 2026-08-24
source_anchor: generic-task-2026-08-24-custom-harness-002
source_path: backlog/2026-08-24.md
kind: generic
---

<!-- standard-ai-workflow-kit: v1.4.0 -->

# TASK-2026-08-24-custom-harness-002 — 컨셉 정의 및 레퍼런스(paseo)·확장 하네스 조사

## 📝 Description

- Status: done
- Priority: high
- Request date: 2026-08-24
- Owner: yklee
- Description: 제품 컨셉 문서화(CONCEPT.md), paseo 구성 상세 분석, 확장 타깃 하네스 3종(oh my pi / grok build / antigravity) 인터페이스 조사
- Completion criteria: CONCEPT.md 에 지원 하네스·1차 타깃 확정, docs/reference/ 에 paseo 분석·하네스 조사 문서가 존재하고 상호 링크됨

## 🛠️ Implementation / Content

- Progress: `2026-08-24` CONCEPT.md 작성 (지원 하네스 7종, 1차 타깃 claude/codex/pi). paseo shallow clone 후 4영역 병렬 분석 → docs/reference/paseo-analysis.md (확장 3축 Skill/MCP/Plugin 포함). 확장 하네스 3종 조사 → docs/reference/harness-interfaces.md (셋 다 CLI 래핑 가능, 어댑터 계보 3갈래).
- Next session starting point: 설계 단계 진입 — paseo-analysis.md §9 미해결 질문(ACP vs Direct, 데몬/릴레이 범위)부터.
- Remaining risks: 컨셉 전달이 아직 진행 중(사용자 완료 선언 전). 진행 범위 합의는 설계까지 — 구현 금지.

## ✅ Outcome

- Result: docs/CONCEPT.md, docs/reference/paseo-analysis.md, docs/reference/harness-interfaces.md 작성 완료
- Verification: 문서 상호 링크 확인, paseo 분석은 소스 실측(파일 경로 근거), 하네스 조사는 공식 문서·paseo 소스 교차 검증
- Follow-up: 설계 문서 착수 시 두 reference 문서를 입력으로 사용
