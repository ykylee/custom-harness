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
- (2026-08-25 4차 갱신) **M2 WBS 전 구간(2.1~2.7) 사외 수행분 완료**: 2.1 omp 어댑터(공용 session-core 추출·v2 협상+rpc_chunk·리플레이 가드·models.yml/config.yml 주입 — 공개 소스(MIT)+바이너리 실측) → 2.2 grok ACP 어댑터(잔여 실측 4건 해소: load 리플레이·승인 옵션 2종·cancel·SIGTERM 저장, config.toml 주입 — env_key·오프라인 3스위치 현행 구문) → 2.3 데몬 멀티 세션(혼합 5세션 격리·maxSessions 설정·PID 원장 reap·manifest 대조·모델 카탈로그·경계 검사) → 2.4 멀티 세션 UI(사이드바 버킷·탭/2분할+복원·단축키·설정 완성·사용량 3면·트레이+알림·자동 승인 opt-in) → 2.5 번들(manifest 도구·install.sh/ps1·3 OS 실조립: darwin 205.7/linux 244.4/win 260.7MB — darwin 은 설치+데몬 스모크 실검증) → 2.6 doctor/logs(실물 번들 전 항목 검증) → 2.7 검증(NFR-1 v2: 실물 3하네스 1턴+혼합 6세션 부하 PASS, 매트릭스 문서 darwin 열 실측). 동시성 버그 2건 부하로 검출·수정(meta·PID 원장 쓰기 경합). adapter-contract v1.2·v1.3, credential-injection-design v1.2 개정(사용자 승인). 테스트 191건·typecheck·lint·format 그린. **M2 완료 선언 잔여 = 전부 사내 협조**: C-5 실기기(linux/win), grok linux CDN 미러 절차, C-1(M1 수용 선행)
- (2026-08-25 5차 갱신) **사외 가능분 소진 — grok Linux 조달 + M3 선행 2건 완료**: grok linux-x64 조달 절차 확정(x.ai CDN primary/GCS fallback 이중 소스 sha256 교차 검증 — 체크섬 미공개 실측 확인, packaging §6-1 신설) → sources.json 고정 기입 → linux 번들 3하네스 구성 전환(307MB→최종 308.9MB). M3 선행: 3.3.1 라이선스 고지(licenses/ NOTICE+원문 전체 동봉 자동화 — 하네스 3종·Electron Chromium/Node 고지·의존 4종, licenses-src/PROVENANCE.md 반입 기록, grok upstream NOTICE 부재 확인) + 3.5.2 제거 스크립트(uninstall.sh/ps1 — 기본 데이터 보존·--purge 확인 후 삭제, 격리 루트 스모크 3케이스 통과). 3 OS 재조립·manifest 검증·lint 그린. **잔여는 전부 사내 협조(C-1·C-5)**.
- (2026-08-25 3차 갱신) **M1 구현 전 구간 완료 — 수용(1.7.3)만 C-1 대기**: 1.5 렌더러(React 19+Vite 5 — DaemonClient 재연결·seq 재동기화, 자체 스토어, 타임라인 리듀서, 대화 뷰·툴/승인 카드·컴포저·온보딩·설정) → 1.6 셸·CLI(공용 런처 detached spawn·stale pid 정리, daemon start/stop/status/version, Electron RUN_AS_NODE 실기 스모크로 FR-4.1.3 실증, **safeStorage headless 불가 실측 확정 → credential-injection-design v1.1 개정**) → 1.7.1 번들 프로토타입(151MB tar.gz, manifest dirHash, INSTALL.md, --verify 통과) + 1.7.2 **NFR-1 스모크 PASS**(목 게이트웨이 SSE + 실물 pi 1턴 + lsof 판정 — 허용 외 커넥션 0건). 테스트 108건 그린. **M1 완료 선언의 잔여 조건 = C-1 실 게이트웨이 실측 → 1.7.3 수용 시나리오**.

## Work Status

- 사내 확인 C-1 게이트웨이 실측 → 1.7.3 M1 수용 시나리오, C-5 실기기(linux/win 매트릭스·install.ps1/uninstall.ps1·pi Windows 조건부 판정), C-2 저장소·C-3 서명 (docs/roadmap/m0-internal-checklist.md, m2-smoke-matrix.md): blocked
- M3 잔여 후보(사내 협조 무관 순수 사외분 아님 — 대부분 C-1·C-5 후속) — 3.1 업데이트·롤백, 3.3.2 앱 정보 화면 고지 열람·clean-room 검수, 서명(C-3), M2 개정 포인트 누적분(safeStorage 셸 IPC 위임, UDP/DNS 캡처, pi 승인 확장 훅, mcpServers 재개 재주입, grok compat): planned
- TASK-2026-08-25-main-025 M3 3.5.2 제거 스크립트(uninstall.sh/ps1·스모크): done
- TASK-2026-08-25-main-024 M3 3.3.1 라이선스 고지(NOTICE·원문 동봉 자동화): done
- TASK-2026-08-25-main-023 grok Linux 조달(CDN 미러·자체 해시 고정): done
- TASK-2026-08-25-main-022 M2 2.7 검증(NFR-1 v2·매트릭스·부하): done
- TASK-2026-08-25-main-021 M2 2.6 CLI·진단(doctor·logs): done
- TASK-2026-08-25-main-020 M2 2.5 번들·설치 완성(3 OS): done
- TASK-2026-08-25-main-019 M2 2.4 멀티 세션 UI: done
- TASK-2026-08-25-main-018 M2 2.3 데몬 멀티 세션 완성: done
- TASK-2026-08-25-main-017 M2 2.2 grok 어댑터(ACP·주입·승인): done
- TASK-2026-08-25-main-016 M2 2.1 omp 어댑터(전송 v2·어댑터·주입): done

## Key Changes

- (5차) bundle/sources.json — grok linux-x64 url/fallbackUrl/sha256 고정(`9ba87444…7238`, 이중 소스 교차 검증). bundle/licenses-src/ 신규 — pi·omp·grok 라이선스 원문 반입 + PROVENANCE.md(출처·해시·수집일). build-bundle.mjs — licenses/ 전면 개편(NOTICE 생성·원문 동봉·타깃별 조건부 고지), uninstall 동봉, INSTALL.md 제거·라이선스 절, RUNTIME_DEPS 상수화. bundle/uninstall.sh·uninstall.ps1 신규. bundle/README.md 현행화. 문서: packaging §6-1 신설(조달 절차 5단계), m2-smoke-matrix(linux 열 grok 대상 전환·307MB→308.9MB), PROGRESS.md M3 선행 섹션, windows-support 후속 반영

- packages/daemon — adapters/jsonl-rpc/{session-core.ts 신규(pi·omp 공용), transport.ts(rpc_chunk 재조립·송신 1MiB 가드), omp.ts+fake-omp}, adapters/acp/{client.ts, grok.ts+fake-grok}, gateway/{omp,grok}-injection.ts(+service 배선·buildEnv 3하네스), manifest.ts(관대 로더+dirHash/verifyBundleTree), processes.ts(reapStale·daemonPid·하네스 stderr 로그·원장 직렬화), session-manager.ts(metaChain 직렬화·running 역전 가드·usage 누적·probeHarness·setMaxSessions), server.ts(harness.list models/warnings·config maxSessions), multi-session.test 등 테스트 82건 신규 (총 191건)
- packages/protocol — HarnessInfo.warnings·SessionSummary.usage (additive 2건). packages/renderer — 탭/2분할 레이아웃(localStorage 복원)·Sidebar/Tabs 컴포넌트·단축키·Settings 완성(기본 모델·하네스 패널·알림)·자동 승인 opt-in·턴별/누적 사용량·Notification 알림. packages/shell — 트레이 상주(창 닫기=숨김·WS 세션 요약 메뉴). packages/cli — doctor(6영역 진단)·logs(목록+tail)
- bundle/ — lib/manifest.mjs·tools/(manifest-tool·install-presets)·install.sh(실검증)·install.ps1·sources.json(고정 해시)·build-bundle.mjs 3 OS 개편(out: darwin/linux/win 아카이브+sha256). scripts/nfr1-smoke.mjs v2(3하네스+부하). vitest include .tsx 수정. 의존 추가: yaml·smol-toml(무의존)
- docs — adapter-contract v1.2/v1.3·credential-injection-design v1.2(승인 개정), grok-integration-paths §3-1(잔여 실측 해소), m2-smoke-matrix.md 신설, PROGRESS.md M2 섹션(2.1~2.7 done)
- 실측 확정(구현 근거): omp 17.3.8 — PI_CODING_AGENT_DIR 동일 지원·apiKey bare env 명·PI_OFFLINE 미지원·stdin 무청킹·재개 무리플레이 / grok 1.0.5 — load 응답 전 리플레이·승인 옵션 2종·거부=턴 완결·SIGTERM 저장·[cli]/[features] 오프라인 구문·env_key

## Next Actions

- [ ] **C-1 실 게이트웨이 실측 회신** → 1.7.3 M1 수용 시나리오 → M1 완료 선언 (M2 완료 선언의 선행)
- [ ] **C-5 실기기 실측 요청** — linux/win 매트릭스(m2-smoke-matrix.md 절차: install→doctor→온보딩→1턴→NFR-1, linux 는 grok 포함 3하네스), pi Windows 조건부 판정, install.ps1·uninstall.ps1 검증
- [ ] M3 잔여/개정 포인트: 3.1 업데이트·롤백, 3.3.2 앱 정보 화면 고지 열람·clean-room 검수, safeStorage 셸 IPC 위임·UDP/DNS 캡처 강화·pi 승인 확장 훅·mcpServers 재개 재주입·grok compat(C-1 결과 반영)

## Risks & Blockers

- 게이트웨이 SSE 스트리밍 품질·비표준 응답 미실측(C-1 대기) — M1 수용 기준의 입력, compat 플래그 확정 대기 (pi/omp/grok 주입 모두 compat 전달 경로 보유)
- ~~grok Linux 바이너리 조달 미확정~~ → 2026-08-25 해소(packaging §6-1). 단 x.ai CDN 은 체크섬 미공개·버전 목록 불투명 — 번들 갱신 시마다 이중 소스 교차 검증 재수행 필요
- Windows 실행 미검증 — 조립·manifest 까지만 사외 확인, junction 교체 비원자·pi Git Bash 전제 등은 실기기(C-5)에서 판정
- 자동 승인(2.4.7)은 렌더러 측 자동 응답 방식 — 데몬 감사 로그 관점의 보강(FR-1.5 audit)은 M3 검토
- omp 릴리스 주기가 매우 빠름(로컬 17.3.8 vs 최신 18.0.4) — 번들 버전 고정·관대 파싱으로 완화 중, 번들 갱신 주기에 재실측 필요
