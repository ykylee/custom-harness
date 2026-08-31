<!-- standard-ai-workflow-kit: v1.4.0 -->

# 설정 계약 (M5 WBS 5.0.1)

- 문서 목적: 데몬 설정의 **우선순위·선언 방식·재적용 범위**를 확정한다. 워크스페이스 모델(M5) 이후 설정 키가 급격히 늘기 전에 규칙을 고정하는 것이 목적이다.
- 상태: approved (v1.1, 2026-08-31 — M7 7.2.0a 하네스 홈 격리 키 2종 추가. v1: 2026-08-30 M5 WP5.0)
- 최종 수정일: 2026-08-31
- 입력: [워크스페이스 모델 설계](./workspace-model.md), [데몬 상세 설계](./daemon-design.md)
- 구현: `packages/daemon/src/settings.ts`

## 1. 우선순위 — 예외 없음

```
환경 변수  >  settings.json  >  코드 기본값
```

- 부적합한 값(형식 오류·범위 밖)은 **그 층에서만 무시**하고 다음 층으로 내려간다. 잘못된 환경 변수 하나가 데몬 기동을 막지 않는다(NFR-5 관대 파싱과 같은 원칙).
- 해석 결과는 값과 **출처**(`env` | `file` | `default`)를 함께 돌려준다. `doctor` 와 설정 UI 는 "왜 이 값인가"를 설명할 수 있어야 한다.
- env 가 파일 값을 덮은 경우 `overriddenByEnv` 로 표시한다 — 사용자가 UI 에서 저장했는데 값이 안 바뀌는 상황을 설명 없이 두지 않는다.

## 2. 선언 레지스트리

키는 `SETTINGS` 레지스트리에만 선언한다. 선언되지 않은 키는 파일에 있어도 **무시**된다(오타 방어).

| 항목 | 의미 |
|---|---|
| `key` | `settings.json` 안의 경로. 점 표기로 중첩(`workspace.setupAutoRun`) |
| `env` | 이 키를 덮는 환경 변수 이름 |
| `defaultValue` | 코드 기본값 |
| `scope` | `live`(즉시 반영) / `restart`(재기동 필요) |
| `parse` | 원시 값 → 타입. 부적합하면 `undefined` 반환(throw 금지) |

키 → 값 타입은 `SettingValues` 인터페이스가 정본이다. 레지스트리와 인터페이스 중 한쪽만 고치면 컴파일이 막는다.

### 현재 선언된 키

| 키 | env | 기본값 | scope |
|---|---|---|---|
| `maxSessions` | `CUSTOM_HARNESS_MAX_SESSIONS` | 8 | live |
| `autoApprove` | `CUSTOM_HARNESS_AUTO_APPROVE` | false | live |
| `workspace.setupAutoRun` | `CUSTOM_HARNESS_WORKSPACE_SETUP_AUTORUN` | false | live |
| `harness.homeIsolation` | `CUSTOM_HARNESS_HOME_ISOLATION` | true | live |
| `harness.homeLinks` | `CUSTOM_HARNESS_HOME_LINKS` | `.gitconfig`, `.ssh` | live |

`harness.homeIsolation` 은 보안 스위치다(M7 7.2.0a, NFR-1) — 하네스가 사용자 실제 `$HOME` 의 외부 MCP 설정을 읽어 게이트웨이 경계 밖 서버를 띄우는 것을 막는다. 끄면 데몬이 기동 경고를 남긴다. `harness.homeLinks` 는 **거부 기본값 위의 allowlist** 로, 격리 홈에 반입할 실제 홈 항목을 지정한다(홈 직속 이름만 — 경로 표기 거부). 쉼표 구분 문자열도 받는다.

## 3. 재적용(핫 리로드)

- 데몬은 설정 파일을 감시하고, 변경 시 **바뀐 키만** 변경 목록으로 발행한다. 값이 실제로 달라지지 않았으면(예: env 가 고정하고 있는 키) 변경으로 치지 않는다.
- `scope: 'restart'` 키가 바뀌면 **경고만 하고 값을 반영하지 않는다** — 반쯤 적용된 상태를 만들지 않는다.
- 에디터의 write→rename 는 이벤트를 여러 번 낸다. 50ms 디바운스로 한 번만 재적용한다.
- 기동 옵션으로 값이 명시된 경우(예: `startDaemon({ maxSessions })`) 그 키는 감시 대상에서 제외한다 — 명시 옵션이 파일에 밀리면 안 된다.

## 4. 쓰기

- `settings.json` 쓰기는 **스토어가 원자성을 소유**한다: tmp 파일 write → rename, 그리고 쓰기 직렬화. 호출자가 read-modify-write 를 직접 돌리지 않는다.
- 이 규칙은 WBS 2.7.3 부하 테스트에서 PID 원장의 read-modify-write 경합으로 갱신이 유실된 사건에서 나왔다. 같은 형태의 버그를 설정 파일에서 반복하지 않는다.
- 선언되지 않은 기존 키(예: `gateway` 블록)는 쓰기 시 보존된다.

## 5. 소비 지점

- `GatewayService` 의 `maxSessions` 는 이 스토어를 통해서만 읽고 쓴다(중복 정본 금지).
- 데몬 조립(`startDaemon`)이 인스턴스를 하나 만들어 게이트웨이 서비스와 공유하고, 종료 시 감시를 닫는다.
