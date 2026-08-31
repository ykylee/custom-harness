---
type: concept
status: active
updated: 2026-08-31
last_ingested_from: packages/daemon/src/attention.ts, packages/daemon/src/session-manager.ts, docs/requirements/fr9-orchestration.md
related_pages: [reverse-tools, workspace-three-layer, single-policy-point]
---

# 주의 상태 (Attention State)

"**사용자가 지금 봐야 할 세션은 어느 것인가**"를 데몬이 정본으로 계산한다. M7 WP 7.1.

세션이 여러 개일 때 화면은 전부 보여줄 수 없고, 중요한 것은 "실행 중"이 아니라 **멈춰서 사람을 기다리는 것**이다.

## 왜 데몬으로 옮겼나

원래는 렌더러가 `bucketOf()` 로 로컬 계산했다. 문제는 소비자가 하나가 아니라는 것이다 — 사이드바 버킷, 트레이 배지, OS 알림, 그리고 M7 에서 추가된 [[concepts/reverse-tools]] 의 `session_list`. 각자 이벤트를 해석하면 **UI 와 에이전트가 서로 다른 답을 본다**.

`packages/daemon/src/attention.ts` 가 **단일 정책 지점**이다. → [[patterns/single-policy-point]]

## 정책

**사유 우선순위**: `permission` > `error` > `finished`

규칙 네 개, 전부 테스트로 고정:

1. **승인 대기는 확인(ack)으로 사라지지 않는다.** 화면을 본 것은 응답한 것이 아니다. 다른 사유는 ack 로 해소된다.
2. **실행 중인 턴은 주의 대상이 아니다.** 진행 중은 정상 상태다.
3. **취소된 턴도 주의 대상이 아니다.** 사용자가 스스로 멈춘 것이다.
4. **같은 사유가 이어지면 `attentionTimestamp` 는 최초 전이 시각을 보존한다.** 매번 갱신하면 "오래 기다린 순" 정렬이 불가능해진다.

## 영속성이 요점이다

주의 3필드(`requiresAttention` · 사유 · `attentionTimestamp`)를 **세션 레코드에 영속**한다. 데몬을 재기동해도 그대로 조회된다.

이게 중요한 이유: 위임한 세션은 **아무도 보고 있지 않은 동안** 승인을 기다린다. 클라이언트가 붙어 있을 때만 계산되는 값이면 그 구간이 통째로 사라진다. 클라이언트 부재 구간 보존을 테스트로 고정했다.

M5 5.0.2 에서 세션 레코드에 이 필드들의 자리를 **미리** 잡아둔 덕에 마이그레이션이 없었다 — 로드맵의 명시적 의존이었다.

## 표면

- `attention_changed` 와이어 이벤트 — **변화가 있을 때만** 발행
- `session.attention.ack` RPC — 멱등
- `SessionSummary` 의 주의 3필드

렌더러는 `bucketOf` 재계산을 버리고 데몬 값만 소비한다('확인 필요' 버킷 신설). 알림도 `turn_completed`/`permission_requested` 각자 해석에서 `attention_changed` 단일 소비로 이관했고, 세션을 열면 ack 를 보낸다.

## 잔여

트레이 배지·자동 승인이 주의 상태를 **직접** 소비하도록 셸 트랙 배선, `attentionTimestamp` 기반 "오래 기다린 순" 정렬 UI.
