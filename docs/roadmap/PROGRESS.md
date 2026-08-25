<!-- standard-ai-workflow-kit: v1.4.0 -->

# 진척 보드 (PROGRESS)

- 문서 목적: 로드맵 WBS 기준 진척 현황의 단일 보드. 모든 작업은 여기 등재된 WBS ID 로 추적한다.
- 갱신 규칙: 작업 상태 변화 시마다 갱신 (planned / in_progress / blocked / done). 계획 변경 발생 시 원 문서(ROADMAP·roadmap/·REQUIREMENTS 등) 동기화 후 여기 비고에 링크.
- 최종 수정일: 2026-08-25

## 현재 마일스톤: M1 — 코어 수직 절단 / MVP

| WBS | 작업 | 상태 | 비고 |
|---|---|---|---|
| 1.1.1 | 모노레포 골격 (workspaces·빌드·테스트·린트·CI) | done (로컬) | 2026-08-25 — 5패키지+bundle/, tsc project references, vitest·eslint·prettier, typecheck/test/lint 그린. CI 배선은 원격 저장소 확정 시 |
| 1.1.2 | protocol 패키지 (zod 스키마·capability 헬퍼) | done | 2026-08-25 — FR-1.4 이벤트 유니온 14종(어댑터/와이어 공유, sessionId+seq 봉투), RPC 17 method(session/config/harness/system, ok 판별 응답), hello.response·ping/pong, capability 협상 헬퍼(hasCapability), 순수성 eslint 게이트(발화 검증). 테스트 10건·typecheck·lint 그린. SessionSummary.pendingPermissions 로 FR-1.5 재조회 충족 |
| 1.2.* | 데몬 코어 (WS 서버·세션 매니저·영속화·spawn) | done | 2026-08-25 — 1.2.1 WS 서버(127.0.0.1·토큰 2중 인증·hello 선행·RPC 디스패치·이벤트 브로드캐스트), 1.2.2 세션 매니저(상태 전이 소유·turn_started/user_message 직접 발행·interrupt 멱등·활성 턴 1개 거부·승인 pending 추적·재기동 closed 정정·seq 연속), 1.2.3 영속화(meta.json tmp+rename·timeline.jsonl append-only·파손 줄 드롭), 1.2.4 spawn 유틸(절대 경로 강제·env 오버레이·SIGTERM→SIGKILL 단계화·비정상 종료 감지·PID 원장). startDaemon 조립+수명주기 포함 테스트 31건 신규, 전체 41건·typecheck·lint 그린. 이벤트 `user_message` 와이어 전용 추가(additive). config.\* 는 1.4.3, stale reap 은 FR-1.1.4(M2) |
| 1.3.* | pi 어댑터 (JSONL RPC base·계약·승인·mock/계약 테스트) | done | 2026-08-25 — RPC 스키마 실측 완료(pi 0.84.1 dist 소스: RpcCommand/RpcResponse/AgentEvent/extension_ui). 1.3.1 JSONL 전송 base(id 상관·타임아웃·관대 파싱, omp v2 청킹은 M2 확장점), 1.3.2 pi 어댑터(이벤트 정규화·툴콜 테이블 매핑·usage 정규화·세션 파일 핸들·--session 재개·비정상 종료 감지), 1.3.3 승인 배선(extension_ui_request confirm/select ↔ 중립 모델, input/editor 는 취소 격하), 1.3.4 mock 하네스 1급 + 공유 계약 스위트(9케이스 × mock/pi(fake) 동일 통과, 미지 툴 other·비 JSON 내성). 테스트 총 69건 그린. **실측 차이(개정 포인트)**: pi 0.84.1 에 --mcp-config 없음 → mcpInjection=false, steer/compact RPC 존재하나 계약 밖 → false 유지, 승인은 전용 프레임이 아닌 extension_ui 채널 |
| 1.4.* | 게이트웨이 연결 (주입·프리셋·키) | done | 2026-08-25 — 1.4.1 pi models.json 주입(격리 홈, 관리 블록 병합·백업·드리프트 감지=자동 덮어쓰기 금지, apiKey 는 `$ENV` 보간만), 1.4.2 `PI_OFFLINE=1` env 프리셋 배선, 1.4.3 KeyStore(0600 폴백+SecretCipher 인터페이스 — safeStorage 는 셸 1.6 에서 주입, headless 시 복호화 불가 상태 보고)·spawn env 오버레이(PI_CODING_AGENT_DIR+키)·목 게이트웨이 연결 확인(200/401/네트워크 원인별) + config.\* RPC 4종 배선(키 값은 응답에 미노출). 테스트 총 86건 그린. 실 게이트웨이 검증은 C-1 회신 후 |
| 1.5.* | 렌더러 (골격·대화 뷰·승인·온보딩) | done | 2026-08-25 — 1.5.1 골격(DaemonClient: 서브프로토콜 토큰·지수 백오프 재연결·ping/pong·재연결 시 seq 재동기화, 자체 스토어 useSyncExternalStore), 1.5.2 세션 생성(하네스·cwd 최근 목록·모델, 원인별 실패 안내), 1.5.3 대화 뷰(델타 스트리밍·marked+DOMPurify 마크다운·사고 접기 기본·스크롤 추적+새 메시지 배지), 1.5.4 툴 카드(분류별 요약·원본 펼침), 1.5.5 승인 카드·중단·컴포저(실행 중 비활성), 1.5.6 온보딩 3단계(FR-3.8)+설정(키·0600 폴백 경고). 타임라인 리듀서 순수 함수+이벤트 재생 테스트. vite build 성공(자체 완결 번들). 테스트 총 97건 그린. **최소 표시로 이월(m1-mvp 리스크 §허용)**: 코드 구문 강조·diff 뷰(M2), 네이티브 폴더 픽커(1.6 셸 통합) |
| 1.6.* | Electron 셸·CLI | done | 2026-08-25 — 1.6.1 셸(창 관리·렌더러 dist-web 로드 `?port&token`·detached 데몬 spawn/부착, contextIsolation+sandbox, 렌더러 코드 없음), 1.6.2 RUN_AS_NODE 진입점(daemon main.ts: env 계약 CUSTOM_HARNESS_HOME/PORT/PI_PATH/MANAGED_BY, SIGTERM 정상 종료) + 공용 런처(detached spawn·pid/port/token 대기·stale pid 정리 FR-5.2·정지), 1.6.3 CLI(daemon start/stop[--force]/status/version — status 는 WS 질의로 버전·세션 수, stop 은 활성 세션 시 확인 요구). **실기 스모크 통과**: Electron 바이너리+RUN_AS_NODE 로 데몬 기동 → CLI status/stop (FR-4.1.3 실증). **safeStorage 실측 확정**: RUN_AS_NODE 에선 Electron API 부재 → M1 키 저장은 0600 폴백 확정, 셸 IPC 위임은 M2 개정 포인트(credential-injection-design §1 개정 필요 — 승인 대기). 테스트 총 108건 그린 |
| 1.7.1 | macOS arm64 번들 프로토타입 | done | 2026-08-25 — bundle/build-bundle.mjs: FR-4.1.2 레이아웃(app: Electron.app+자사 5패키지+zod·ws만 / harnesses/pi 0.84.1 해제본 / config-templates(pi-models-v1) / licenses NOTICE / INSTALL.md 수동 절차 / bin 래퍼 GUI·CLI 겸용), manifest(FR-4.2: 결정적 dirHash sha256, Electron.app 은 서명과 함께 M3). 산출물 151MB tar.gz. --verify: 체크섬 재검증 + 번들 Electron(RUN_AS_NODE)으로 데몬 기동·CLI 제어·종료 통과. 데몬 main 에 CUSTOM_HARNESS_PI_ENTRY(번들형 pi 실행) 추가 |
| 1.7.2 | NFR-1 스모크 초판 | done | 2026-08-25 — scripts/nfr1-smoke.mjs: 목 게이트웨이(OpenAI 호환+SSE 스트리밍) → 온보딩(주입·키·연결 확인) → **실물 pi 1턴**(격리 홈 models.json 경유, 델타 스트리밍 수신) → lsof 커넥션 폴링 판정(비루프백 즉시 위반, 루프백은 양 끝점 허용 포트 검사) + HTTP(S)_PROXY 블랙홀 강제. **PASS — 허용 외 커넥션 0건**. 한계(개정 포인트): TCP 만 캡처, UDP/DNS·완전 패킷 캡처는 M2 2.7.1 강화 |
| 1.7.3 | M1 수용 시나리오 실행 | **blocked** | 선행 조건 **C-1 실 게이트웨이 실측(이월)** 대기. 목 게이트웨이 기준 리허설은 1.7.2 로 통과(온보딩→pi 1턴→외부 접속 0). 잔여: 실 게이트웨이 교체 실행 + 승인 1회 포함 코드 수정 시나리오 + 재시작 재개 확인 |
| (이월) 0.5.4 | 게이트웨이 실측 | **blocked** | [체크리스트 C-1](./m0-internal-checklist.md) — M1 수용 전 필수 |
| (이월) 0.5.2/0.5.3 | 저장소·서명 확인 | **blocked** | C-2/C-3 — M3 범위 결정에 필요 |

## 완료 마일스톤: M0 — 아키텍처 설계 (2026-08-25 완료 — 설계서 6종 승인, 사내 확인 3건 이월)

| WBS | 작업 | 상태 | 비고 |
|---|---|---|---|
| 0.1.1 | grok build 통합 경로 평가 (stream-json vs ACP) | done (조사+스파이크 일부) | [보고서](../reference/grok-integration-paths.md) (2026-08-25). **ACP 1순위 — 실측으로 확정 수준 강화**: 커스텀 모델+무로그인+`session/set_model`+usage 스트림 실동작 확인 (격리 GROK_HOME + 목 서버, 인증 불요로 판명). 잔여 실측 6건은 0.1.2 진행 중 수행 |
| 0.1.2~0.1.5 | 공통 세션 계약·capability·툴콜 매핑·승인 설계 | done (리뷰 대기) | [어댑터 설계서](../design/adapter-contract.md) 작성 (2026-08-25). 결정 포함: omp 승인은 1차 `--approval-mode` 고정(runtimePermission=false), grok ACP·GROK_HOME 격리 전제 |
| 0.2.* | 데몬-렌더러 프로토콜 설계 | done (리뷰 대기) | [protocol-design.md](../design/protocol-design.md) (2026-08-25). 바이너리 프레임 불채택(0.2.4), 와이어 버전 고정+capability, 토큰 인증 |
| 0.3.* | 데몬 상세 설계 | done (리뷰 대기) | [daemon-design.md](../design/daemon-design.md). 데이터 디렉토리 배치, JSONL append-only 영속화, PID 원장(재접속 미지원 단순화) |
| 0.4.1 | 키 저장 방식 결정 | done (리뷰 대기) | [credential-injection-design.md](../design/credential-injection-design.md) — Electron safeStorage + 0600 폴백. headless 시 가용성은 M1 실측 |
| 0.4.2 | 설정 주입 상세 설계 | done (리뷰 대기) | 동 문서 — **격리 우선 전략**: grok GROK_HOME·pi PI_CODING_AGENT_DIR(실측 확정), omp 는 M2 확인 |
| 0.4.3 | 자동 프로비저닝 검토 | done (조건부) | "수동 입력 확정 + 자동화 보류" 기록. C-4 회신 시 재개 |
| 0.5.1 | Windows 지원 조사 (grok/pi/omp) | done (문서 조사) | [보고서](../reference/windows-support.md) (2026-08-25). 판정: omp 네이티브 / pi 조건부(Git Bash·이슈) / grok best-effort 미테스트 + **전 플랫폼 릴리스 asset 부재(CDN만)**. Windows 번들 1차 "omp+pi(조건부), grok 제외" 결정 제안 — 사용자 확인 대기. 실기기 실측은 C-5 |
| 0.5.2 | 내부 아티팩트 저장소 확인 | **blocked** | 사내 확인 필요 → 체크리스트 C-2 |
| 0.5.3 | 코드 서명 체계 확인 | **blocked** | 사내 확인 필요 → 체크리스트 C-3 |
| 0.5.4 | 게이트웨이 실측 | **blocked** | 사내 확인 필요 → 체크리스트 C-1 (**최우선**) |
| 0.6.1 | 모노레포 구조·도구 확정 | done (리뷰 대기) | [dev-standards.md](../design/dev-standards.md) 초안 작성 (2026-08-25) |
| 0.6.2 | 테스트 전략 | done (리뷰 대기) | [test-strategy.md](../design/test-strategy.md) — 계약 테스트 공유 스위트, mock 게이트웨이 픽스처, NFR-1 스모크 설계, CI 게이트 단계 도입표 |
| 0.7.1 | pi 수직 스파이크 | done (핵심) | 목 게이트웨이로 수행 (0.5.4 대기 불필요로 판명): PI_CODING_AGENT_DIR 격리 + 커스텀 프로바이더 직결 + PI_OFFLINE 하 LLM 호출 정상 확인. 잔여: fd 다운로드 차단 여부(도구 미보유 환경 필요)·RPC 스키마(M1 1.3.1 로 이관) |

## 완료 (마일스톤 이전 단계)

- 컨셉 확정·완료 선언 (2026-08-24) / 요구사항 v2 승인·로드맵 v2 승인 (2026-08-25)
