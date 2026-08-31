---
type: concept
status: active
updated: 2026-08-31
last_ingested_from: docs/design/workspace-model.md, packages/daemon/src/workspaces/registry.ts, packages/daemon/src/workspaces/records.ts
related_pages: [workbench-canvas, attention-state, harness-wrapping]
---

# 프로젝트 → 워크스페이스 → 세션 3계층

M5 에서 세션 위에 **작업 단위**를 세웠다. 그전까지 세션은 `cwd` 문자열 하나로 떠 있었고, 같은 저장소의 여러 작업을 구분할 방법이 없었다.

```
Project    (프로젝트 루트 1개)
  └── Workspace    (체크아웃 1개 = 작업 단위)
        └── Session    (하네스 대화 1개)
```

| 계층 | 정체성 | 소유물 |
|---|---|---|
| Project | 사용자가 선택한 **정확한** 루트 경로 | 워크스페이스 목록, git remote 메타데이터 |
| Workspace | 프로젝트 안의 체크아웃 1개 | 세션 목록, 라벨, (선택) 백킹 worktree, 탭 배치 |
| Session | 하네스 프로세스 1개의 대화 | 타임라인, 승인 상태, 사용량 |

**기본 워크스페이스**: 프로젝트를 처음 열면 루트 자체를 가리키는 워크스페이스가 자동 생성된다. 사용자는 "워크스페이스"를 의식하지 않고도 곧바로 세션을 만들 수 있다 — 계층을 늘리면서 기존 UX 를 지키는 값이다.

## 설계 원칙 4개

1. **식별자는 불변, 메타데이터는 가변.** 정합화(reconciliation)는 git 에서 읽은 사실만 갱신하고 식별자·경로·표시 이름은 건드리지 않는다. 이 경계가 무너지면 *"이름을 바꾸자 세션이 사라지는"* 종류의 버그가 구조적으로 생긴다.
2. **소유권은 ID 로만 판정한다.** `cwd` 문자열 비교로 세션 소유자를 추론하지 않는다 — 같은 디렉토리를 가리키는 워크스페이스가 둘일 수 있다.
3. **경로는 lexical 정규화만.** `path.resolve` 는 쓰고 **`realpath` 는 쓰지 않는다.** 심링크로 연결된 두 경로를 같은 프로젝트로 합치면 사용자의 의도(별도 작업 트리)를 파괴한다.
4. **스토어가 원자성을 소유한다.** 호출자가 read-modify-write 루프나 락을 직접 돌리게 만들지 않는다. 한 메서드 = 한 트랜잭션.

### 3번 원칙이 실제로 문제를 냈다

`git rev-parse --show-toplevel` 은 **심링크를 푼 경로**를 반환한다(macOS `/tmp` → `/private/tmp`). 원칙 3을 지키려면 이 값을 그대로 쓸 수 없어서, `--show-prefix` 로 **상대 접두사만 걷어내는** 방식으로 전환했다. Windows junction 환경에서 같은 유도가 성립하는지는 C-5 실기기 확인 항목.

## 식별자

`prj_<16 hex>` · `wsp_<16 hex>` — **불투명(opaque)**. 경로에서 유도하지 않는다(경로가 바뀌어도 동일 프로젝트).

같은 정규화 경로로 프로젝트를 다시 요청하면 **기존 활성 프로젝트를 반환**(멱등). 아카이브된 프로젝트는 부활하지 않고 새 ID 를 받는다.

## 격리 — worktree

워크스페이스의 `isolation` 은 `'directory' | 'worktree'`. worktree 백킹은 `data/worktrees` 아래에 만든다(D-1). 아카이브 시 백킹 제거는 **`data/worktrees` 하위 worktree 로 한정** — 사용자가 직접 만든 체크아웃을 지우지 않기 위한 안전장치다.

프로젝트 설정 파일(`harness.json`)의 setup/teardown 명령은 **베이스 브랜치의 커밋본만 읽는다** — 워크스페이스 안의 수정된 파일을 실행하면 신뢰 경계가 무너진다.

## 세션 귀속

세션은 `workspaceId` 로 워크스페이스에 귀속된다. 기존 세션은 데몬 기동 시 **1회 백필**(마커 파일로 재실행 방지). 세션 생성 RPC 는 이제 `cwd` 가 아니라 `workspaceId` 만 받는다 — 구 경로는 `COMPAT(sessionCreateCwd)`.
