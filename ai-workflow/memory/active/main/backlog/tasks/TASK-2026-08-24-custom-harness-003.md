---
id: TASK-2026-08-24-custom-harness-003
status: done
created_at: 2026-08-24
source_anchor: generic-task-2026-08-24-custom-harness-003
source_path: backlog/2026-08-24.md
kind: generic
---

<!-- standard-ai-workflow-kit: v1.4.0 -->

# TASK-2026-08-24-custom-harness-003 — 사내망 제약 반영: 게이트웨이 호환·확장 공유 조사

## 📝 Description

- Status: done
- Priority: high
- Request date: 2026-08-24
- Owner: yklee
- Description: 사내망 제약(커스텀 OpenAI 호환 게이트웨이 강제, 폐쇄망) 컨셉 반영 + 하네스 7종 게이트웨이 연결 방법 조사 + 스킬/MCP/플러그인 단일 형태 공유 가능성 조사
- Completion criteria: CONCEPT.md 에 제약 섹션 존재, docs/reference/ 에 게이트웨이·확장 공유 조사 문서 존재

## 🛠️ Implementation / Content

- Progress: `2026-08-24` CONCEPT.md §5 운영 환경 제약 신설. 조사 3건 병렬 수행 → docs/reference/gateway-compatibility.md (pi/omp/grok 직결, claude/codex 변환 프록시 필요, opencode 조건부, antigravity 사실상 불가), docs/reference/extension-sharing.md (스킬 무변환 공유 가능, MCP 설정 변환, 플러그인 내용물만).
- Next session starting point: antigravity 지원 목록 제외 여부 사용자 결정 대기. 이후 차별점 재검토(보류 중) 및 남은 미정(기술 스택, UI 형태) 논의.
- Remaining risks: Gemini CLI 지속 여부 상충 정보(활성 vs 2026-06 종료) — 대안 검토 시 재확인 필요. grok build 세부 플래그 일부는 2차 출처.

## ✅ Outcome

- Result: docs/reference/gateway-compatibility.md, docs/reference/extension-sharing.md 작성, CONCEPT.md §5(사내망 제약)·§6(미정) 재구성
- Verification: 공식 문서·오픈소스 리포 직접 확인 + paseo 소스 실측 교차 검증, 미확인 항목은 "확인 불가"로 명시
- Follow-up: 설계 단계에서 변환 계층(LiteLLM vs 자체 구현) 결정, antigravity 제외 확정 시 CONCEPT §4 갱신
