<!-- standard-ai-workflow-kit: v1.4.0 -->

# 데몬-렌더러 프로토콜 설계 (M0 WBS 0.2)

- 문서 목적: 렌더러(및 CLI)가 데몬과 통신하는 프로토콜의 스키마 구조·진화 규칙·인증을 확정한다. OPEN-4 해소.
- 상태: approved (v1.6, 2026-09-01 — `session.usage` 추가(M7 7.3.2). v1.5: `session.wait`·`session.result` 추가(M7 7.3.1). v1.4: §1 터미널 입력 2경로 명시 + `tool.*` 도메인·`PermissionRequest.origin` 추가(M7 7.2.4). v1.3: §2 데몬 소유 이벤트에 `attention_changed` + `session.attention.ack` RPC 추가(M7 7.1.2). v1.2: 2026-08-30 사용자 승인 — 개정: §1 바이너리 프레임 채택(터미널). v1.1: §2 와이어 전용 `user_message` 이벤트 추가)
- 최종 수정일: 2026-09-01
- 입력: [어댑터 설계서](./adapter-contract.md), [FR-1.4](../requirements/fr1-harness-sessions.md), [NFR-3/5](../requirements/nfr.md)

## 1. 전송·프레이밍

- **WebSocket over 127.0.0.1** 단일 포트 (NFR-3). 메시지는 JSON 텍스트 프레임.
- **바이너리 프레임: 채택 (v1.2 개정 — 터미널)**. M0 0.2.4 는 "1차 범위에 터미널 스트림이 없다"는 이유로 불채택하되 *필요 시점에 capability 로 추가한다*는 경로를 함께 남겼다. M6 터미널이 그 시점이다 — 방향 전환이 아니라 그 조항의 발동이다.
  - 같은 소켓에 텍스트(JSON)와 바이너리를 혼재한다. 바이너리 프레임은 `[opcode:1][slot:1][payload...]` — `0x01` 데몬→클라이언트 출력, `0x02` 클라이언트→데몬 입력. `slot` 은 연결 단위 1바이트 터미널 핸들이며 `terminal.attach` 응답이 배정한다.
  - **와이어 버전은 올리지 않는다.** 데몬이 `features.terminalBinaryFrames` 로 광고하고, 플래그가 없으면 클라이언트는 터미널 기능을 **숨긴다**(폴백 경로 금지 — §3 원칙 유지).
  - 미지 opcode 프레임은 조용히 버린다(관대 파싱, NFR-5). 프레임 인코더·디코더는 protocol 패키지의 순수 함수로 두어 데몬·렌더러가 같은 구현을 쓴다.
  - 순수성 게이트(`.transform()/.catch()/.preprocess()` 금지)는 JSON 와이어 스키마에 대한 규칙이다. 바이너리 채널은 zod 검증 대상이 아니며, 검증 실패는 예외가 아니라 `undefined` 반환으로 다룬다(연결을 끊지 않는다).
  - **입력 경로는 둘이다 (v1.3 추가, M7 7.2.4)**: 대화형 UI 는 슬롯 위의 바이너리 프레임을, 화면 없는 소비자(역방향 툴 `term_send`)는 `terminal.write` RPC 를 쓴다. 프레임 경로는 attach 로 잡은 슬롯이 있어야 성립하는데 역방향 툴은 슬롯을 잡을 이유가 없고, 반대로 RPC 로 대화형 입력을 흘리면 키 입력마다 JSON 왕복이 생긴다. 읽기도 같은 이유로 둘이다(`terminal.attach` 구독 / `terminal.read` 1회).
  - 상세: [작업 캔버스 설계 §2](./workbench-tabs.md)
- 봉투 2계층: 연결 레벨(`hello`/`ping`/`pong`) 안에 세션 레벨 RPC·이벤트.

## 2. 스키마 (zod 단일 소스 — protocol 패키지)

- **RPC**: `domain.verb.request` / `.response`, `requestId` 상관. 도메인: `session.*`(create/resume/list/close/prompt/interrupt/wait/result/usage/permission.respond/model.set/timeline/attention.ack — `wait`·`result` 는 M7 7.3.1 위임용, `usage` 는 7.3.2 비용 합산), `config.*`(key.set/key.test/get/set), `harness.*`(list/probe), `tool.*`(invoke — M7 7.2.4 역방향 툴), `system.*`(version/shutdown). M5·M6 이 더한 `project.*`·`workspace.*`·`terminal.*`·`file.*`·`diff.*` 는 각 설계서가 소유한다.
- **이벤트**: FR-1.4 유니온을 그대로 와이어 스키마로 — `turn_*`, `message_delta`, `reasoning_delta`, `tool_execution_*`, `permission_*`, `usage_updated`, `session_status_changed`, `error`. 여기에 **데몬 소유 이벤트**가 더해진다(어댑터 유니온에는 없다): `user_message`, `attention_changed`(M7 7.1.2 — 주의 상태 전이). `permission_requested` 는 하네스가 올린 것만이 아니다 — 데몬이 역방향 툴 승인을 위해 직접 발행하기도 하며(M7 7.2.4), 구분은 `PermissionRequest.origin`(`harness` | `reverse_tool`, 생략 시 `harness`)이 한다. 채널을 나누지 않은 이유는 소비자(사이드바·주의 상태·알림·승인 카드)를 두 번 구현하지 않기 위해서다. 이벤트에는 `sessionId` + 단조 증가 `seq` 를 부여(재연결 시 갭 감지).
- **와이어 전용 이벤트 `user_message`** (v1.1 추가): 사용자 메시지 타임라인 행은 데몬(세션 매니저)이 소유·발행한다(데몬 설계 §4). 어댑터 유니온(AgentEvent)에는 없고 와이어 유니온(SessionEvent)에만 존재하는 additive 확장 — `{ type: "user_message", turnId, text }` + 와이어 봉투.
- **순수성 규칙**: 와이어 스키마에 `.transform()/.catch()/.preprocess()` 금지 — 검증과 변환 분리 (paseo 검증 전략 채택).
- 어댑터 이벤트(AgentEvent)와 와이어 이벤트는 **동일 스키마를 공유**한다 — 데몬은 sessionId/seq 부여 외 재가공하지 않는다 (이중 정의 드리프트 방지).

## 3. 진화 규칙 (0.2.2 — NFR-5)

- `protocolVersion: 1` **고정, 올리지 않는다.** 대신:
  1. 클라이언트 `hello.capabilities` — 데몬이 다운그레이드 인코딩 선택.
  2. 데몬 `hello.response.features.*` 플래그 — 렌더러는 단일 지점에서 검사, 없으면 기능 숨김(폴백 경로 금지).
  3. COMPAT shim — `// COMPAT(name): remove after <date>` 필수, 정기 스캔.
- 신규 필드는 반드시 optional. 제거·의미 변경 금지. 판단 기준: "이전 번들의 렌더러가 이 메시지를 파싱할 수 있는가" (전체 번들 교체 배포라 렌더러-데몬 버전은 원칙상 일치하지만, 업데이트 중간 상태·롤백을 고려해 규칙은 유지).

## 4. 인증 (0.2.3 — NFR-3)

- 데몬 기동 시 랜덤 세션 토큰 생성 → 데이터 디렉토리 내 소유자 전용 권한(0600) 토큰 파일에 기록.
- 렌더러(셸이 로드)·CLI 는 토큰 파일을 읽어 접속. 전달 경로 2중화: `Authorization: Bearer`(CLI·Node 클라이언트) + `Sec-WebSocket-Protocol` 서브프로토콜(브라우저 WS 는 커스텀 헤더 불가 — 개발·비상용 브라우저 접속 경로 대비).
- 무토큰/불일치 연결은 즉시 종료. 토큰은 데몬 재시작 시 회전.

## 5. 재연결·복원

- 클라이언트: 지수 백오프 재연결 + 애플리케이션 레벨 ping/pong. 끊김 시 대기 중 RPC 는 즉시 실패시키고, 재연결 후 구독을 자동 복원.
- 재연결 시 `session.list` + 각 세션 `seq` 로 갭 확인 → 갭 있으면 타임라인 재동기화(`session.timeline.request`). 오프라인 캐시는 1차 범위 외.
