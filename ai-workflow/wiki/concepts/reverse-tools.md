---
type: concept
status: active
updated: 2026-09-01
last_ingested_from: packages/protocol/src/tools.ts, packages/daemon/src/mcp/gate.ts, docs/design/reverse-tool-catalog.md, docs/reference/harness-mcp-support.md
related_pages: [attention-state, harness-wrapping, home-isolation, tool-execution-in-daemon]
---

# 역방향 툴 (Reverse Tools)

**데몬이 자신의 기능을 하네스에게 되돌려 노출**하는 툴. 방향이 거꾸로라 "역방향"이다 — 평소에는 우리가 하네스를 부르지만, 여기서는 하네스 안의 모델이 우리를 부른다.

목적: 세션을 **위임 가능한 작업 단위**로 만든다. 한 에이전트가 다른 세션을 만들고, 상태를 보고, 프롬프트를 넣고, 터미널을 조작한다. M7 WP 7.2.

## 노출 경로가 둘이다

7.2.1 실측이 확정한 사실:

| 하네스 | MCP | 경로 |
|---|---|---|
| omp 17.3.8 | ✅ 네이티브 | 데몬 소유 MCP stdio 서버 |
| grok 1.0.13 | ✅ 네이티브 | 같은 MCP 서버 |
| pi 0.84.1 | ❌ **설계상 배제** | `pi.registerTool()` 확장 |

pi 는 README 가 명시적으로 배제한다 — *"No MCP. Build CLI tools with READMEs, or build an extension that adds MCP support."* 대신 확장 API 가 1급이고 **기동 후에도 등록 가능**해서, 같은 카탈로그를 그대로 다시 노출하면 된다.

## 왜 카탈로그가 프로토콜 층에 있나

경로가 둘인데 각자 툴을 정의하면 **하네스마다 다른 툴 표면**이 생긴다. 모델이 보는 툴은 하네스와 무관하게 같아야 하고, 그러려면 정의가 양쪽보다 위층에 있어야 한다 → `packages/protocol/src/tools.ts`. → [[decisions/tool-catalog-in-protocol]]

## 카탈로그 10종

| 이름 | 효과 | 승인 |
|---|---|---|
| `session_list` (주의 상태 동봉) · `session_read` · `ws_list` · `term_list` · `term_read` | read | — |
| `session_new` (재귀 위험) · `session_say` · `session_stop` · `term_new` · `term_send` (임의 셸) | write | ✅ |

**이름은 짧아야 한다.** 하네스가 다시 접두사를 붙이기 때문이다 — omp `mcp__ch_session_list`, grok `ch__session_list`. 규칙: 소문자·숫자·`_`, **3~24자**(`TOOL_NAME_PATTERN`).

`session_list` 가 싣는 주의 상태는 [[concepts/attention-state]] 의 데몬 정책 값 **그대로**다. 툴 층에서 다시 판단하면 7.1 이 없애려던 문제가 되살아난다.

## 승인은 우리가 소유한다

하네스는 우리 MCP 서버를 **한 덩어리**로 볼 뿐이라 "세션 목록 조회"와 "임의 셸 입력"을 구분하지 못한다 — grok 은 서버 단위로 `always-allow` 를 제안하기까지 한다. 그 구분을 카탈로그가 소유한다. 규칙 두 줄을 테스트로 고정:

- `effect: 'write'` 는 **전부** 승인 대상
- `effect: 'read'` 는 승인 불요 — **조회까지 막으면 위임한 세션을 감시하는 것 자체가 불가능**해진다

파라미터는 `z.strictObject`. 와이어 스키마의 `looseObject` 관례를 따르지 않는데, 그 관례는 "번들 버전이 다른 양쪽이 서로의 추가 필드를 견딘다"를 위한 것이고 카탈로그와 핸들러는 **같이 배포**된다. 여기 입력을 만드는 쪽은 모델이라 환각 파라미터가 조용히 무시되면 안 된다.

> **정정 (7.2.3)**: v1 은 `z.object` 를 "엄격"이라 적었으나 틀렸다 — `z.object` 는 미지 키를 *조용히 제거*할 뿐 거부하지 않는다. e2e 가 `ws_list({projectID})` 를 통과시키며 드러냈고 카탈로그 전체를 `z.strictObject` 로 고쳤다.

## 그대로 켜면 안 되는 조건 — 전부 처리됨 (7.2.3·7.2.4)

- **omp 는 기본값에서 MCP 툴을 은닉한다** — `tools.xdev=true` 가 `xd://` 디바이스로 마운트. 등록 시 `tools.xdev=false` 를 동반 기입한다
- **omp 데몬 경로(`--mode rpc`)는 MCP 를 비동기로 싣는다** — 1턴째 미노출은 **구조적**이다(서버 프로세스를 첫 턴에야 띄운다, 7.2.3 실측). 준비 게이트는 2턴째 이후의 경합만 막도록 재정의됐다
- **grok 은 `search_tool` → `use_tool` 2단 메타 툴 경유** — 규약을 어기면 간헐 실패(재현율 1/3), 지키면 3/3
- **프로젝트 `.mcp.json` 이 사용자 스코프를 덮는다** — 저장소가 우리 툴 이름을 선점할 수 있다. 7.2.4 가 세션 생성 시 **탐지해 경고**한다(막지는 않는다 — 그 파일을 읽는 것은 하네스이고, 저장소가 자기 서버를 두는 것은 정상이다)
- **재귀** — `session_new` 로 만든 세션이 또 `session_new` 를 부른다. 7.2.4 의 깊이 상한(`tools.maxSessionDepth`, 기본 1)이 막는다. 깊이는 **세션 라벨에 영속**한다(`ch.toolDepth`) — 데몬 메모리에 두면 재시작 횟수만큼 우회된다

## 안전장치 (7.2.4)

노출이 켜지는 순간 이것은 **데몬 제어 권한 상승 통로**가 된다. 그래서 `tools.reverseExposure` 는 **기본 off** 이고([[concepts/home-isolation]] 과 기본값 방향이 반대다 — 그쪽은 *끄는* 것이 위험하다), 실행은 전부 데몬 안의 한 관문을 지난다 → [[decisions/tool-execution-in-daemon]]

승인은 하네스 승인과 **같은 채널**로 나간다(`permission_requested` + `origin: 'reverse_tool'`). 새 채널을 만들면 [[concepts/attention-state]]·사이드바·알림·승인 카드를 전부 두 번 구현하게 된다.

**write 왕복 실측 (2026-09-01)**: omp·grok·pi 3종 모두 PASS — 목 모델이 `session_new` 를 부르고, 데몬이 승인 카드를 올리고, 승인 후 세션이 실제로 생기며 자식에 `ch.toolDepth=1` 이 붙는다.
