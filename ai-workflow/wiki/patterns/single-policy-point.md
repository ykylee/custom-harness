---
type: pattern
status: active
updated: 2026-08-31
last_ingested_from: packages/daemon/src/attention.ts, packages/protocol/src/tools.ts, packages/daemon/src/workspaces/registry.ts
related_pages: [attention-state, tool-catalog-in-protocol, deny-by-default-allowlist]
---

# 패턴 — 판단은 한 곳에서만 한다

같은 질문에 답하는 코드가 두 곳에 있으면 **반드시 갈라진다.** 그 순간 사용자는 화면마다 다른 답을 본다.

이 프로젝트에서 이 패턴은 주로 "정본을 데몬으로 끌어올리는" 형태로 나타난다 — 소비자가 여럿이기 때문이다(렌더러, 트레이, 알림, CLI, 그리고 M7 부터는 하네스 안의 모델까지).

## 적용 지점

### 주의 상태

`packages/daemon/src/attention.ts` 하나가 "봐야 할 세션"을 판단한다. 원래 렌더러의 `bucketOf()` 가 로컬 계산했는데, 소비자가 늘면서 각자 이벤트를 해석하게 됐다.

세션 매니저의 모든 전이(턴 종료·상태 변화·승인 요청/해소·ack·새 프롬프트)가 `refreshAttention()` 한 곳으로 모인다. → [[concepts/attention-state]]

**툴 층에서 다시 계산하지 않는다** — `session_list` 는 그 값을 그대로 싣는다. 다시 판단하면 7.1 이 없애려던 문제가 툴 표면에서 되살아난다.

### 툴 카탈로그

노출 경로가 둘(MCP 서버 / pi 확장)이라 각자 정의하면 하네스마다 다른 표면이 생긴다 → 프로토콜 층 단일 정의. → [[decisions/tool-catalog-in-protocol]]

### 프레임 인코더·디코더

터미널 바이너리 프레임의 인코더·디코더는 protocol 패키지의 **순수 함수**다. 데몬과 렌더러가 같은 구현을 쓴다. → [[decisions/binary-frames-for-terminal]]

### 어댑터 이벤트 = 와이어 이벤트

어댑터 이벤트(`AgentEvent`)와 와이어 이벤트는 **동일 스키마를 공유**한다. 데몬은 `sessionId`·`seq` 부여 외에는 재가공하지 않는다 — 이중 정의 드리프트 방지.

### 아카이브 단일 창구

워크스페이스·프로젝트 아카이브는 레지스트리의 한 메서드를 지난다. 스토어가 원자성을 소유하고 **호출자가 read-modify-write 루프를 직접 돌리지 않는다** — 한 메서드 = 한 트랜잭션.

## 반례 관리

정본을 옮기면 옛 계산 지점을 **지워야** 한다. 남겨두면 둘 다 살아서 더 나쁘다. 7.1 에서 렌더러의 `bucketOf` 재계산을 버리고 알림 경로까지 `attention_changed` 단일 소비로 이관한 것이 그 작업이다.
