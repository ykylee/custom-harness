<!-- standard-ai-workflow-kit: v1.4.0 -->

# Project Workflow Profile

- 문서 목적: 프로젝트 특화 규칙과 실행/검증 기준을 정의한다.
- 범위: 프로젝트 개요, 문서 구조, 기본 명령, 검증 포인트, 예외 규칙
- 대상 독자: 개발자, 운영자, AI agent, 프로젝트 온보딩 담당자
- 상태: draft
- 최종 수정일: 2026-08-31
- 관련 문서: [공통 표준](../ai-workflow/core/global_workflow_standard.md)

## 1. 프로젝트 개요
- 프로젝트명: Custom Harness
- 프로젝트 목적: 폐쇄망(사내망)용 멀티 하네스 오케스트레이션 도구 — 오픈소스 코딩 에이전트 하네스들을 동봉 설치하고 게이트웨이 연결을 사전 구성해 하나의 데스크톱 UI 로 사용 (상세는 [PURPOSE](../ai-workflow/memory/active/PURPOSE.md) v2, [CONCEPT](./CONCEPT.md))
- 주요 이해관계자: yklee (개인 프로젝트)

## 2. 문서 구조 (Path)
- 문서 위키 홈: README.md
- 운영 문서 홈: ai-workflow/memory/active/
- 백로그 위치: ai-workflow/memory/active/backlog/
- 세션 인계 문서: <ai-workflow/memory/active/sessions>
- 환경 기록 위치: <ai-workflow/memory/active/repository_assessment.md>

## 3. 기본 명령 (Commands)
- 설치: `npm install`
- 로컬 실행: `npm run typecheck` 후 `npm run -w @custom-harness/shell start` (Electron 앱) / 데몬 단독 `node packages/cli/dist/index.js daemon start`
- 빠른 테스트: `npm test`
- 격리 테스트: `npx vitest run <path>`
- 실행 확인: `npm run smoke:nfr1` (외부 접속 0) / `npm run smoke:terminal` (번들 pty 왕복) / `npm run smoke:m7` (M7 완료 기준 수용) / `npm run smoke:update` (업데이트·롤백) / `npm run smoke:nfr8` (설치 원자성 — 실패 주입)
- 커밋 전 게이트: `npm run typecheck && npm test && npm run lint && npm run format:check`

## 4. 검증 포인트 (Validation)
- 작업 진행: **모든 작업은 로드맵·WBS(docs/ROADMAP.md + docs/roadmap/) 기반으로만 진행** — 착수 전 WBS ID 식별, 계획에 없는 작업은 먼저 계획 등재 (2026-08-25 확정)
- 진척 보고: 작업 단위마다 WBS ID 기준으로 `docs/roadmap/PROGRESS.md` + 백로그(wk backlog-update)에 기록하고 사용자 보고에 포함
- 문서 변경: 계획 변경 발생 시 **기존 문서 동기화 필수** — 요구사항 변경 → REQUIREMENTS+requirements/, 범위·일정 변경 → ROADMAP+roadmap/, 컨셉 수준 변경 → CONCEPT/PURPOSE. approved 문서는 개정 이력 표기
- 코드 변경: 기술 스택 확정(TS/Electron/React) — 테스트·CI 게이트는 M0 0.6.2 에서 정의 예정

## 5. 예외 규칙 (Policy)
- 승인: 기준선 문서(CONCEPT/REQUIREMENTS/ROADMAP 및 하위)의 상태 전환(draft→approved)과 approved 문서의 실질 변경은 사용자 승인 필수
- 제약: 폐쇄망 전제 — 산출물은 런타임 외부 네트워크 참조 금지(NFR-1). paseo(AGPL-3.0) 코드 재사용 금지(패턴 참고만, NFR-4)
- 기타: 사내 환경 확인 항목(게이트웨이·저장소·서명)은 사용자 협조 필요 — 체크리스트로 요청

## 다음에 읽을 문서
- [세션 인계 문서](../ai-workflow/memory/active/sessions)
- [작업 백로그](../ai-workflow/memory/active/backlog)
