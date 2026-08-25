<!-- standard-ai-workflow-kit: v1.4.0 -->

# 기술 스택 설계 논의

- 문서 목적: CONCEPT §7 마지막 미정 항목인 기술 스택 — 데몬 언어, 데스크톱 셸, 렌더러 — 의 옵션을 비교하고 권장안을 제시한다.
- 상태: done (2026-08-24 사용자 확정 — §6)
- 최종 수정일: 2026-08-24
- 관련 문서: [CONCEPT](../CONCEPT.md) §7, [UI 형태](./ui-form.md), [패키지 배포 형태](./packaging.md), [paseo 분석](../reference/paseo-analysis.md) §6

## 1. 확정된 제약이 좁혀 놓은 선택지

- **렌더러는 웹 기술 확정** — UI 형태 결정(데스크톱 앱 = 셸 + 웹 렌더러)의 귀결. 남은 것은 프레임워크 선택뿐.
- **번들은 오프라인 아카이브** — 런타임을 동봉하므로 "개발자 PC 에 뭐가 깔려 있나"는 무관. 대신 런타임 개수가 번들 크기와 관리 비용을 결정.
- **1차 하네스 3종 중 2종(pi/omp)이 Node 기반** — Node 런타임은 어차피 번들에 들어간다. 데몬까지 Node 면 런타임 1개로 수렴하고, Electron 채택 시 그 Node 마저 Electron 에 내장된 것을 겸용 가능(`ELECTRON_RUN_AS_NODE`, paseo 실증).

## 2. 데몬 언어

| 축 | A. TypeScript/Node | B. Go | C. Rust |
|---|---|---|---|
| paseo 패턴 활용 | **최대** — `AgentClient`/`AgentSession` 계약, `JsonlRpcProcess`(pi/omp 전송), 이벤트 정규화 등 참고 구현이 같은 언어 | 패턴만 이식 (재작성) | 패턴만 이식 (재작성) |
| 하네스 생태 정합 | pi/omp 가 TS — 디버깅·이슈 추적 시 같은 언어 | 이질 | grok build 와 동일 언어이나 어댑터는 프로세스 경계라 무의미 |
| 런타임/번들 | Electron 내장 Node 겸용 → **추가 런타임 0** | 단일 바이너리 (+Node 는 pi/omp 용으로 여전히 필요) | 단일 바이너리 (상동) |
| 프로세스 관리·stdio 스트리밍 | 충분 (paseo 가 실증) | 강함 | 강함 |
| 개발 속도 / 렌더러와 타입 공유 | **빠름 / 프로토콜 스키마(zod 류) 공유 가능** | 중간 / 별도 코드젠 필요 | 느림 / 별도 코드젠 필요 |

판정: **A (TypeScript/Node) 권장.** 데몬의 일은 CPU 연산이 아니라 프로세스 spawn·stdio 스트리밍·상태 관리·WS 서빙이고, 이 워크로드에서 Node 는 paseo 가 이미 실증했다. B/C 의 단일 바이너리 장점은 pi/omp 때문에 Node 를 어차피 동봉하는 순간 소멸한다.

## 3. 데스크톱 셸

| 축 | Electron | Tauri |
|---|---|---|
| 렌더링 일관성 | **Chromium 동봉 — 3 OS 동일** | OS webview (WebView2 / WKWebView / webkitgtk) — 편차 존재 |
| 폐쇄망 적합성 | 자기완결 | **Linux webkitgtk 시스템 의존** — 배포판별 설치 상태에 좌우, Windows WebView2 런타임도 사전 설치 전제 |
| Node 겸용 | **`ELECTRON_RUN_AS_NODE` 로 데몬·pi/omp 런타임 겸용** (paseo 실증) | 불가 — Node 별도 동봉 필요 |
| 번들 크기 | 큼 (~200MB 급) — 반입 제약 없음 확인으로 비용 아님 | 작음 |
| 데몬 언어와 정합 | TS 데몬과 동일 생태 | Rust 셸 + TS 데몬 이중 스택 |

판정: **Electron 권장.** 크기 부담이 반입 제약 없음으로 상쇄된 상태에서, 렌더링 일관성·자기완결성·Node 겸용(번들에서 별도 Node 제거)이 전부 Electron 쪽에 있다. 사용자 홈 설치라 Electron 의 자동 업데이트 프레임워크는 쓰지 않고 packaging §4 의 전체 번들 교체를 따른다.

## 4. 렌더러·공통 계층

- **렌더러**: React + TypeScript 권장 — paseo UI 패턴(탭/페인, 상태 버킷, 승인 흐름 §4.3)을 같은 모델로 참고 가능, 사내 채용 풀도 가장 넓음. Expo/RN 은 모바일 제외 확정이므로 불채택 — 순수 웹 React 로 충분.
- **프로토콜 스키마**: zod 류 단일 소스 + 데몬·렌더러 타입 공유 (paseo §3.1 패턴). capability 협상 + COMPAT 만료일 규칙 채택.
- **모노레포**: npm workspaces (protocol / daemon / renderer / shell / cli 분리).

## 5. ⚠ paseo 코드 재사용 금지 (라이선스)

paseo 는 **AGPL-3.0-or-later** 다. 이 도구는 사내 배포되는 조직 내부 도구지만, AGPL 코드 복사는 전염 리스크가 있어 원칙을 세운다: **패턴·인터페이스 설계는 참고하되 코드 복사는 금지** (clean-room 수준으로 유지). 어댑터 계약, 프로토콜 전략 등은 이 저장소의 분석 문서를 매개로만 반영한다.

## 6. 확정 (2026-08-24 사용자 결정)

| 항목 | 확정값 |
|---|---|
| 언어 | **TypeScript 단일 스택** (데몬 + 렌더러 + CLI) |
| 데스크톱 셸 | **Electron** — `ELECTRON_RUN_AS_NODE` 로 데몬·pi/omp 용 Node 런타임 겸용, 번들에 별도 Node 동봉 없음 |
| 렌더러 | **React** |

부속 결정(§4)도 함께 채택: zod 류 프로토콜 단일 소스 + capability 협상 + COMPAT 만료일 규칙, npm workspaces 모노레포(protocol / daemon / renderer / shell / cli). paseo 코드 재사용 금지 원칙(§5) 유지.
