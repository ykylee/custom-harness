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
- (2026-08-25 2차 갱신) **M1 코어 4개 WP 완료**: 1.1.2 protocol v0(이벤트 유니온 14종+와이어 user_message·RPC 17 method·capability 헬퍼·순수성 lint 게이트) → 1.2 데몬 코어(WS 서버·세션 매니저·JSONL 영속화·spawn 유틸·startDaemon 조립) → 1.3 pi 어댑터(pi 0.84.1 RPC 스키마 실측, JSONL 전송 base, 이벤트 정규화·승인 extension_ui 배선, mock 하네스 1급+공유 계약 스위트) → 1.4 게이트웨이(models.json 격리 주입·PI_OFFLINE 프리셋·KeyStore 0600 폴백+SecretCipher·config.\* RPC). 테스트 86건·typecheck·lint·format 그린. 설계서 2건 v1.1 개정(사용자 승인): protocol-design(user_message), adapter-contract(pi capability 실측 보정·승인 채널). 백로그 08-24/08-25 태스크 17건 상태 정합화(done).

## Work Status

- M1 WBS 1.5 렌더러 (골격→세션 생성→대화 뷰→툴 카드→승인/컴포저→온보딩): planned
- M1 WBS 1.6 Electron 셸·CLI (safeStorage SecretCipher 주입 포함): planned
- 사내 확인 C-1 게이트웨이 실측(M1 수용 전 필수)·C-2 저장소·C-3 서명 (docs/roadmap/m0-internal-checklist.md): blocked
- TASK-2026-08-25-main-012 M1 1.4 게이트웨이 연결(pi 주입·프리셋·키 관리): done
- TASK-2026-08-25-main-011 M1 1.3 pi 어댑터(RPC base·계약·승인·mock/계약 테스트): done
- TASK-2026-08-25-main-010 M1 1.2 데몬 코어(WS 서버·세션 매니저·영속화·spawn): done
- TASK-2026-08-25-main-009 M1 1.1.2 protocol 이벤트 유니온·RPC 스키마: done
- TASK-2026-08-25-main-008 M0 완료 선언 + M1 착수(1.1.1 모노레포 골격): done
- TASK-2026-08-25-main-007 M0 설계 일괄(0.2/0.3/0.4/0.6.2 + 0.7.1 pi 스파이크): done
- TASK-2026-08-25-main-006 결정 2건 확정 + 어댑터 설계서(0.1.2~0.1.5): done
- TASK-2026-08-25-main-005 grok 커스텀 LLM 실측(무로그인·session/set_model 확인): done
- TASK-2026-08-25-main-004 M0 착수(Windows 조사·grok 경로 조사·진척 보드 구축): done
- TASK-2026-08-25-main-003 요구사항·로드맵 14문서 승인 반영: done

## Key Changes

- packages/protocol — v0 완성: base/capabilities/events/connection/rpc 모듈, 이벤트 유니온 14종+와이어 전용 user_message, RPC 17 method(ok 판별 응답), 순수성 eslint 게이트(transform/catch/preprocess 금지)
- packages/daemon — 데몬 코어: server(토큰 2중 인증·hello 선행), session-manager(상태 전이 소유·turn_started/user_message 발행·interrupt 멱등·pending 추적·재기동 closed 정정), store(meta+timeline.jsonl 파손 내성), processes(절대 경로 spawn·단계 종료·PID 원장), startDaemon 조립
- packages/daemon/adapters — contract.ts(계약 코드화), jsonl-rpc/transport+pi(0.84.1 실측 스키마), mock.ts(1급, 시나리오 마커), contract-suite(공유 9케이스, fake-pi 픽스처)
- packages/daemon/gateway — pi-injection(관리 블록 병합·백업·드리프트 감지), key-store(0600 폴백+SecretCipher), service(env 오버레이·testKey·settings), server config.\* 배선
- docs/design/protocol-design.md v1.1·adapter-contract.md v1.1 — 승인 개정(구현 중 실측 발견 반영). docs/roadmap/PROGRESS.md — 1.1.2/1.2/1.3/1.4 done 기록

## Next Actions

- [ ] M1 1.5 렌더러(React) — 1.5.1 골격(WS 클라이언트·재연결·토큰·상태 스토어)부터. mock 어댑터로 어댑터 완성 대기 없이 개발 가능
- [ ] M1 1.6 Electron 셸·CLI — detached 데몬 spawn, safeStorage 를 SecretCipher 로 데몬에 주입(headless 복호화 실측 포함)
- [ ] 사내 확인 C-1 회신 수령(게이트웨이 /v1/models·SSE 품질·키 발급 절차) — M1 수용 전 필수. 회신 후 gateway compat 플래그·실통합 확정
- [ ] pi 실통합(실제 pi 바이너리 + 목 게이트웨이 1턴) — 1.7.2 NFR-1 스모크에서, grok 오프라인 스위치 v1.0.5 구문 재확인은 M2 2.2 진입 시

## Risks & Blockers

- 게이트웨이 SSE 스트리밍 품질·비표준 응답 미실측(C-1 대기) — M1 수용 기준의 입력, compat 플래그 확정 대기
- grok 바이너리 조달 경로가 GitHub Releases 없이 x.ai CDN 뿐 — 번들 파이프라인에 CDN 미러링 + 자체 해시 고정 필요(전 플랫폼)
- 하네스 설정 스키마 드리프트 실증(grok telemetry 구문 v1.0.5 변경, pi capability 표 2건 실측 보정) — 번들 버전 고정 + 관대 파싱 + 주입 템플릿 버전 관리로 완화
- pi 내장 툴에 승인 게이트 부재(0.84.1 실측) — 툴 실행 중재가 요구되면 pi 확장 훅 개발 필요(M2 검토). Electron safeStorage 의 headless(ELECTRON_RUN_AS_NODE) 가용성 실측 미완(1.6 첫 태스크)
