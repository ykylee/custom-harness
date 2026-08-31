---
type: decision
status: active
updated: 2026-08-31
last_ingested_from: packages/protocol/src/tools.ts, docs/design/reverse-tool-catalog.md
related_pages: [reverse-tools, attention-state, binary-frames-for-terminal]
---

# 결정 — 역방향 툴 카탈로그는 프로토콜 층이 소유한다

**결정일** 2026-08-31 (M7 WBS 7.2.2) · **상태** 유효

툴 정의(`ToolSpec` · `TOOL_CATALOG` 10종 · `TOOL_NAME_PATTERN` · `toolDescriptor()`)를 `packages/protocol/src/tools.ts` 에 둔다. 데몬도 pi 확장도 여기를 읽는다.

## 왜 위층인가

노출 경로가 **둘**이기 때문이다 (7.2.1 실측으로 확정):

- omp · grok → 데몬이 소유한 MCP stdio 서버
- pi → 네이티브 확장 `pi.registerTool`

두 경로가 각자 툴을 정의하면 **하네스마다 다른 툴 표면**이 생긴다. 모델이 보는 툴은 하네스와 무관하게 같아야 하고, 그러려면 정의가 양쪽보다 위에 있어야 한다.

## 함께 고정한 것 3가지

### 1. 이름은 3~24자

하네스가 **다시 접두사를 붙인다** — omp `mcp__ch_session_list`, grok `ch__session_list`. 원본이 길면 재접두사 후 모델이 다루기 나빠진다. 소문자·숫자·`_` 만, 도메인 접두사(`session_`·`ws_`·`term_`)로 묶는다.

### 2. `write` 는 전부 승인, `read` 는 승인 불요

하네스는 우리 MCP 서버를 **한 덩어리**로만 본다 — "세션 목록 조회"와 "임의 셸 입력"을 구분하지 못하고, grok 은 서버 단위 `always-allow` 를 제안하기까지 한다. 그 구분을 카탈로그가 소유하고 **테스트로 고정**한다.

`read` 를 승인 불요로 둔 것은 편의가 아니다 — **조회까지 막으면 위임한 세션을 감시하는 것 자체가 불가능**해진다.

### 3. 파라미터는 `z.object`(엄격)

프로토콜의 다른 와이어 스키마는 `looseObject` 다. 그 관례는 *"번들 버전이 다른 양쪽이 서로의 추가 필드를 견딘다"* 를 위한 것이고, **카탈로그와 그 핸들러는 같이 배포된다** — 견딜 이유가 없다.

반대로 여기 입력을 만드는 쪽은 **모델**이다. 오타·환각 파라미터가 조용히 무시되면 잘못된 대상에 write 가 나갈 수 있다. **명시적인 검증 실패가 낫다.**

## 주의 상태는 다시 계산하지 않는다

`session_list` 가 싣는 주의 상태는 [[concepts/attention-state]] 의 데몬 정책 값 **그대로**다. 툴 층에서 "무엇이 급한가"를 다시 판단하면 UI 와 에이전트가 서로 다른 답을 보게 된다 — 7.1 이 없애려던 문제를 툴 표면에서 되살리는 꼴이다.
