<!-- standard-ai-workflow-kit: v1.7.0 -->

# Master Knowledge Index

- 문서 목적: `ai-workflow/wiki/` 의 **앵커 카탈로그**(R4). AI agent 가 질의 시 가장 먼저 읽는 진입점.
- 갱신 규칙: 페이지를 추가하면 **같은 커밋에서** 여기에 한 줄을 추가한다. 형식은 [SCHEMA §3](./SCHEMA.md).
- 최종 수정일: 2026-08-31

> **읽는 순서 제안** — 이 프로젝트가 처음이면 [[concepts/harness-wrapping]] → [[concepts/closed-network-self-containment]] → [[concepts/zero-config-bundle]] 셋이 나머지 전부의 전제다.
> 무엇이 막혀 있는지부터 알고 싶으면 [[queries/what-blocks-milestone-completion]].

## Concepts

### [[concepts/harness-wrapping]] {#harness-wrapping}

에이전트 루프는 하네스가 소유하고 우리는 실행·상태·UI 를 소유한다 — 1번 경계선.

### [[concepts/closed-network-self-containment]] {#closed-network-self-containment}

NFR-1. 허용 목적지는 게이트웨이·내부 저장소·localhost 뿐이고 목표치는 "적게"가 아니라 0.

### [[concepts/zero-config-bundle]] {#zero-config-bundle}

하네스 동봉 + 설정 주입 = 설치 즉시 사용. 폐쇄망에서는 편의가 아니라 성립 조건.

### [[concepts/credential-injection]] {#credential-injection}

게이트웨이 키 저장과 하네스별 설정 주입 — 격리·env 우선, 파일 주입은 최후 수단.

### [[concepts/home-isolation]] {#home-isolation}

하네스별 빈 `HOME` + allowlist 반입. 외부 유래 MCP 툴 40개 → 0.

### [[concepts/attention-state]] {#attention-state}

"지금 봐야 할 세션"을 데몬이 정본으로 계산하고 영속한다.

### [[concepts/reverse-tools]] {#reverse-tools}

데몬 기능을 하네스에게 되돌려 노출하는 툴 10종 — 세션 위임의 표면.

### [[concepts/workspace-three-layer]] {#workspace-three-layer}

프로젝트 → 워크스페이스 → 세션. 식별자는 불변, 경로는 lexical 정규화만.

### [[concepts/workbench-canvas]] {#workbench-canvas}

탭이 세션·터미널·파일·diff 를 담는 작업 캔버스. 탭은 보는 것이지 소유하는 것이 아니다.

## Entities

### [[entities/daemon]] {#daemon}

정본이 사는 곳 — 프로세스·타임라인·레지스트리·pty·주의 상태.

### [[entities/gateway]] {#gateway}

사내 OpenAI 호환 LLM 게이트웨이. **아직 실물로 측정하지 못했다**(C-1).

### [[entities/harness-pi]] {#harness-pi}

pi 0.84.1 · MIT · JSONL RPC · MCP 는 설계상 배제, 확장 API 가 대체 경로.

### [[entities/harness-omp]] {#harness-omp}

omp 17.3.8 · MIT · pi 포크 · MCP 네이티브지만 기본값에서 은닉·비동기 로딩.

### [[entities/harness-grok]] {#harness-grok}

grok build 1.0.13 · Apache 2.0 · ACP · MCP 는 `search_tool`→`use_tool` 메타 툴 경유.

## Decisions

### [[decisions/open-source-first-harnesses]] {#open-source-first-harnesses}

2026-08-24 — 재배포 라이선스와 Chat Completions 직결, 두 필터가 같은 3종을 남겼다.

### [[decisions/grok-acp-path]] {#grok-acp-path}

2026-08-25 — 승인·멀티턴·중단·MCP 주입이 전부 ACP 쪽에만 있다.

### [[decisions/binary-frames-for-terminal]] {#binary-frames-for-terminal}

2026-08-30 — 터미널은 JSON 을 지나지 않는다. M0 결정의 뒤집기가 아니라 유보 조항의 발동.

### [[decisions/tool-catalog-in-protocol]] {#tool-catalog-in-protocol}

2026-08-31 — 노출 경로가 둘이라 정의는 양쪽보다 위층에 있어야 한다.

### [[decisions/grok-permission-mode-default]] {#grok-permission-mode-default}

2026-08-31 — MCP 툴과 내장 파괴적 툴이 동시에 승인 대상인 모드는 `default` 뿐.

## Patterns

### [[patterns/measure-dont-assume]] {#measure-dont-assume}

문서·이름과 실물이 계속 달랐다. 대조군을 두고, 버전을 적고, 재실측 조건을 남긴다.

### [[patterns/deny-by-default-allowlist]] {#deny-by-default-allowlist}

빈 상태에서 시작해 필요한 것만 들인다. 실패는 안전한 쪽으로.

### [[patterns/single-policy-point]] {#single-policy-point}

같은 질문에 답하는 코드가 둘이면 반드시 갈라진다.

## Queries

### [[queries/what-blocks-milestone-completion]] {#what-blocks-milestone-completion}

M1·M2 완료 선언을 막고 있는 것 — 전부 사내 협조(C-1·C-5).

### [[queries/how-to-expose-a-tool-to-harnesses]] {#how-to-expose-a-tool-to-harnesses}

새 역방향 툴을 추가할 때의 체크리스트와 경로별 함정.

### [[queries/how-to-verify-no-external-traffic]] {#how-to-verify-no-external-traffic}

`npm run smoke:nfr1` — 그리고 감시 범위를 의심하는 법.

### [[queries/where-does-harness-config-come-from]] {#where-does-harness-config-come-from}

하네스가 이상한 설정을 물고 있을 때 확인 순서 4단계.
