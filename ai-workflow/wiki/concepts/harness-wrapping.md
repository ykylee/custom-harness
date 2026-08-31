---
type: concept
status: active
updated: 2026-08-31
last_ingested_from: docs/CONCEPT.md, docs/design/adapter-contract.md, packages/daemon/src/adapters/contract.ts
related_pages: [closed-network-self-containment, zero-config-bundle, reverse-tools]
---

# 하네스 래핑 (Harness Wrapping)

이 프로젝트의 1번 경계선. **에이전트 루프는 래핑된 하네스가 소유하고, 우리는 하네스의 실행·상태·UI 를 소유한다.**

## 무엇을 하지 않는가

모델 호출도, 툴 디스패치도 우리가 하지 않는다. 프롬프트를 받아 모델에 던지고 툴을 돌리고 결과를 다시 넣는 루프 전체가 pi·omp·grok 안에 있다. 우리는 그 프로세스를 띄우고, 표준 입출력으로 대화하고, 이벤트를 정규화해 UI 로 올린다.

PURPOSE 제외 영역의 첫 줄이 이것이다 — "자체 에이전트 루프 구현". 이 선이 흐려지면 하네스마다 다른 루프 동작을 우리가 흉내 내야 하고, 하네스가 업데이트될 때마다 그 흉내가 깨진다.

## 어댑터가 만나는 지점

전송(pi·omp = stdio JSONL RPC / grok = ACP)은 어댑터 내부에 숨고, 데몬은 **2-인터페이스 + 이벤트 유니온**으로만 하네스를 본다.

- `AgentAdapter` — 하네스 종류당 1개. `probe()` · `createSession()` · `resumeSession()` · `listModels()`
- `AgentSession` — 대화 1개. `startTurn()` · `subscribe()` · `interrupt()` · `respondToPermission()`

상태 전이(`initializing → idle ⇄ running → closed`, +error)는 **데몬이 소유**하고 어댑터는 신호만 올린다. `turn_started` 도 데몬이 발행한다 — 하네스마다 턴 시작 시점의 정의가 다르기 때문이다.

## capability 로 차이를 흡수한다

하네스마다 되는 것이 다르다. 그 차이를 어댑터가 조용히 메우지 않고 **플래그로 선언**한다.

- 미지원 기능 호출은 **silent no-op 금지** — `AdapterError('unsupported')` 를 던진다. 조용히 무시하면 UI 는 성공한 줄 안다.
- 플래그는 정적 선언이 기본이고, `probe()` 가 버전을 보고 **하향** 보정할 수 있다. 상향은 금지 — 실물이 뒷받침하지 않는 낙관은 런타임 실패로 돌아온다.

실측으로 1차 하향된 항목이 여럿이다: pi 의 `mcpInjection`(0.84.1 에 주입 플래그 부재), omp 의 `runtimePermission`·`nativeToolRegistration`, 3종 공통 `steering`·`compaction`(RPC 는 실존하나 계약에 메서드가 없어 보류).

## 관련

- 하네스별 실체: [[entities/harness-pi]] · [[entities/harness-omp]] · [[entities/harness-grok]]
- 이 경계 덕에 가능한 것: [[concepts/reverse-tools]] — 우리 기능을 하네스에게 되돌려 노출한다
