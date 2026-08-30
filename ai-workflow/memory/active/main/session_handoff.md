<!-- standard-ai-workflow-kit: v1.4.0 -->

# Session Handoff

- Purpose: Compact restore context for the next AI agent session.
- Scope: current focus, task status, key changes, next actions, risks
- Audience: AI agents, maintainers
- Status: draft
- Updated: 2026-08-30
- Related docs: [Project Profile](../../docs/PROJECT_PROFILE.md), [Work Backlog](./work_backlog.md)

## Current Focus

- (2026-08-30 현재 기준선) **M0 설계 → M1 구현 → M2 구현(2.1~2.7) + M3 선행 2건 완료, 그 위에 M5 착수.** 1차 하네스 3종(pi/omp/grok)·데몬 멀티 세션·렌더러·셸/CLI·3 OS 오프라인 번들·doctor/logs 동작, NFR-1(외부 접속 0) darwin 실측 PASS. **2026-08-30 방향 확장**: paseo 서비스 구성 전수 분석(18 도메인) → 도입 웨이브 A~C 승인 → 로드맵 **M5(워크스페이스)·M6(캔버스)·M7(오케스트레이션)** 신설, 요구사항 FR-7/8/9 신설. M5 는 WP5.0(선반영)·5.1(설계)·5.2/5.3(레지스트리 핵심) 완료. 테스트 230건 그린. **M1·M2 완료 선언 잔여는 전부 사내 협조 대기(C-1 게이트웨이 실측, C-5 실기기 linux/win) — M5 는 이와 독립이라 병행 중.**
- 컨셉 정의 단계 — paseo 류 멀티 하네스 오케스트레이션 도구, **사내망(폐쇄망) 전용**. 핵심 제약: 모든 LLM 트래픽은 커스텀 게이트웨이(OpenAI 호환만) 경유, 외부 참조 최소화, 토큰 제약. 컨셉 전달 진행 중(완료 선언 전), 진행 범위는 설계까지(구현 금지). 레퍼런스·게이트웨이·확장 공유 조사 완료. 코드 없음, 기술 스택 미정.
- (2026-08-25 갱신) **기준선 전면 갱신**: 컨셉 완료 선언(08-24) → 요구사항 v2·로드맵 v2(M0~M4 WBS) 승인 → **M0 설계 완료**(설계서 6종 approved) → **M1 착수, 1.1.1 모노레포 골격 완료**(typecheck·test·lint 그린). 진행 범위는 사용자 지시로 **SDLC 단계별 순차 진행(구현 포함)** 으로 변경. 확정: 1차 하네스 pi/omp/grok(ACP·GROK_HOME 격리), Windows 번들 omp+pi(조건부)·grok 제외, 주입은 격리 우선(pi `PI_CODING_AGENT_DIR` 실측 확정). 작업 원칙: 로드맵·WBS 기반 진행, 진척은 docs/roadmap/PROGRESS.md + 백로그 기록, 계획 변경 시 원 문서 동기화 필수 (PROJECT_PROFILE §4).
- (2026-08-25 2차 갱신) **M1 코어 4개 WP 완료**: 1.1.2 protocol v0(이벤트 유니온 14종+와이어 user_message·RPC 17 method·capability 헬퍼·순수성 lint 게이트) → 1.2 데몬 코어(WS 서버·세션 매니저·JSONL 영속화·spawn 유틸·startDaemon 조립) → 1.3 pi 어댑터(pi 0.84.1 RPC 스키마 실측, JSONL 전송 base, 이벤트 정규화·승인 extension_ui 배선, mock 하네스 1급+공유 계약 스위트) → 1.4 게이트웨이(models.json 격리 주입·PI_OFFLINE 프리셋·KeyStore 0600 폴백+SecretCipher·config.\* RPC). 테스트 86건·typecheck·lint·format 그린. 설계서 2건 v1.1 개정(사용자 승인): protocol-design(user_message), adapter-contract(pi capability 실측 보정·승인 채널). 백로그 08-24/08-25 태스크 17건 상태 정합화(done).
- (2026-08-25 4차 갱신) **M2 WBS 전 구간(2.1~2.7) 사외 수행분 완료**: 2.1 omp 어댑터(공용 session-core 추출·v2 협상+rpc_chunk·리플레이 가드·models.yml/config.yml 주입 — 공개 소스(MIT)+바이너리 실측) → 2.2 grok ACP 어댑터(잔여 실측 4건 해소: load 리플레이·승인 옵션 2종·cancel·SIGTERM 저장, config.toml 주입 — env_key·오프라인 3스위치 현행 구문) → 2.3 데몬 멀티 세션(혼합 5세션 격리·maxSessions 설정·PID 원장 reap·manifest 대조·모델 카탈로그·경계 검사) → 2.4 멀티 세션 UI(사이드바 버킷·탭/2분할+복원·단축키·설정 완성·사용량 3면·트레이+알림·자동 승인 opt-in) → 2.5 번들(manifest 도구·install.sh/ps1·3 OS 실조립: darwin 205.7/linux 244.4/win 260.7MB — darwin 은 설치+데몬 스모크 실검증) → 2.6 doctor/logs(실물 번들 전 항목 검증) → 2.7 검증(NFR-1 v2: 실물 3하네스 1턴+혼합 6세션 부하 PASS, 매트릭스 문서 darwin 열 실측). 동시성 버그 2건 부하로 검출·수정(meta·PID 원장 쓰기 경합). adapter-contract v1.2·v1.3, credential-injection-design v1.2 개정(사용자 승인). 테스트 191건·typecheck·lint·format 그린. **M2 완료 선언 잔여 = 전부 사내 협조**: C-5 실기기(linux/win), grok linux CDN 미러 절차, C-1(M1 수용 선행)
- (2026-08-25 5차 갱신) **사외 가능분 소진 — grok Linux 조달 + M3 선행 2건 완료**: grok linux-x64 조달 절차 확정(x.ai CDN primary/GCS fallback 이중 소스 sha256 교차 검증 — 체크섬 미공개 실측 확인, packaging §6-1 신설) → sources.json 고정 기입 → linux 번들 3하네스 구성 전환(307MB→최종 308.9MB). M3 선행: 3.3.1 라이선스 고지(licenses/ NOTICE+원문 전체 동봉 자동화 — 하네스 3종·Electron Chromium/Node 고지·의존 4종, licenses-src/PROVENANCE.md 반입 기록, grok upstream NOTICE 부재 확인) + 3.5.2 제거 스크립트(uninstall.sh/ps1 — 기본 데이터 보존·--purge 확인 후 삭제, 격리 루트 스모크 3케이스 통과). 3 OS 재조립·manifest 검증·lint 그린. **잔여는 전부 사내 협조(C-1·C-5)**.
- (2026-08-25 3차 갱신) **M1 구현 전 구간 완료 — 수용(1.7.3)만 C-1 대기**: 1.5 렌더러(React 19+Vite 5 — DaemonClient 재연결·seq 재동기화, 자체 스토어, 타임라인 리듀서, 대화 뷰·툴/승인 카드·컴포저·온보딩·설정) → 1.6 셸·CLI(공용 런처 detached spawn·stale pid 정리, daemon start/stop/status/version, Electron RUN_AS_NODE 실기 스모크로 FR-4.1.3 실증, **safeStorage headless 불가 실측 확정 → credential-injection-design v1.1 개정**) → 1.7.1 번들 프로토타입(151MB tar.gz, manifest dirHash, INSTALL.md, --verify 통과) + 1.7.2 **NFR-1 스모크 PASS**(목 게이트웨이 SSE + 실물 pi 1턴 + lsof 판정 — 허용 외 커넥션 0건). 테스트 108건 그린. **M1 완료 선언의 잔여 조건 = C-1 실 게이트웨이 실측 → 1.7.3 수용 시나리오**.

- (2026-08-30 6차 갱신) **실기기 피드백 반영 + 진행 중 2건 종료**: Windows 실기기 lint·test 통과 확인, 실기기 피드백 4건 반영(번들 GUI 흰 화면=Vite base `'./'`, 세션 생성 cwd 선검증, win32 번들 grok 설정 템플릿 잔여물 제거, 메뉴바 제거+데몬 하네스 경로 manifest 폴백) → TASK-026 done. 렌더러 다크 우선 토큰 디자인 시스템 + 타임라인 시간순 세그먼트 분할 + 대화 뷰 스크롤 경합 수정 → TASK-027 done. 테스트 195건·3 OS 재조립 그린. **진행 중 0건 — 잔여는 전부 사내 협조(C-1 게이트웨이 실측, C-5 linux/win 매트릭스 나머지)**

## Work Status

- 사내 확인 C-1 게이트웨이 실측 → 1.7.3 M1 수용 시나리오, C-5 실기기(linux/win 매트릭스·install.ps1/uninstall.ps1·pi Windows 조건부 판정), C-2 저장소·C-3 서명 (docs/roadmap/m0-internal-checklist.md, m2-smoke-matrix.md): blocked
- M3 잔여 후보(사내 협조 무관 순수 사외분 아님 — 대부분 C-1·C-5 후속) — 3.1 업데이트·롤백, 3.3.2 앱 정보 화면 고지 열람·clean-room 검수, 서명(C-3), M2 개정 포인트 누적분(safeStorage 셸 IPC 위임, UDP/DNS 캡처, pi 승인 확장 훅, mcpServers 재개 재주입, grok compat): planned
- TASK-2026-08-30-main-004 M5 5.2·5.3 프로젝트·워크스페이스 레지스트리 구현: in_progress
- TASK-2026-08-30-main-003 M5 5.0 선반영(설정 계약·세션 스키마 additive·RPC 네임스페이스 예약): done
- TASK-2026-08-30-main-002 M5 5.1 워크스페이스 모델 설계서(승인 완료): done
- TASK-2026-08-30-main-001 paseo 서비스 구성 전수 분석 + 도입 계획(M5~M7 신설): done
- TASK-2026-08-25-main-027 렌더러 디자인 정비(다크 우선 토큰 시스템·타임라인 세그먼트·스크롤 경합): done
- TASK-2026-08-25-main-026 Windows 대응 보강(grok 제외 일관화·lint POSIX 제거·실기기 피드백 4건): done
- TASK-2026-08-25-main-025 M3 3.5.2 제거 스크립트(uninstall.sh/ps1·스모크): done
- TASK-2026-08-25-main-024 M3 3.3.1 라이선스 고지(NOTICE·원문 동봉 자동화): done
- TASK-2026-08-25-main-023 grok Linux 조달(CDN 미러·자체 해시 고정): done
- TASK-2026-08-25-main-022 M2 2.7 검증(NFR-1 v2·매트릭스·부하): done

## Key Changes

- (2026-08-30) **문서**: docs/reference/paseo-service-inventory.md 신설(paseo v0.5.2 서비스 18 도메인 전수 대조 — 전면 도입 7/축소 6/보류 4/제외 5, AGPL 경계 명시), 요구사항 FR-7(프로젝트·워크스페이스)·FR-8(작업 공간)·FR-9(오케스트레이션) 신설, 로드맵 M5~M7 세부 WBS 3종 신설 + ROADMAP/REQUIREMENTS/PROGRESS/PURPOSE 동기화, 설계서 2종 신설(workspace-model approved, settings-contract)
- (2026-08-30) **코드**: `daemon/settings.ts`(우선순위 env>파일>기본값·출처 보고·scope live/restart·감시 재적용·원자적 쓰기+직렬화) — GatewayService·startDaemon 배선 / `protocol/rpc.ts` SessionSummary optional 6종 + 네임스페이스 예약 6종 / `daemon/store.ts` SessionMeta 동일 6종 / `daemon/workspaces/`(records·registry-store·git-facts·registry) 신설 — 프로젝트·워크스페이스 레지스트리 + 프로비저닝 단일 창구 / `daemon/paths.ts` projectsDir·worktreesDir. 테스트 38건 신규(총 230건 그린)
- (2026-08-30) **실측·결정**: `git rev-parse --show-toplevel` 이 심링크를 푼 경로 반환(macOS /tmp→/private/tmp) → `--show-prefix` 로 상대 접두사만 걷어내는 방식으로 전환(lexical 정규화 원칙 유지). D-1 worktree=데이터 디렉토리 내부, D-2 기본 워크스페이스=프로젝트 열기 즉시, D-3 아카이브 타임라인=무기한 보존

- (5차) bundle/sources.json — grok linux-x64 url/fallbackUrl/sha256 고정(`9ba87444…7238`, 이중 소스 교차 검증). bundle/licenses-src/ 신규 — pi·omp·grok 라이선스 원문 반입 + PROVENANCE.md(출처·해시·수집일). build-bundle.mjs — licenses/ 전면 개편(NOTICE 생성·원문 동봉·타깃별 조건부 고지), uninstall 동봉, INSTALL.md 제거·라이선스 절, RUNTIME_DEPS 상수화. bundle/uninstall.sh·uninstall.ps1 신규. bundle/README.md 현행화. 문서: packaging §6-1 신설(조달 절차 5단계), m2-smoke-matrix(linux 열 grok 대상 전환·307MB→308.9MB), PROGRESS.md M3 선행 섹션, windows-support 후속 반영

- packages/daemon — adapters/jsonl-rpc/{session-core.ts 신규(pi·omp 공용), transport.ts(rpc_chunk 재조립·송신 1MiB 가드), omp.ts+fake-omp}, adapters/acp/{client.ts, grok.ts+fake-grok}, gateway/{omp,grok}-injection.ts(+service 배선·buildEnv 3하네스), manifest.ts(관대 로더+dirHash/verifyBundleTree), processes.ts(reapStale·daemonPid·하네스 stderr 로그·원장 직렬화), session-manager.ts(metaChain 직렬화·running 역전 가드·usage 누적·probeHarness·setMaxSessions), server.ts(harness.list models/warnings·config maxSessions), multi-session.test 등 테스트 82건 신규 (총 191건)
- packages/protocol — HarnessInfo.warnings·SessionSummary.usage (additive 2건). packages/renderer — 탭/2분할 레이아웃(localStorage 복원)·Sidebar/Tabs 컴포넌트·단축키·Settings 완성(기본 모델·하네스 패널·알림)·자동 승인 opt-in·턴별/누적 사용량·Notification 알림. packages/shell — 트레이 상주(창 닫기=숨김·WS 세션 요약 메뉴). packages/cli — doctor(6영역 진단)·logs(목록+tail)
- bundle/ — lib/manifest.mjs·tools/(manifest-tool·install-presets)·install.sh(실검증)·install.ps1·sources.json(고정 해시)·build-bundle.mjs 3 OS 개편(out: darwin/linux/win 아카이브+sha256). scripts/nfr1-smoke.mjs v2(3하네스+부하). vitest include .tsx 수정. 의존 추가: yaml·smol-toml(무의존)
- docs — adapter-contract v1.2/v1.3·credential-injection-design v1.2(승인 개정), grok-integration-paths §3-1(잔여 실측 해소), m2-smoke-matrix.md 신설, PROGRESS.md M2 섹션(2.1~2.7 done)
- 실측 확정(구현 근거): omp 17.3.8 — PI_CODING_AGENT_DIR 동일 지원·apiKey bare env 명·PI_OFFLINE 미지원·stdin 무청킹·재개 무리플레이 / grok 1.0.5 — load 응답 전 리플레이·승인 옵션 2종·거부=턴 완결·SIGTERM 저장·[cli]/[features] 오프라인 구문·env_key

## Next Actions

- [ ] **M5 계속**: 5.2.3·5.3.5 `project.*`/`workspace.*` RPC 노출 → 5.3.3 아카이브 teardown → 5.3.4 라벨 카탈로그 → 5.4 세션 귀속(workspaceId 필수화 + 1회 백필) → 5.5 worktree → 5.6 UI 재편
- [ ] **C-1 실 게이트웨이 실측 회신** → 1.7.3 M1 수용 시나리오 → M1 완료 선언 (M2 완료 선언의 선행)
- [ ] **C-5 실기기 실측 요청** — linux/win 매트릭스(m2-smoke-matrix.md 절차), install.ps1·uninstall.ps1 검증. 추가 확인 항목: Windows junction 환경에서 git `--show-prefix` 경로 유도
- [ ] M3 잔여: 3.1 업데이트·롤백, 3.3.2 앱 정보 화면 고지 열람·**clean-room 검수(paseo 유래 코드 부재 확인까지 범위 확장)**

## Risks & Blockers

- paseo 는 AGPL-3.0-or-later — 설계·계약만 차용하고 코드는 복제하지 않는다. 검수는 M3 3.3.2 clean-room 항목에서 수행
- M5~M7 신설로 M3 릴리스 1.0 이 밀릴 수 있음 — M5 는 사내 협조 대기와 독립이라 병행 가능하나, 자원 경합 시 M3 우선
- 게이트웨이 SSE 스트리밍 품질·비표준 응답 미실측(C-1 대기) — M1 수용 기준의 입력, compat 플래그 확정 대기 (pi/omp/grok 주입 모두 compat 전달 경로 보유)
- ~~grok Linux 바이너리 조달 미확정~~ → 2026-08-25 해소(packaging §6-1). 단 x.ai CDN 은 체크섬 미공개·버전 목록 불투명 — 번들 갱신 시마다 이중 소스 교차 검증 재수행 필요
- Windows 실행 미검증 — 조립·manifest 까지만 사외 확인, junction 교체 비원자·pi Git Bash 전제 등은 실기기(C-5)에서 판정
- 자동 승인(2.4.7)은 렌더러 측 자동 응답 방식 — 데몬 감사 로그 관점의 보강(FR-1.5 audit)은 M3 검토
- omp 릴리스 주기가 매우 빠름(로컬 17.3.8 vs 최신 18.0.4) — 번들 버전 고정·관대 파싱으로 완화 중, 번들 갱신 주기에 재실측 필요
