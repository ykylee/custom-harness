<!-- standard-ai-workflow-kit: v1.4.0 -->

# 진척 보드 (PROGRESS)

- 문서 목적: 로드맵 WBS 기준 진척 현황의 단일 보드. 모든 작업은 여기 등재된 WBS ID 로 추적한다.
- 갱신 규칙: 작업 상태 변화 시마다 갱신 (planned / in_progress / blocked / done). 계획 변경 발생 시 원 문서(ROADMAP·roadmap/·REQUIREMENTS 등) 동기화 후 여기 비고에 링크.
- 최종 수정일: 2026-08-25

## 현재 마일스톤: M1 — 코어 수직 절단 / MVP

| WBS | 작업 | 상태 | 비고 |
|---|---|---|---|
| 1.1.1 | 모노레포 골격 (workspaces·빌드·테스트·린트·CI) | done (로컬) | 2026-08-25 — 5패키지+bundle/, tsc project references, vitest·eslint·prettier, typecheck/test/lint 그린. CI 배선은 원격 저장소 확정 시 |
| 1.1.2 | protocol 패키지 (zod 스키마·capability 헬퍼) | in_progress | hello 봉투·버전 상수 초판 + 라운드트립 테스트. FR-1.4 이벤트 유니온 작성 중 |
| 1.2.* | 데몬 코어 (WS 서버·세션 매니저·영속화·spawn) | planned | |
| 1.3.* | pi 어댑터 (JSONL RPC base·계약·승인·mock/계약 테스트) | planned | RPC 스키마 발견 포함 (0.7.1 이월분) |
| 1.4.* | 게이트웨이 연결 (주입·프리셋·키) | planned | 격리 주입 전략 확정됨 |
| 1.5.* | 렌더러 (골격·대화 뷰·승인·온보딩) | planned | |
| 1.6.* | Electron 셸·CLI | planned | |
| 1.7.* | macOS 번들 v0·NFR-1 스모크·수용 | planned | 수용 전 조건: **C-1 게이트웨이 실측 (이월)** |
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
