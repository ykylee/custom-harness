---
type: decision
status: active
updated: 2026-08-31
last_ingested_from: docs/design/protocol-design.md, docs/design/workbench-tabs.md, packages/protocol/src/terminal.ts
related_pages: [workbench-canvas, daemon, tool-catalog-in-protocol]
---

# 결정 — 터미널은 바이너리 프레임으로 보낸다

**결정일** 2026-08-30 (M6 WBS 6.1.2, protocol-design v1.2) · **상태** 유효

같은 WebSocket 위에 텍스트(JSON)와 바이너리를 혼재한다. 프레임: `[opcode:1][slot:1][payload...]` — `0x01` 데몬→클라이언트 출력, `0x02` 클라이언트→데몬 입력. `slot` 은 연결 단위 1바이트 터미널 핸들이고 `terminal.attach` 응답이 배정한다.

## 이것은 방향 전환이 아니다

M0 0.2.4 는 바이너리 프레임을 **불채택**했다 — 당시 1차 범위에 터미널 스트림이 없었기 때문이다. 다만 그 결정은 *필요 시점에 capability 로 추가한다*는 경로를 함께 남겼다. **M6 터미널이 그 시점이고, 이것은 그 조항의 발동이다.**

(이 구분을 명시해 두는 이유: 나중에 "왜 결정이 뒤집혔나"를 다시 묻지 않게 하려는 것이다.)

## 왜 JSON 이 아닌가

바이트 스트림을 문자열로 감싸면 **인코딩 왕복과 이스케이프 비용이 매 키 입력마다** 붙는다. base64 는 payload 를 33% 불리고, UTF-8 검증은 터미널이 내보내는 임의 바이트열과 맞지 않는다.

## 와이어 버전은 올리지 않는다

`protocolVersion: 1` 고정 원칙을 지킨다. 대신 데몬이 `features.terminalBinaryFrames` 로 광고하고, **플래그가 없으면 클라이언트는 터미널 기능을 숨긴다** — 폴백 경로를 만들지 않는다(§3 원칙 유지). 기능을 반쯤 흉내 내는 경로가 가장 비싸다.

## 검증 규칙이 JSON 채널과 다르다

- 순수성 게이트(`.transform()`/`.catch()`/`.preprocess()` 금지)는 **JSON 와이어 스키마에 대한 규칙**이다. 바이너리 채널은 zod 검증 대상이 아니다.
- 검증 실패는 예외가 아니라 **`undefined` 반환** — 연결을 끊지 않는다.
- 미지 opcode 프레임은 **조용히 버린다**(관대 파싱, NFR-5).

인코더·디코더는 protocol 패키지의 **순수 함수**로 두어 데몬과 렌더러가 같은 구현을 쓴다. 양쪽에 따로 구현하면 반드시 갈라진다.
