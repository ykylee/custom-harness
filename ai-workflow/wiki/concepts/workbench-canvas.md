---
type: concept
status: active
updated: 2026-08-31
last_ingested_from: docs/design/workbench-tabs.md, packages/renderer/src/workbench/tabs.ts, packages/daemon/src/terminals.ts
related_pages: [workspace-three-layer, reverse-tools, closed-network-self-containment]
---

# 작업 캔버스 (Workbench Canvas)

M6 에서 워크스페이스를 **대화창에서 작업 캔버스로** 확장했다. 탭이 세션만 담던 것을 터미널·파일·diff 까지 담도록 일반화한 것.

## 설계 원칙 3개

1. **탭은 무엇을 보느냐이지 무엇을 소유하느냐가 아니다.** 탭을 닫는 것은 레이아웃 변경이고 대상의 수명과 무관하다. 소유는 워크스페이스가 한다.
2. **같은 대상은 한 번만 열린다.** 탭 ID 를 타깃에서 **결정적으로** 유도해 같은 파일·같은 세션이 두 탭에 흩어지지 않게 한다.
3. **터미널은 JSON 을 지나지 않는다.** 바이트 스트림을 문자열로 감싸면 인코딩 왕복과 이스케이프 비용이 **매 키 입력마다** 붙는다.

## 탭 타깃 유니온

```ts
type TabTarget =
  | { kind: 'new_tab' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'terminal'; terminalId: string }
  | { kind: 'files' }
  | { kind: 'file'; path: string }
  | { kind: 'diff'; scope: 'working' }
  | { kind: 'diff'; scope: 'commit'; sha: string };
```

새 타깃은 **유니온에 추가**하고 렌더러의 `switch` 가 컴파일 에러로 누락을 잡게 한다. 결정적 ID: `session:<id>` · `terminal:<id>` · `files` · `file:<path>` · `diff:working` · `diff:<sha>`.

레이아웃은 **워크스페이스 단위**로 보존한다(`layout[workspaceId]`). 복원 시 **살아 있지 않은 타깃은 조용히 버린다** — 복원 실패가 화면 전체를 막지 않는다.

## 터미널은 데몬이 소유한다

pty 를 데몬이 들고 있어서 탭을 닫아도, 렌더러가 재연결해도 세션이 살아 있다. 256KiB 링 버퍼 + 연결별 슬롯 다중화, `attach` 시 **스냅샷과 구독을 원자적으로** 제공한다(그 사이에 도착한 출력이 새지 않도록).

전송은 같은 WebSocket 위의 **바이너리 프레임** `[opcode:1][slot:1][payload...]` — `0x01` 데몬→클라이언트, `0x02` 클라이언트→데몬. → [[decisions/binary-frames-for-terminal]]

## 파일·diff 는 방어가 본체다

워크스페이스가 임의 저장소를 여는 구조라 경로 처리가 곧 보안 표면이다.

- 절대 경로·`..`·심링크 탈출 **거절**, `realpath` 2차 확인
- 2MiB 상한 + 바이너리 방어
- diff 는 HEAD 기준 working + 미추적, 커밋 sha 검증
- 변경 감시는 `git status` **지문 폴링**이고 이벤트는 신호만 보낸다(내용은 요청 시)

## 오프라인 성립

`@lydell/node-pty` 가 N-API 라는 것을 스파이크로 실측했다 — 같은 prebuilt 가 Node ABI 141·Electron ABI 149 에서 동작하므로 **Electron 재빌드가 필요 없다.** 3 OS prebuilt 를 번들에 고정 조달하고 `npm run smoke:terminal` 로 번들 실물 pty 왕복을 검증한다.

**단 darwin 만 실검증됐다** — Windows 는 conpty 경로라 결과가 그대로 이어지지 않는다. C-5 실기기 항목.
