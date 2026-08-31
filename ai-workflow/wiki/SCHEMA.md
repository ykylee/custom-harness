<!-- standard-ai-workflow-kit: v1.7.0 -->

# Wiki 운영 헌법 (Operating Constitution)

- 문서 목적: `ai-workflow/wiki/` 지식 계층의 배치·페이지 계약·갱신 규칙을 확정한다.
- 범위: 페이지 타입, frontmatter 계약, 인덱스 규칙, 갱신·폐기 규칙. 페이지 **내용**은 각 페이지가 SSOT.
- 대상 독자: AI agent, 유지보수자
- 상태: active (v1, 2026-08-31 — 소급 구축 시 작성, TASK-2026-08-31-main-007)
- 최종 수정일: 2026-08-31
- 관련 문서: [index](./index.md), [log](./log.md), [CLAUDE.md](../../CLAUDE.md)

## 0. 이 계층이 존재하는 이유

`ai-workflow/memory/` 는 **시간 축**이다 — 지금 무엇을 하고 있는지, 다음 세션이 무엇을 이어받는지. 오래된 내용은 handoff 에서 밀려나고 backlog 는 날짜별로 흩어진다.

이 위키는 **주제 축**이다. "grok 의 권한 모드는 왜 `default` 로 고정돼 있나", "omp 는 MCP 툴을 어디에 숨기나" 같은 질문은 특정 세션의 소유가 아니라 프로젝트의 상시 지식이고, 그 답이 28KB 짜리 handoff 안에 묻히면 다음 세션이 같은 실측을 다시 한다.

**분업 규칙**: 시간이 지나면 틀려지는 것은 memory 로, 다시 물어볼 것은 wiki 로.

## 1. 배치 (R1·D2)

| # | 항목 | 값 |
|---|---|---|
| 1 | 위치 | `ai-workflow/wiki/` (Runtime layer, R1) |
| 2 | 추적 | git 추적 — `memory/` 와 분리 (D2) |
| 3 | 페이지 타입 | 5종 — `entities` / `concepts` / `decisions` / `patterns` / `queries` |
| 4 | primary record | 페이지 atomic (R2) — 1 주제 = 1 파일 |
| 5 | 인덱스 | anchor 기반 (R4) — `index.md` |
| 6 | 머지 | additive (R5) — 기존 문단을 덮지 않고 추가 |
| 7 | lint | 모순 · 스테일 · 고아 · 누락 · 깨진 backlink |

### 타입별 경계

| 타입 | 담는 것 | 담지 않는 것 |
|---|---|---|
| `entities/` | 이름이 붙은 실체 — 하네스, 데몬, 게이트웨이, 번들 | 그 실체를 다루는 방법론 |
| `concepts/` | 이 프로젝트에서만 통하는 용어·모델 | 일반 소프트웨어 상식 |
| `decisions/` | 되돌리려면 근거가 필요한 결정 + **왜** | 아직 안 정한 것 (→ 원 설계서의 §미해결) |
| `patterns/` | 재사용 가능한 작업 방식 | 1회성 절차 |
| `queries/` | 반복해서 묻게 되는 질문과 그 답으로 가는 경로 | 답 자체 (→ 링크로 넘긴다) |

## 2. 페이지 계약 (frontmatter)

모든 L1 페이지는 아래 frontmatter 로 시작한다. 필드명·형식은 킷의 `score_wiki_maintainability` 가 읽는 것과 같다.

```yaml
---
type: concept          # concept | entity | decision | pattern | query
status: active         # active | superseded | deprecated
updated: 2026-08-31    # YYYY-MM-DD
last_ingested_from: docs/design/foo.md, packages/daemon/src/bar.ts
related_pages: [slug-a, slug-b]
---
```

- **`last_ingested_from` 은 필수다.** 이 페이지가 무엇에서 파생됐는지가 없으면 스테일 판정이 불가능하다 — 원본이 바뀌었는데 페이지가 그대로인 상황을 아무도 못 본다.
- **`related_pages` 는 2개 이상.** 고아 페이지는 인덱스에서만 닿을 수 있고, 인덱스를 안 거친 에이전트에게는 없는 것과 같다.
- `status: superseded` 인 페이지는 **지우지 않는다.** 본문 첫 줄에 후속 페이지 링크를 남긴다 — 옛 결정을 다시 꺼내는 것을 막는 게 이 계층의 일이다.

## 3. 인덱스 규칙 (R4)

`index.md` 는 **앵커 카탈로그**다. 항목 형식은 고정:

```markdown
### [[concepts/<slug>]] {#<slug>}

한 줄 설명.
```

- 슬러그는 파일 stem 과 **정확히** 같다. 인덱스가 파일을 못 찾으면 깨진 backlink 로 센다.
- 인덱스는 목록이지 요약이 아니다. 한 줄을 넘기면 그 내용은 페이지 본문으로 간다.

## 4. PURPOSE 교차 참조

`PURPOSE.md` 본문(Goals · Key Questions · Scope · Thesis)의 `[[slug]]` 는 **`concepts/` 의 파일 stem 하고만** 매칭된다 — 킷의 `purpose_ingest.cross_reference_validate` 가 그렇게 구현돼 있다. `[[slug|표시명]]` 형태를 쓰면 앞쪽이 슬러그다.

`entities/`·`decisions/` 는 이 매칭 대상이 아니므로, PURPOSE 에서 가리키고 싶은 개념은 반드시 `concepts/` 에 둔다.

## 5. 갱신 규칙

1. **실측이 바뀌면 페이지가 먼저 바뀐다.** 하네스 버전을 올리고 재실측했다면 `updated` 와 본문을 같이 고친다. handoff 에만 쓰고 위키를 두면 다음 세션이 옛 수치를 믿는다.
2. **결정이 뒤집히면 새 페이지가 아니라 기존 페이지의 개정이다** — 단, 옛 결정의 근거가 여전히 참조 가치가 있으면 `status: superseded` 로 남기고 새 페이지를 만든다.
3. **`log.md` 는 append-only.** ingest / query / lint 이벤트를 한 줄씩. 편집 금지.
4. 페이지를 추가하면 **같은 커밋에서** `index.md` 앵커와 `related_pages` 양방향을 채운다.

## 6. 이 계층에 넣지 않는 것

- 코드가 이미 말하는 것 (구조·시그니처) — 페이지는 **왜**를 담고 코드를 가리킨다
- 세션 진행 상황 (→ `memory/active/<branch>/`)
- 아직 결정 안 된 사항 (→ 설계서의 §미해결)
- 원 문서를 그대로 복사한 내용 — 링크로 대체한다. 복사본은 반드시 갈라진다
