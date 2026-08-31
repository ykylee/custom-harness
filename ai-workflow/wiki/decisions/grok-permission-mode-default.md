---
type: decision
status: active
updated: 2026-08-31
last_ingested_from: docs/reference/harness-mcp-support.md, scripts/grok-permission-probe.mjs, packages/daemon/src/adapters/acp/grok.ts
related_pages: [harness-grok, home-isolation, grok-acp-path]
---

# 결정 — grok 은 `--permission-mode default` 를 항상 명시한다

**결정일** 2026-08-31 (M7 WBS 7.2.0b) · **상태** 유효

`GrokAdapter` 가 `agent stdio` spawn 시 `--permission-mode default` 를 **항상 붙인다.** 생략은 `permissionMode: 'inherit'` 로만 가능하고 권장하지 않는다.

## 증상

권한 모드를 지정하지 않고 띄우면 모델의 `use_tool` 호출이 이렇게 잘렸다:

```
Tool `use_tool` was not executed: Auto mode blocked this action.
```

**`session/request_permission` 이 아예 오지 않는다** — 사용자가 승인할 기회조차 없다. 우리 승인 배선(WBS 2.2.3)은 정상인데 그 앞단에서 잘린다.

## 원인 — 우리가 만든 게 아니었다

grok 의 권한 정책이 **사용자 실제 `$HOME` 에서 들어오고 있었다.** `GROK_HOME` 을 격리해도 `grok inspect` 는 이렇게 찍는다:

```
Permissions
└ Source: /Users/yklee/.claude/settings.json (settings)
└ 12 loaded, 0 skipped
```

측정 PC 의 `~/.claude/settings.json` 에 `permissions.defaultMode = "auto"` 가 있었고, grok 의 Claude 호환 import 가 이를 읽었다. auto 모드는 목록에 없는 툴을 *묻지 않고* 거절한다.

즉 [[concepts/home-isolation]] 과 **같은 뿌리**(`$HOME` 누수)의 다른 증상이었다.

## 왜 격리만으로 끝내지 않았나

격리(7.2.0a)만으로 증상은 사라진다. 그런데 **모드를 지정하지 않은 상태는 grok 의 설정 탐색 결과에 좌우된다** — 1.0.5 는 물었고 1.0.13 은 누수된 설정 아래서 잘랐다. 이미 한 번 드리프트한 것이다. 그래서 명시 고정했다.

## 모드 행렬 실측

`node scripts/grok-permission-probe.mjs` (grok 1.0.13, 홈 격리 on):

| `--permission-mode` | MCP 툴 승인 요청 | 내장 `write` 승인 요청 |
|---|---|---|
| **`default`** | **✅** | **✅** |
| `acceptEdits` | ❌ | ✅ |
| `auto` | ❌ | ❌ |
| `dontAsk` | ❌ | ✅ |
| `bypassPermissions` | ❌ | ❌ |
| `plan` | ❌ | ✅ |

**MCP 툴과 내장 파괴적 툴이 동시에 승인 대상인 모드는 `default` 하나뿐이다.** `acceptEdits`·`dontAsk`·`plan` 은 이름과 달리 **MCP 툴을 묻지 않고 실행한다** — 이름으로 고르면 틀린다. → [[patterns/measure-dont-assume]]

결과적으로 7.2.0b 의 원래 목표("MCP 툴만 승인 대상")보다 나은 상태다. 자동 승인 정책은 우리 레이어(`autoApprove` 설정)가 소유한다.

## 검증

fake grok 픽스처가 `FAKE_GROK_ARGV_FILE` 로 spawn 인자를 기록해 테스트 3건이 플래그를 검증한다. `mcp-probe --daemon --only grok` 이 우회 플래그 없이 PASS.

## 재실측 조건

**번들 grok 갱신 시 모드 행렬을 다시 잰다.** 1.0.5 → 1.0.13 사이에 이미 동작이 바뀌었다.
