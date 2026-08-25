<!-- standard-ai-workflow-kit: v1.4.0 -->

# 데몬-렌더러 프로토콜 설계 (M0 WBS 0.2)

- 문서 목적: 렌더러(및 CLI)가 데몬과 통신하는 프로토콜의 스키마 구조·진화 규칙·인증을 확정한다. OPEN-4 해소.
- 상태: approved (v1.1, 2026-08-25 사용자 승인 — 개정: §2 와이어 전용 `user_message` 이벤트 추가, WBS 1.2 구현 중 발견분)
- 최종 수정일: 2026-08-25
- 입력: [어댑터 설계서](./adapter-contract.md), [FR-1.4](../requirements/fr1-harness-sessions.md), [NFR-3/5](../requirements/nfr.md)

## 1. 전송·프레이밍

- **WebSocket over 127.0.0.1** 단일 포트 (NFR-3). 메시지는 JSON 텍스트 프레임.
- **바이너리 프레임: 1차 불채택 (0.2.4 결정)** — 1차 범위에 터미널 스트림·파일 전송이 없다. 프레임 구분 바이트를 예약하지 않고, 필요 시점에 capability 로 추가한다 (와이어 버전 불변 원칙과 합치).
- 봉투 2계층: 연결 레벨(`hello`/`ping`/`pong`) 안에 세션 레벨 RPC·이벤트.

## 2. 스키마 (zod 단일 소스 — protocol 패키지)

- **RPC**: `domain.verb.request` / `.response`, `requestId` 상관. 도메인: `session.*`(create/resume/list/close/prompt/interrupt/permission.respond/model.set), `config.*`(key.set/key.test/get/set), `harness.*`(list/probe), `system.*`(version/shutdown).
- **이벤트**: FR-1.4 유니온을 그대로 와이어 스키마로 — `turn_*`, `message_delta`, `reasoning_delta`, `tool_execution_*`, `permission_*`, `usage_updated`, `session_status_changed`, `error`. 이벤트에는 `sessionId` + 단조 증가 `seq` 를 부여(재연결 시 갭 감지).
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
