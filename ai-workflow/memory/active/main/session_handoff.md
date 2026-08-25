<!-- standard-ai-workflow-kit: v1.4.0 -->

# Session Handoff

- Purpose: Compact restore context for the next AI agent session.
- Scope: current focus, task status, key changes, next actions, risks
- Audience: AI agents, maintainers
- Status: draft
- Updated: 2026-08-25
- Related docs: [Project Profile](../../docs/PROJECT_PROFILE.md), [Work Backlog](./work_backlog.md)

## Current Focus

- 컨셉 정의 단계 — paseo 류 멀티 하네스 오케스트레이션 도구, **사내망(폐쇄망) 전용**. 핵심 제약: 모든 LLM 트래픽은 커스텀 게이트웨이(OpenAI 호환만) 경유, 외부 참조 최소화, 토큰 제약. 컨셉 전달 진행 중(완료 선언 전), 진행 범위는 설계까지(구현 금지). 레퍼런스·게이트웨이·확장 공유 조사 완료. 코드 없음, 기술 스택 미정.
- (2026-08-25 갱신) **기준선 전면 갱신**: 컨셉 완료 선언(08-24) → 요구사항 v2·로드맵 v2(M0~M4 WBS) 승인 → **M0 설계 완료**(설계서 6종 approved) → **M1 착수, 1.1.1 모노레포 골격 완료**(typecheck·test·lint 그린). 진행 범위는 사용자 지시로 **SDLC 단계별 순차 진행(구현 포함)** 으로 변경. 확정: 1차 하네스 pi/omp/grok(ACP·GROK_HOME 격리), Windows 번들 omp+pi(조건부)·grok 제외, 주입은 격리 우선(pi `PI_CODING_AGENT_DIR` 실측 확정). 작업 원칙: 로드맵·WBS 기반 진행, 진척은 docs/roadmap/PROGRESS.md + 백로그 기록, 계획 변경 시 원 문서 동기화 필수 (PROJECT_PROFILE §4).

## Work Status

- M1 WBS 1.1.2 — protocol 이벤트 유니온(FR-1.4)·RPC 스키마 작성: in_progress
- 사내 확인 C-1 게이트웨이 실측(M1 수용 전 필수)·C-2 저장소·C-3 서명 (docs/roadmap/m0-internal-checklist.md): blocked
- TASK-2026-08-25-main-008 M0 완료 선언 + M1 착수(1.1.1 모노레포 골격): done
- TASK-2026-08-25-main-007 M0 설계 일괄(0.2/0.3/0.4/0.6.2 + 0.7.1 pi 스파이크): done
- TASK-2026-08-25-main-006 결정 2건 확정 + 어댑터 설계서(0.1.2~0.1.5): done
- TASK-2026-08-25-main-005 grok 커스텀 LLM 실측(무로그인·session/set_model 확인): done
- TASK-2026-08-25-main-004 M0 착수(Windows 조사·grok 경로 조사·진척 보드 구축): done
- TASK-2026-08-25-main-003 요구사항·로드맵 14문서 승인 반영: done
- TASK-2026-08-25-main-002 로드맵 세분화(마일스톤 WBS 5종): done
- TASK-2026-08-25-main-001 요구사항 상세 세분화(카테고리 7종): done
- TASK-2026-08-24-main-007 컨셉 완료 선언 및 진행 범위 갱신: done
- TASK-2026-08-24-main-006 컨셉 전체 리뷰·정합성 수정(PURPOSE v2): done

## Key Changes

- docs/CONCEPT.md — done 선언. §4 오픈소스 우선(1차 pi/omp/grok, claude/codex 후순위, antigravity 제외), §6 차별점 4축(동봉 패키지/게이트웨이/zero-config/확장 공유), §7 전부 확정
- docs/REQUIREMENTS.md + requirements/ 7종, docs/ROADMAP.md + roadmap/ 5종 — approved. PROGRESS.md 진척 보드 + m0-internal-checklist.md(C-1~C-5) 신설
- docs/design/ — 기존 3종(packaging/ui-form/tech-stack) + M0 산출 6종(adapter-contract/protocol-design/daemon-design/credential-injection-design/test-strategy/dev-standards) 전부 approved
- docs/reference/ 신규 — windows-support.md(omp 네이티브/pi 조건부/grok best-effort+릴리스 asset 부재), grok-integration-paths.md(ACP 확정 + §3 실측: 무로그인 커스텀 모델·set_model·usage)
- 코드 신규 — 모노레포 골격(packages/protocol·daemon·renderer·shell·cli + bundle/), protocol 초판(PROTOCOL_VERSION·Hello 스키마 + 테스트 2건)
- ai-workflow/memory/active/PURPOSE.md — v2 개정(자체 루프 구축 → 래핑 오케스트레이션으로 방향 재정의)

## Next Actions

- [ ] M1 1.1.2 완료 → 1.2 데몬 코어(WS 서버·세션 매니저·JSONL 영속화) → 1.3 pi 어댑터(RPC 스키마 발견 = 0.7.1 이월분 포함)
- [ ] 사내 확인 C-1 회신 수령(게이트웨이 /v1/models·SSE 품질·키 발급 절차) — M1 수용 전 필수
- [ ] omp 격리 env 유무 확인(M2 2.1 시), grok 오프라인 스위치 v1.0.5 구문 재확인 후 주입 템플릿 반영

## Risks & Blockers

- 게이트웨이 SSE 스트리밍 품질·비표준 응답 미실측(C-1 대기) — M1 수용 기준의 입력
- grok 바이너리 조달 경로가 GitHub Releases 없이 x.ai CDN 뿐 — 번들 파이프라인에 CDN 미러링 + 자체 해시 고정 필요(전 플랫폼)
- 하네스 설정 스키마 드리프트 실증(grok telemetry 구문 v1.0.5 변경) — 번들 버전 고정 + 관대 파싱 + 주입 템플릿 버전 관리로 완화
- (종결 2026-08-25) Gemini CLI 지속 여부 상충 정보 — antigravity 제외 확정으로 대안 검토 근거 소멸
