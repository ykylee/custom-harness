<!-- standard-ai-workflow-kit: v1.4.0 -->

# 워크스페이스 모델 설계 (M5 WBS 5.1)

- 문서 목적: 프로젝트 → 워크스페이스 → 세션 3계층의 **식별자 정책·정합화 계약·레코드 스키마·저장 배치·RPC 표면**을 확정한다.
- 상태: approved (v1, 2026-08-30 사용자 승인 — 5.1.3 완료)
- 최종 수정일: 2026-08-30
- 입력: [FR-7](../requirements/fr7-workspaces.md), [paseo 서비스 분석 §1.1~1.3](../reference/paseo-service-inventory.md), [데몬 상세 설계](./daemon-design.md), [프로토콜 설계](./protocol-design.md)
- 산출: M5 WP 5.0·5.2~5.6 의 구현 근거

## 0. 설계 원칙 4개

1. **식별자는 불변, 메타데이터는 가변.** 정합화(reconciliation)는 git 에서 읽은 사실만 갱신하고 식별자·경로·표시 이름은 건드리지 않는다. 이 경계가 무너지면 "이름이 바뀌자 세션이 사라지는" 종류의 버그가 구조적으로 생긴다.
2. **소유권은 ID 로만 판정한다.** `cwd` 문자열 비교로 세션 소유자를 추론하지 않는다. 같은 디렉토리를 가리키는 워크스페이스가 둘일 수 있다.
3. **경로는 lexical 정규화만.** `path.resolve` 는 쓰고 `realpath` 는 쓰지 않는다 — 심링크로 연결된 두 경로를 같은 프로젝트로 합치면 사용자의 의도(별도 작업 트리)를 파괴한다.
4. **스토어가 원자성을 소유한다.** 호출자가 read-modify-write 루프나 락을 직접 돌리게 만들지 않는다. 한 메서드 = 한 트랜잭션.

## 1. 3계층 정의

```
Project  (프로젝트 루트 1개)
  └── Workspace  (체크아웃 1개 = 작업 단위)
        └── Session  (하네스 대화 1개)
```

| 계층 | 정체성 | 수명 | 소유물 |
|---|---|---|---|
| Project | 사용자가 선택한 정확한 루트 경로 | 사용자가 지울 때까지 | 워크스페이스 목록, git remote 메타데이터 |
| Workspace | 프로젝트 안의 체크아웃 1개 | 아카이브까지 | 세션 목록, 라벨, (선택) 백킹 worktree |
| Session | 하네스 프로세스 1개의 대화 | 종료·아카이브까지 | 타임라인, 승인 상태, 사용량 |

**기본 워크스페이스**: 프로젝트를 처음 열면 루트 자체를 가리키는 워크스페이스 1개가 자동 생성된다. 사용자는 "워크스페이스"를 의식하지 않고도 곧바로 세션을 만들 수 있어야 한다(현행 UX 보존).

## 2. 식별자 정책

| 대상 | 형식 | 규칙 |
|---|---|---|
| projectId | `prj_<16 hex>` | 불투명. 경로에서 유도하지 않는다(경로가 바뀌어도 동일 프로젝트) |
| workspaceId | `wsp_<16 hex>` | 불투명 |
| sessionId | 현행 유지 | 변경 없음 |

- 경로 정규화: `path.resolve` + Windows 드라이브 문자 대문자화. **`realpath` 금지.**
- 같은 정규화 경로로 프로젝트를 다시 요청하면 **기존 활성 프로젝트를 반환**(멱등). 아카이브된 프로젝트는 부활하지 않고 새 ID 를 받는다.
- `projectKey`(optional): 호스트 횡단 동일 프로젝트 그룹핑용. 현재는 사용하지 않지만 **자리만 예약**한다 — git remote 정규화 문자열, 없으면 미기입. 소비자는 이 값을 live git 에서 재유도하지 않는다.

## 3. 레코드 스키마

### 3.1 Project

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | `string` | `prj_<hex>` |
| `root` | `string` | 정규화된 절대 경로. **불변** |
| `displayName` | `string` | 기본값은 디렉토리명. 사용자 편집 가능. 정합화가 덮지 않는다 |
| `kind` | `'git' \| 'plain'` | 가변 (정합화가 갱신) |
| `defaultBranch` | `string?` | 가변 |
| `remoteUrl` | `string?` | 가변. 폐쇄망 로컬 저장소는 부재가 정상 |
| `projectKey` | `string?` | 예약 (§2) |
| `iconRef` | `string?` | 예약 |
| `createdAt` / `updatedAt` | ISO 8601 | |
| `archivedAt` | ISO 8601 `?` | 소프트 삭제 |

### 3.2 Workspace

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | `string` | `wsp_<hex>` |
| `projectId` | `string` | **불변**. 재귀속(rehome) 금지 |
| `cwd` | `string` | 세션이 실행되는 정확한 디렉토리. **불변** |
| `checkoutRoot` | `string` | 백킹 체크아웃 루트. worktree 미사용이면 `cwd` 와 동일하거나 저장소 루트 |
| `isolation` | `'directory' \| 'worktree'` | 격리 방식 |
| `displayName` | `string` | 정합화가 덮지 않는다 |
| `baseBranch` | `string?` | worktree 생성 시 분기 기준. **불변** |
| `branch` | `string?` | 현재 브랜치 — 가변(정합화 갱신) |
| `labels` | `Record<string,string>` | 기본 `{}` |
| `mainRepoRoot` | `string?` | worktree 복구용 |
| `setupState` | `'none' \| 'pending' \| 'ok' \| 'failed'` | 프로젝트 설정 파일 setup 실행 결과 |
| `createdAt` / `updatedAt` | ISO 8601 | |
| `archivedAt` | ISO 8601 `?` | |

### 3.3 Session (기존 스키마 확장 — additive)

`SessionSummarySchema` 에 다음을 **전부 optional 로** 추가한다(WP 5.0.2, 이전 클라이언트 파싱 보존).

| 필드 | 타입 | 도입 시점 |
|---|---|---|
| `workspaceId` | `string?` | 5.0.2 에 자리 확보 → 5.4.1 에서 사실상 필수화 |
| `labels` | `Record<string,string>?` | 5.0.2 |
| `archivedAt` | `string?` | 5.0.2 |
| `requiresAttention` | `boolean?` | 5.0.2 (M7 7.1 이 채운다) |
| `attentionReason` | `'finished' \| 'error' \| 'permission'` `?` | 5.0.2 |
| `title` | `string?` | 5.0.2 (M7 7.6 이 채운다) |

> `cwd` 는 남긴다. 다만 **소유권 판정에서는 배제**되고 표시·진단 용도로만 쓰인다.

## 4. 정합화(reconciliation) 계약

**입력**: 활성 프로젝트 루트와 활성 워크스페이스 `cwd`. **출력**: 가변 메타데이터 갱신뿐.

| 갱신 가능 | 절대 불변 |
|---|---|
| `kind`, `defaultBranch`, `remoteUrl`, `branch`, `updatedAt` | `id`, `projectId`, `root`, `cwd`, `displayName`, `baseBranch`, `isolation` |

- 워크스페이스는 **자기 `cwd` 로부터 독립적으로** 갱신된다. 프로젝트 루트의 git 상태가 워크스페이스의 상태를 함의하지 않는다(worktree 는 브랜치가 다르다).
- 빈 프로젝트(워크스페이스 0개)도 관측 대상이다.
- 정합화는 백그라운드 주기 + 명시적 트리거(워크스페이스 열기) 양쪽에서 돈다. 실패는 로그로 남기고 레코드를 훼손하지 않는다.

## 5. 저장 배치

기존 데이터 디렉토리(daemon-design §1)를 확장한다.

```
~/.custom-harness/data/
├── projects/
│   ├── projects.json          # 프로젝트 레지스트리 (원자적 쓰기)
│   ├── workspaces.json        # 워크스페이스 레지스트리 (원자적 쓰기)
│   └── labels.json            # 라벨 카탈로그 + 할당
├── sessions/<sessionId>/      # 기존 유지 (meta.json + timeline.jsonl)
├── pi-home/ omp-home/ grok-home/   # 기존 유지
└── ...
```

- 레지스트리는 **단일 파일 + 원자적 교체**(tmp write → rename)로 시작한다. 레코드 수가 수천 단위를 넘기 전까지 파일 분할은 하지 않는다(YAGNI).
- 쓰기는 스토어 내부에서 직렬화한다 — PID 원장에서 겪은 read-modify-write 경합(2.7.3)의 재발을 구조적으로 막는다.
- 스키마 버전 필드를 두되 **마이그레이션 프레임워크는 만들지 않는다**. 전방 호환은 optional 필드 + 기본값으로 흡수한다(기존 방침 유지).

## 6. 프로비저닝 서비스 (단일 창구)

워크스페이스 레코드를 만드는 경로는 **하나**다: `WorkspaceProvisioningService`.

```
디렉토리 열기 ─┐
worktree 생성 ─┼→ WorkspaceProvisioningService → workspaces.json
세션 백필    ─┘                                  (+ setup 훅 트리거)
```

- 이 서비스 밖에서 레코드를 직접 구성하지 않는다. paseo 가 이 규칙을 세운 이유가 그대로 적용된다 — 생성 경로가 셋이면 불변식도 셋이 된다.
- 아카이브도 대칭으로 단일 창구(`archive(workspaceId, opts)`): ① 세션 종료 ② teardown 실행(`cwd` 기준) ③ 레코드에 `archivedAt` 기입 ④ 마지막 참조 소멸 후 백킹 디렉토리 제거(worktree 인 경우만, 그리고 **사용자 확인 후**).

## 7. 프로젝트 설정 파일 (`harness.json`) — 5.1.2

저장소 루트에 두는 선택적 파일.

```jsonc
{
  "workspace": {
    "setup": ["npm ci"],            // 문자열 또는 문자열 배열
    "teardown": ["npm run clean"]
  },
  "scripts": {
    "test": { "command": "npm test" }
  }
}
```

- **읽는 위치**: 워크스페이스의 `baseBranch` 커밋본. 작업 중인 브랜치의 미커밋 변경은 실행 경로에 반영되지 않는다.
- **실행 환경**: `cwd` = 워크스페이스, 환경 변수 `CUSTOM_HARNESS_SOURCE_CHECKOUT`(원본 체크아웃 절대 경로), `CUSTOM_HARNESS_WORKSPACE_ID`.
- **신뢰 경계(중요)**: 저장소 파일이 곧 실행 명령이다. 따라서
  - setup/teardown 은 **프로젝트 단위 신뢰 표시 후에만** 실행한다. 최초 1회 명령 전문을 보여주고 사용자 확인을 받는다.
  - 신뢰는 프로젝트 + 파일 내용 해시에 묶는다. 내용이 바뀌면 다시 확인한다.
  - 자동 실행 기본값은 **off**. 미신뢰 상태에서는 워크스페이스가 `setupState: 'pending'` 으로 생성되고 UI 가 실행 버튼을 노출한다.
  - `scripts` 실행도 동일 신뢰 게이트를 탄다(M6 6.6).
- 이름 충돌 회피와 라이선스 경계를 위해 파일명·키 이름은 paseo 와 다르게 우리 이름을 쓴다.

## 8. RPC 표면 (5.0.3 네임스페이스 예약)

기존 규약(`domain.verb`, ok 판별 응답, 신규 필드 optional)을 그대로 따른다.

| 메서드 | 요청 | 응답 |
|---|---|---|
| `project.open` | `{ root }` | `{ project }` (멱등) |
| `project.list` | `{ includeArchived? }` | `{ projects }` |
| `project.update` | `{ projectId, displayName? }` | `{ project }` |
| `project.archive` | `{ projectId }` | `{}` |
| `workspace.create` | `{ projectId, isolation, baseBranch?, branch?, displayName? }` | `{ workspace }` |
| `workspace.list` | `{ projectId?, includeArchived? }` | `{ workspaces }` |
| `workspace.update` | `{ workspaceId, displayName?, labels? }` | `{ workspace }` |
| `workspace.archive` | `{ workspaceId, removeCheckout? }` | `{}` |
| `workspace.setup.run` | `{ workspaceId, trust? }` | `{ setupState }` |
| `session.create` | **`workspaceId` 추가**(`cwd` 는 5.4.1 이후 무시) | 기존 |

신규 이벤트: `project_changed`, `workspace_changed`(생성·갱신·아카이브를 하나의 이벤트로, `reason` 필드로 구분).

## 9. 마이그레이션 (5.4.2)

1. 기동 시 `workspaceId` 없는 세션을 수집한다.
2. 각 세션의 `cwd` 로 프로젝트·기본 워크스페이스를 **필요하면 생성**하고 매핑한다.
3. 매핑 결과를 세션 메타에 기입한다. **이 단계가 cwd → workspaceId 매핑이 존재하는 유일한 코드 경로다.**
4. 1회 실행 후 마커를 남기고 재실행하지 않는다. 실패한 세션은 로그에 남기고 건너뛴다(기동을 막지 않는다).

## 10. 결정 (2026-08-30 승인)

- **D-1 확정**: worktree 는 **데이터 디렉토리 내부** `~/.custom-harness/data/worktrees/<workspaceId>` 에 만든다. 폐쇄망 사내 PC 의 디스크 정리·제거 스크립트(uninstall `--purge`) 일관성을 사용자 접근 편의보다 우선한다. 워크스페이스 UI 는 실제 경로를 항상 표시하고, 경로 복사·외부 에디터 열기로 접근성을 보완한다.
- **D-2 확정**: 기본 워크스페이스는 **프로젝트 열기 즉시** 생성한다(빈 워크스페이스가 UI 앵커).
- **D-3 확정**: 아카이브된 워크스페이스의 세션 타임라인은 **무기한 보존**. 디스크 압박은 별도 정리 명령으로 다룬다.
