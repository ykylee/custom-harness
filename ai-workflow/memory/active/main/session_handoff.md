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
- (2026-08-25 3차 갱신) **M1 구현 전 구간 완료 — 수용(1.7.3)만 C-1 대기**: 1.5 렌더러(React 19+Vite 5 — DaemonClient 재연결·seq 재동기화, 자체 스토어, 타임라인 리듀서, 대화 뷰·툴/승인 카드·컴포저·온보딩·설정) → 1.6 셸·CLI(공용 런처 detached spawn·stale pid 정리, daemon start/stop/status/version, Electron RUN_AS_NODE 실기 스모크로 FR-4.1.3 실증, **safeStorage headless 불가 실측 확정 → credential-injection-design v1.1 개정**) → 1.7.1 번들 프로토타입(151MB tar.gz, manifest dirHash, INSTALL.md, --verify 통과) + 1.7.2 **NFR-1 스모크 PASS**(목 게이트웨이 SSE + 실물 pi 1턴 + lsof 판정 — 허용 외 커넥션 0건). 테스트 108건 그린. **M1 완료 선언의 잔여 조건 = C-1 실 게이트웨이 실측 → 1.7.3 수용 시나리오**.

## Work Status

- 사내 확인 C-1 게이트웨이 실측 → 1.7.3 M1 수용 시나리오(실 게이트웨이 교체·승인 포함 코드 수정·재시작 재개), C-2 저장소·C-3 서명 (docs/roadmap/m0-internal-checklist.md): blocked
- M2 선행 후보 — omp 어댑터(JSONL base 확장·v2 청킹), grok 어댑터(ACP), 멀티 세션 UI: planned
- TASK-2026-08-25-main-015 M1 1.7 번들 프로토타입·NFR-1 스모크: done
- TASK-2026-08-25-main-014 M1 1.6 Electron 셸·CLI: done
- TASK-2026-08-25-main-013 M1 1.5 렌더러: done
- TASK-2026-08-25-main-012 M1 1.4 게이트웨이 연결: done
- TASK-2026-08-25-main-011 M1 1.3 pi 어댑터: done
- TASK-2026-08-25-main-010 M1 1.2 데몬 코어: done
- TASK-2026-08-25-main-009 M1 1.1.2 protocol 이벤트 유니온·RPC 스키마: done
- TASK-2026-08-25-main-008 M0 완료 선언 + M1 착수(1.1.1 모노레포 골격): done
- TASK-2026-08-25-main-007 M0 설계 일괄(0.2/0.3/0.4/0.6.2 + 0.7.1 pi 스파이크): done
- TASK-2026-08-25-main-006 결정 2건 확정 + 어댑터 설계서(0.1.2~0.1.5): done

## Key Changes

- packages/renderer — 1.5 전체: ws/client(재연결·ping/pong·seq 재동기화), store(자체 useSyncExternalStore)+app-store(컨트롤러), timeline(순수 리듀서), views(Conversation/SessionCreate/Onboarding/Settings)+components(ToolCard/PermissionCard/Composer/Markdown), vite 빌드(dist-web)
- packages/daemon — launcher.ts(detached spawn·stale pid 정리 FR-5.2), main.ts(실행 진입점, env 계약: HOME/PORT/PI_PATH/**PI_ENTRY**/MANAGED_BY), daemon.pid 에 port 추가, startDaemon 어댑터 팩토리, pi 어댑터 turnId 선할당 경합 수정
- packages/cli — daemon start/stop[--force]/status/version (status·stop 은 WS 질의), packages/shell — Electron 메인(데몬 기동/부착·dist-web 로드·contextIsolation)
- bundle/build-bundle.mjs — macOS arm64 번들 조립+manifest+INSTALL.md+--verify. scripts/nfr1-smoke.mjs — NFR-1 스모크(PASS 기록). .gitignore 에 dist-web/·bundle/out/ 추가
- docs/design/credential-injection-design.md v1.1 — safeStorage headless 불가 실측 확정 반영(승인). docs/roadmap/PROGRESS.md — 1.5/1.6/1.7.1/1.7.2 done, 1.7.3 blocked 기록

## Next Actions

- [ ] **C-1 실 게이트웨이 실측 회신 수령** → 1.7.3 M1 수용 시나리오 실행(실 게이트웨이 교체, 승인 1회 포함 코드 수정 1건, 데몬 재시작 재개, NFR-1 재확인) → M1 완료 선언
- [ ] C-1 대기 중 선행 가능: M2 착수 — 2.1 omp 어댑터(JSONL base 확장: v2 협상·rpc_chunk 청킹·리플레이 드롭·격리 env 확인), 2.2 grok 어댑터(ACP 클라이언트·GROK_HOME 주입·오프라인 스위치 v1.0.5 구문 재확인)
- [ ] M2 개정 포인트 누적분: safeStorage 셸 IPC 위임(SecretCipher 배선), NFR-1 UDP/DNS 캡처 강화, pi 승인 게이트(확장 훅) 검토, mcpServers 재개 시 재주입

## Risks & Blockers

- 게이트웨이 SSE 스트리밍 품질·비표준 응답 미실측(C-1 대기) — M1 수용 기준의 입력, compat 플래그 확정 대기
- grok 바이너리 조달 경로가 GitHub Releases 없이 x.ai CDN 뿐 — 번들 파이프라인에 CDN 미러링 + 자체 해시 고정 필요(전 플랫폼)
- 하네스 설정 스키마 드리프트 실증(grok telemetry v1.0.5, pi capability 표 2건 실측 보정) — 번들 버전 고정 + 관대 파싱 + 주입 템플릿 버전 관리로 완화
- pi 내장 툴 승인 게이트 부재(0.84.1 실측) — M1 수용 기준의 "승인 1회 포함"은 extension_ui 경유 확인 필요, 미발생 시 pi 확장 훅(M2) 선행 검토
- 번들 프로토타입은 로컬 설치본 복사 방식 — 사외 빌드 파이프라인·재현성(FR-4.7)은 M2, Electron.app 서명·공증은 M3
