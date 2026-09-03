<!-- standard-ai-workflow-kit: v1.4.0 -->

# 요구사항 정의 (Requirements) — 인덱스

- 문서 목적: 확정된 컨셉([CONCEPT](./CONCEPT.md))을 정제한 요구사항의 **인덱스**. 상세는 [requirements/](./requirements/) 의 카테고리별 문서가 SSOT 다.
- 상태: **approved** (v2 — 카테고리별 상세 문서로 세분화, 2026-08-25 사용자 승인. 이후 변경은 개정 이력으로 관리)
- 최종 수정일: 2026-08-30
- 관련 문서: [ROADMAP](./ROADMAP.md), design/ 3종, reference/ 4종

## 표기

- 우선순위: **M**(Must, 1차 릴리스 필수) / **S**(Should, 1차 릴리스 내 목표) / **C**(Could, 확장) / **L**(Later, 후순위 확정)
- 단계: [ROADMAP](./ROADMAP.md) 의 M1~M7 마일스톤. 상세 문서의 하위 ID(FR-x.y.z)가 개별 요구사항 단위다.

## 카테고리

| 그룹 | 상세 문서 | 범위 요약 | 주 단계 |
|---|---|---|---|
| **FR-1** 하네스 실행·세션 관리 | [fr1-harness-sessions.md](./requirements/fr1-harness-sessions.md) | 프로세스 수명주기·PID 원장, 공통 세션 계약 + pi/omp/grok 어댑터(전송·버전 검증·청킹), 세션 영속화·재개, 스트리밍 이벤트 정규화, 승인 흐름, 중단, 멀티 세션 | M1–M2 |
| **FR-2** 게이트웨이 연결 통제 | [fr2-gateway.md](./requirements/fr2-gateway.md) | 하네스별 설정 주입(경로·필드 상세, 사용자 설정 보존), 오프라인 스위치 프리셋, API 키 온보딩·저장(OS 자격증명 저장소 검토), 모델 목록, 트래픽 경계 검사 | M1–M2 |
| **FR-3** UI (데스크톱 앱) | [fr3-ui.md](./requirements/fr3-ui.md) | 세션 생성, 대화 뷰(스트리밍·툴 카드·diff), 멀티 세션(탭/페인/상태 버킷), 승인 UI, 앱 종료·알림, 설정, 사용량 표시, 온보딩 마법사 | M1–M2 |
| **FR-4** 패키징·설치·업데이트 | [fr4-packaging.md](./requirements/fr4-packaging.md) | 번들 레이아웃, manifest 스키마, 설치/제거 스크립트(원자적 심링크 전환), 전체 교체 업데이트·롤백, NOTICE, 저장소 연동(선택), 빌드 파이프라인 | M1–M3 |
| **FR-5** 관리 CLI | [fr5-cli.md](./requirements/fr5-cli.md) | daemon start/stop/status/version, 소유권 구분, doctor 진단, logs. 에이전트 조작은 범위 외 | M1–M2 |
| **FR-6** 확장 (후순위) | [fr6-extensions.md](./requirements/fr6-extensions.md) | opencode(사전 캐시 전제), claude/codex(변환 계층·재배포 재확인), 조직 공용 스킬/MCP 세트(정본 번들 + 복사 동기화) | M4 |
| **FR-7** 프로젝트·워크스페이스 | [fr7-workspaces.md](./requirements/fr7-workspaces.md) | 프로젝트 레지스트리(불투명 ID·정합화 계약), 워크스페이스(cwd/checkoutRoot 분리·아카이브·라벨), 세션 귀속(workspaceId 1급), git worktree 격리, 프로젝트 설정 파일, 사이드바 3계층 | M5 |
| **FR-8** 작업 공간 | [fr8-workbench.md](./requirements/fr8-workbench.md) | 탭 타깃 일반화, 데몬 소유 터미널(바이너리 프레임·복원), 파일 탐색·뷰어, working/커밋 diff, 워크스페이스 스크립트 실행, (조건부) forge/PR | M6 |
| **FR-9** 오케스트레이션 | [fr9-orchestration.md](./requirements/fr9-orchestration.md) | 주의 상태 1급화, 역방향 툴 카탈로그(MCP 폴백), 서브에이전트 위임, 검색·커맨드 팔레트, 세션 제목 자동 생성, CLI 자동화 표면 | M7 |
| **NFR** 비기능 | [nfr.md](./requirements/nfr.md) | 폐쇄망 자기완결(외부 요청 0), 게이트웨이 경유 강제, localhost 한정, 라이선스(clean-room·고지), 호환성(관대 파싱·COMPAT), 스트리밍 체감, 토큰 절약, 설치 무결성, 플랫폼 일관성 | 전 구간 |

## 제약 (확정 사항 — 변경 시 컨셉 개정 필요)

- 기술 스택: TypeScript 단일 스택, Electron 셸(내장 Node 를 데몬·pi/omp 런타임으로 겸용), React 렌더러, zod 류 프로토콜 단일 소스, npm workspaces 모노레포
- 지원 하네스 1차: pi / oh my pi / grok build. 제외: antigravity
- UI: 데스크톱 앱 단일 (모바일 제외, LAN 접속 없음, 데몬 localhost 전용)
- 배포: 오프라인 아카이브 3종(macOS arm64 / Windows x64 / Linux x64), 사용자 홈 설치

## 미해결 → 설계 단계(M0) 입력

- OPEN-1: 어댑터 전략 — ACP 공통 경로 vs Direct (grok 는 양쪽 가능, pi/omp 는 JSONL RPC 가 커버리지 우위). FR-1.2 인터페이스 확정 포함
- OPEN-2: 게이트웨이 크리덴셜 프로비저닝 — 수동 입력(FR-2.3 MVP)을 넘는 조직 발급 연동 여부
- OPEN-3: 확인 과제 3건 — grok build·pi/omp Windows 실측, 내부 아티팩트 저장소 유무, 코드 서명 체계
- OPEN-4: 데몬-렌더러 프로토콜 상세 — 이벤트 스키마, 바이너리 프레임 필요 여부, 키 저장 방식(FR-2.3.2)
