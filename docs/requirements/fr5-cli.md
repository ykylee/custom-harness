<!-- standard-ai-workflow-kit: v1.4.0 -->

# FR-5 상세 — 관리 CLI

- 문서 목적: [REQUIREMENTS](../REQUIREMENTS.md) FR-5 그룹의 상세 요구사항. 데몬·설치 상태를 다루는 최소 CLI.
- 상태: approved (v1, 2026-08-25 사용자 승인)
- 최종 수정일: 2026-08-25
- 근거 문서: [UI 형태 논의](../design/ui-form.md) §4, [paseo 분석 §4.2](../reference/paseo-analysis.md)

## FR-5.1 데몬 제어 (M, M1)

| 명령 | 동작 |
|---|---|
| `daemon start` | 데몬 기동 (이미 실행 중이면 no-op + 안내) |
| `daemon stop` | 정상 종료 (실행 중 세션 존재 시 경고 + 확인) |
| `daemon status` | 실행 여부, PID, 포트, 활성 세션 수, 버전 |
| `version` | 본체 버전 + manifest 의 번들 버전·하네스 버전 목록 |

- CLI 는 Electron 내장 Node 로 실행되는 스크립트로 제공 (별도 런타임 불요, 번들에 진입점 포함).

## FR-5.2 데몬 소유권 구분 (S, M2)

- PID 파일에 `{pid, managedBy: app|cli}` 를 기록한다. 앱(셸)이 띄운 데몬과 사용자가 CLI 로 직접 띄운 데몬을 구분하여, 앱 종료 시 CLI 소유 데몬을 종료하지 않는다.
- stale PID 파일(프로세스 부재)은 기동 시 정리한다.

## FR-5.3 진단 (S, M2)

- `doctor`: 설치 상태 자가 진단 — manifest 체크섬 재검증, 하네스 실행 파일·버전 확인(FR-1.8), 게이트웨이 연결 확인(테스트 호출), 하네스 설정의 트래픽 경계 검사(FR-2.5), 오프라인 프리셋 적용 여부. 결과를 항목별 pass/warn/fail 로 출력.
- `logs`: 데몬·하네스 프로세스 로그 경로 안내 및 tail.

## FR-5.4 범위 제한

- 세션 생성·프롬프트 실행 등 에이전트 조작 명령은 1차 범위에서 제외한다 (UI 가 유일한 조작면). 필요성이 확인되면 M4 에서 재검토.
