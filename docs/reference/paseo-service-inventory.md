<!-- standard-ai-workflow-kit: v1.4.0 -->

# Paseo 서비스 구성 전수 분석 및 도입 계획

- 문서 목적: 레퍼런스 프로젝트 paseo 의 **서비스(기능) 구성을 도메인 단위로 전수 조사**하고, custom-harness 현재 구현과 대조해 **무엇을 어떤 순서로 가져올지**를 결정 가능한 형태로 제시한다.
- 범위: paseo 사용자 기능 표면 전체(데몬 서비스·클라이언트 화면·CLI·확장·운영). 아키텍처 수준 분석은 [paseo-analysis.md](./paseo-analysis.md) 가 담당하며 이 문서는 그 위의 **기능 축** 분석이다.
- 대상 독자: 유지보수자, 설계자, AI agent
- 분석 대상: `~/repos/paseo` (v0.5.2, AGPL-3.0-or-later) — 저장소 루트 기준 상대경로로 근거 표기
- 상태: approved (2026-08-30 사용자 승인 — A→B→C 순차, 즉시 착수. 로드맵 M5~M7 로 반영)
- 최종 수정일: 2026-08-30
- 관련 문서: [paseo-analysis.md](./paseo-analysis.md), [CONCEPT](../CONCEPT.md), [PURPOSE](../../ai-workflow/memory/active/PURPOSE.md), [ROADMAP](../ROADMAP.md)

## 0. 결론 요약

**우리가 지금 만든 것은 paseo 서비스 구성의 "세션 축 1개"다.** paseo 는 세션(에이전트) 축 위에
**프로젝트/워크스페이스 축**, **작업 공간 축(터미널·파일·diff·브라우저)**, **자동화 축(스케줄·서브에이전트·역방향 툴)**,
**확장 축(스킬·MCP·플러그인)** 4개를 더 쌓아 올린 제품이다. 우리 렌더러의 "탭"이 세션 전용인 반면
paseo 의 탭은 13종 타깃을 갖는다는 차이가 이 구조 격차를 그대로 보여준다.

| 축 | paseo | custom-harness 현재 | 격차 |
|---|---|---|---|
| 세션(에이전트) | 7 프로바이더, 서브에이전트, 승인·모드·모델·기능 토글, 히스토리 검색 | 3 하네스, 승인·모델·중단·재개 | **중간** (핵심은 있음) |
| 프로젝트/워크스페이스 | 프로젝트 자동 탐지 → 워크스페이스(worktree 격리) → 세션 3계층 | 없음 (세션 + cwd 문자열) | **전무** |
| 작업 공간 | 터미널·파일 탐색기·에디터·working/commit diff·PR·인앱 브라우저 | 대화 뷰만 | **전무** |
| 자동화 | cron 스케줄·heartbeat·역방향 MCP 툴 36종·에이전트가 에이전트 생성 | 없음 | **전무** |
| 확장 | 스킬 동기화·MCP 정/역방향·플러그인 SDK(7 확장점) | mcpServers 필드만 (주입 경로 미완) | **거의 전무** |
| 운영 | doctor·logs·업데이트 채널·마이그레이션·푸시 알림·멀티 호스트 | doctor·logs·트레이 알림 | **부분** |

도입 판정 결과: **전면 도입 7개 도메인 / 축소 도입 6개 / 보류 4개 / 제외 5개** (§4).

---

## 1. paseo 서비스 구성 — 도메인 전수

각 도메인은 `구성 요소 → 근거 경로 → 우리 현황` 순으로 기술한다.

### 1.1 프로젝트 · 워크스페이스 · 세션 3계층 모델

paseo 제품 구조의 뼈대. **"프로젝트가 워크스페이스를 담고, 워크스페이스가 세션을 담는다."**

- **프로젝트**: 파일시스템에서 자동 탐지, git remote 로 태깅, 사이드바에서 그룹핑. 식별자는 불투명 `prj_<16 hex>`, 경로는 `path.resolve` 로만 정규화(`realpath` 금지 — 심링크 동일시 방지). 호스트 횡단 동일 프로젝트 묶음용 `projectKey`(정규화된 git remote) 별도 보유.
- **워크스페이스**: 프로젝트의 체크아웃 1개 = 작업 단위. 기본 워크스페이스는 메인 체크아웃, 추가 워크스페이스는 **git worktree 격리 사본**. `cwd`(실행 디렉토리)와 `worktreeRoot`(백킹 체크아웃 루트)를 의도적으로 분리 — worktree 안의 하위 프로젝트를 정확히 가리키기 위함.
- **라벨**: 호스트 로컬 공용 라벨 카탈로그 + 워크스페이스 할당, 트랜잭션 파일로 복구 가능한 복합 커밋.
- **아카이브**: 소프트 삭제. 워크스페이스 아카이브는 정확한 `cwd` 에서 teardown 을 돌리고, 마지막 활성 참조가 사라진 뒤에야 `worktreeRoot` 를 제거.
- **정합화(reconciliation)**: 활성 프로젝트 루트를 감시해 git 파생 메타데이터(kind·branch)만 갱신하고 `projectId`/`cwd`/`displayName`/`baseBranch` 는 절대 바꾸지 않는다 — **식별자와 가변 메타데이터의 분리**가 명시적 계약.
- 근거: `docs/data-model.md`, `packages/server/src/server/workspace-registry*.ts`, `workspace-reconciliation-service.ts`, `workspace-archive-service.ts`, `project-directory-service.ts`, `workspace-labels/`
- **우리 현황**: 없음. 세션 생성 시 `cwd` 문자열만 받고 최근 목록을 렌더러 localStorage 에 둔다. 프로젝트·워크스페이스 개념 자체가 부재.

### 1.2 Git worktree 워크스페이스와 `paseo.json`

- worktree 백킹 워크스페이스 생성: 새 브랜치 분기 / 기존 브랜치 체크아웃 / **PR 체크아웃**(gh CLI 사용).
- 저장소 루트의 `paseo.json` 을 **베이스 브랜치의 커밋된 버전에서** 읽는다(다른 브랜치의 미커밋 변경이 새 나가지 않게).
- `worktree.setup` / `worktree.teardown`: 생성 직후 / 아카이브 직전 실행. 멀티라인 셸 또는 명령 배열, 순차 실행. `cwd` 는 worktree, `$PASEO_SOURCE_CHECKOUT_PATH` 로 원본 체크아웃의 미추적 파일(.env 등) 접근.
- 브랜치 자동 이름 생성기(`worktree-branch-name-generator.ts`), worktree 복구(`mainRepoRoot` 로부터 재생성 후 상대경로 복원).
- 근거: `public-docs/worktrees.md`, `packages/server/src/server/worktree/`, `worktree-core.ts`, `paseo-worktree-service.ts`, `resolve-worktree-creation-intent.ts`
- **우리 현황**: 없음.

### 1.3 워크스페이스 스크립트 · 서비스 · 리버스 프록시

- `paseo.json` 의 `scripts`: 이름 붙은 명령. `type: "service"` 로 표시하면 **장기 실행 프로세스로 감독**되고 포트를 배정받으며 데몬의 리버스 프록시로 HTTP 트래픽이 라우팅된다.
- **동적 포트 배정**: 기본은 OS ephemeral, 전역(`config.json`) 또는 프로젝트(`paseo.json`)에서 `range` 지정, 외부 할당기 `portScript`(인자 4개: 서비스명·워크스페이스 ID·브랜치·worktree 경로, stdout 에 포트 1개) 지원. 프로세스는 `$PASEO_PORT` 에 바인딩 — worktree 마다 다른 포트라 같은 서비스의 사본이 공존.
- **결정적 호스트네임**으로 데몬을 통해 서비스 접근(브랜치 라벨 포함, 기본 브랜치면 생략), service-to-service 통신도 동일 경로.
- 스크립트 상태 투영·헬스 모니터·감독 터미널 위에서의 start/stop.
- 근거: `public-docs/worktrees.md`, `service-proxy.ts`, `script-proxy.ts`, `script-health-monitor.ts`, `script-status-projection.ts`, `workspace-service-port-allocator.ts`, `workspace-service-port-registry.ts`, `workspace-script-runtime-store.ts`, `docs/service-proxy.md`
- **우리 현황**: 없음.

### 1.4 터미널

- `node-pty` + `@xterm/headless` 기반 데몬 소유 터미널 세션. **같은 WebSocket 에 바이너리 프레임을 혼재**해 전송하고, 터미널 ID 를 1바이트 slot 으로 다중화(`[opcode(1B)][slot(1B)][payload]`).
- 복원 모드(`terminal-restore-modes`), 입력 모드 리플레이, 크기 소유권(`terminal-size-ownership`) 등 재접속 의미론을 feature 플래그로 협상.
- 터미널 프로필 설정 UI, 워크스페이스 탭으로서의 터미널.
- **터미널 활동 훅**: 사용자가 터미널에서 *직접* 띄운 Claude/Codex/OpenCode CLI 를 각 CLI 훅 설정에 paseo 훅을 설치해 감지(`POST /api/terminal-activity`) — 앱 밖에서 시작한 작업도 UI 에 나타난다.
- 근거: `packages/server/src/server/websocket/`, `terminal-activity-route.ts`, `terminal/agent-hooks/`, `docs/terminal-performance.md`, `docs/terminal-activity.md`
- **우리 현황**: 없음.

### 1.5 파일 · 에디터 · 디렉토리 동기화

- 파일 탐색기(`file-explorer`), 파일 감시(`file-observer`), 업로드/다운로드(바이너리 프레임 opcode `0x10~0x12`), 파일 탭·working diff 탭·commit diff 탭.
- **디렉토리 동기화**: 커서/tombstone 리컨실 + 오프라인 replica 캐시로 대용량 트리를 증분 동기화. SDK 가 아니라 **앱 계층 소유**.
- 어시스턴트 응답 안의 파일 경로를 클릭 가능한 링크로(`assistant-file-links/`), 외부 에디터로 열기 버튼.
- 근거: `file-explorer/`, `file-observer/`, `file-upload/`, `file-download/`, `directory-sync/`, `docs/file-observation.md`
- **우리 현황**: 없음. 툴 카드가 파일 경로를 텍스트로 보여줄 뿐.

### 1.6 Git · 체크아웃 diff · Forge(PR) 통합

- **checkout diff 매니저**: 워크스페이스의 working diff 를 구독형으로 스트리밍(재연결 시 자동 복원되는 구독 대상 중 하나).
- 워크스페이스 git 서비스: 메타데이터 관측·fetch·이벤트 규칙(`git-metadata-event-rules.ts`), 브랜치/PR 상태.
- **Forge 프로바이더 추상화**(GitHub/GitLab 등): PR 탭, 체크 상세 조회, auto-merge 설정, forge 검색. 병합 시 워크스페이스 자동 아카이브(`auto-archive-on-merge/`).
- 근거: `checkout/`, `checkout-diff-manager.ts`, `workspace-git-service.ts`, `docs/forge-providers.md`, `auto-archive-on-merge/`
- **우리 현황**: 없음.

### 1.7 에이전트 오케스트레이션 (자동화 축)

- **역방향 툴 표면**: 데몬이 스스로 MCP 서버(`/mcp/agents`)가 되어 에이전트에게 36종+ 툴을 노출 — 에이전트 10종(create/send/status/list/cancel/archive/kill/update/activity/set_mode), 워크스페이스 4종, 워크스페이스 스크립트 3종, 터미널 5종(create/list/kill/capture/send_keys), 스케줄·heartbeat 11종, 프로바이더 3종. 정본은 `PaseoToolCatalog` 이고 MCP 는 **폴백 어댑터**(네이티브 등록 지원 하네스는 직접 등록).
- **paseo 서브에이전트 vs 프로바이더 네이티브 서브에이전트**: 전자는 완전 대화형 1급 세션(탭으로 열림), 후자는 읽기 전용 트랙. UI 는 컴포저 위 플로팅 pill 바로 표현.
- **heartbeat**: 현재 에이전트에 cron 기반 반복 프롬프트를 꽂아 "계속 일하게" 유지.
- **wait_for_agent** 로 A→B 팬아웃·조인을 CLI/스크립트에서 조립.
- 근거: `agent/tools/paseo-tools.ts`, `public-docs/mcp.md`, `public-docs/orchestration.md`, `docs/agent-lifecycle.md`
- **우리 현황**: 없음. PURPOSE 의 "크로스 하네스 중복 실행 오케스트레이션 제외"와는 **다른 축**임에 주의 — 제외한 것은 같은 작업을 여러 하네스에 중복 실행하는 것이고, 여기서의 오케스트레이션은 위임·팬아웃이다.

### 1.8 스케줄

- cron 트리거로 **매 실행마다 새 에이전트**를 시작. 앱/CLI/MCP 3경로에서 생성.
- 실행 이력·로그 조회, 일시정지/재개, 한도(limits), 즉시 1회 실행, 삭제. `$PASEO_HOME/schedules/{id}.json` 1파일 1스케줄.
- 근거: `schedule/`, `schedule-run-lifecycle.e2e.test.ts`, `public-docs/schedules.md`, `public-docs/schedules-chat.md`, `public-docs/schedules-cli.md`
- **우리 현황**: 없음.

### 1.9 확장 3축 — 스킬 / MCP / 플러그인

paseo 의 명시적 설계 결정: **스킬 = 하네스에게 주는 것(파일 동기화), MCP = 하네스와 주고받는 것(정방향 주입 + 역방향 폴백 툴), 플러그인 = paseo 자신을 바꾸는 것.**

- **스킬**: 저장소 `skills/` 의 번들(SKILL.md)을 빌드 시 데몬 dist 로 복사 → 런타임에 각 하네스의 스킬 디렉토리(`~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`)로 설치·동기화. 중단된 설치 트랜잭션 복구 포함. 선택 상태는 데몬 config, RPC 5종 + `skillManagement` feature 플래그.
- **MCP 정방향**: `AgentSessionConfig.mcpServers`(stdio|http|sse 판별 유니온) → 어댑터가 하네스 네이티브 형식으로 변환, `supportsMcpServers` 로 협상, 일부만 `supportsExactMcpPreapproval`(툴 사전 승인).
- **플러그인**: SDK 확장점 7종(서버 RPC 핸들러, 전역 서피스, 사이드바 항목, 워크스페이스/에이전트 패널, ⌘K 항목, 컴포저 첨부 소스, 테마). `*.client.tsx`/`*.server.ts`/`*.shared.ts` **파일명 기반 런타임 경계**를 자체 컴파일러(Babel AST + esbuild)가 강제, 서버 플러그인은 `fork` 서브프로세스 격리. 보안 모델은 샌드박스가 아니라 **신뢰된 코드**(루트 `pluginsEnabled` 플래그).
- 근거: `orchestration-skills/`, `plugins/`, `packages/plugin/`, `public-docs/skills.md`, `public-docs/plugins/`, `docs/plugins.md`
- **우리 현황**: `session.create` 에 `mcpServers` 필드는 있으나 하네스 주입 경로 미완(pi 0.84.1 은 `--mcp-config` 부재로 `mcpInjection=false`). 스킬·플러그인은 없음. PURPOSE 에 "(후순위) 조직 공용 스킬/MCP 세트 공유"로 이미 범위에 있음.

### 1.10 주의(attention) 정책 · 알림

- 에이전트 레코드에 `requiresAttention` / `attentionReason`(`finished`|`error`|`permission`) / `attentionTimestamp` 를 **영속 필드로** 보유 — 주의 상태가 UI 파생값이 아니라 1급 데이터.
- 전용 정책 모듈(`agent-attention-policy.ts`)이 이벤트에서 주의 상태를 계산, 사이드바 버킷·푸시 알림·자동 승인(unattended)까지 하나의 파이프라인.
- Expo 푸시 토큰 저장(`push-tokens.json`)과 토큰 폐기(`pushTokenRevocation`).
- 근거: `agent-attention-policy.ts`, `push/`, `websocket-server.notifications.test.ts`
- **우리 현황**: 렌더러 로컬 상태의 사이드바 버킷 + Notification API + 자동 승인 opt-in. **데몬 측 영속 주의 상태는 없음**.

### 1.11 멀티 호스트 · 원격 접속 · 웹 UI

- **호스트 다중화**: 라우트가 `/h/[serverId]/...` 로 데몬 스코프, 여러 데몬 동시 연결(`HostRuntimeStore`), ⌘K 로 호스트 횡단 검색. `hub/` 는 호스트/아이덴티티 묶음.
- **릴레이**: 제로지식 E2EE 바이트 파이프(Curve25519 + XSalsa20-Poly1305), 데몬이 아웃바운드로 붙으므로 포트 개방 불필요. 공개키는 QR/페어링 링크(URL 프래그먼트)로 대역 외 전달.
- **웹 UI 셀프호스팅**: 데몬이 브라우저 앱을 직접 서빙(`web-ui.ts`), 리버스 프록시·TLS·터널 가이드, DNS 리바인딩 방지·origin 검사·패스워드 인증.
- Docker 이미지(에이전트 CLI 의도적 미포함), Nix, Tailscale 토폴로지.
- 근거: `relay-runtime.ts`, `relay-transport.ts`, `pairing-qr.ts`, `daemon-keypair.ts`, `web-ui.ts`, `auth.ts`, `websocket-server.origin.test.ts`, `hub/`, `public-docs/security.md`, `public-docs/connectivity.md`
- **우리 현황**: 127.0.0.1 + 토큰 2중 인증 단일 데몬. 원격·멀티 호스트 없음(설계상 데몬 분리로 문만 열어둠).

### 1.12 음성

- 딕테이션(STT → 컴포저)과 보이스 에이전트(실시간 대화) 2모드. 서버 측 로컬 STT/TTS 는 sherpa-onnx 모델(parakeet 계열, 영어 전용/25개 유럽어), OpenAI 옵션 별도. AEC 때문에 자체 네이티브 모듈(`expo-two-way-audio`) vendoring.
- 근거: `speech/`, `dictation/`, `voice-*.ts`, `public-docs/voice.md`
- **우리 현황**: 없음.

### 1.13 인앱 브라우저 · 브라우저 툴

- 워크스페이스 탭으로서의 브라우저 + 에이전트가 페이지를 보고 조작하는 툴 표면. 데스크톱 전용, 설정에서 명시적 활성화.
- 근거: `browser-tools/`, `public-docs/browser.md`, `public-docs/browser-tools.md`, `docs/browser-capture-harness.md`
- **우리 현황**: 없음.

### 1.14 검색 · 커맨드 센터

- 에이전트 히스토리 검색(`agent-history-search.ts`), ⌘K 커맨드 팔레트(호스트 횡단, 플러그인이 항목 주입 가능), forge 검색.
- **우리 현황**: 없음.

### 1.15 메타데이터 자동 생성

- 에이전트 제목·워크스페이스 이름 등을 모델로 생성. **모델 선택 규칙**과 커스텀 폴백 순서, 프로젝트별 지시문을 설정으로 노출.
- 근거: `public-docs/metadata-generation.md`, `workspace-auto-name.ts`, `session.create-agent-title.test.ts`
- **우리 현황**: 없음(세션 제목은 사용자 입력/기본값).

### 1.16 설정 체계

- `$PASEO_HOME/config.json` 단일 파일 + 명확한 **우선순위 규칙**(env > config > 기본값)과 **핫 리로드**(`daemonConfigReload`).
- 설정 화면 구성: 호스트(데몬)·프로바이더·에디터·키보드 단축키·터미널 프로필·외관(테마)·브라우저 툴·플러그인·메타데이터 생성·스킬.
- 프로바이더 파생 생성(`extends`)도 설정 파일로 — 코드 없는 확장.
- 근거: `config.ts`, `persisted-config.ts`, `daemon-config-store.ts`, `public-docs/configuration.md`, `packages/app/src/screens/settings/`
- **우리 현황**: `settings.json` + 설정 화면 3섹션(게이트웨이·API 키·하네스 상태·알림/승인). 우선순위·핫 리로드 규칙 미정의.

### 1.17 CLI

- 18개 명령 그룹: `agent`, `clone`, `daemon`, `heartbeat`, `hooks`, `hub`, `onboard`, `open`, `permit`, `plugin`, `project`, `provider`, `schedule`, `script`, `speech`, `terminal`, `workspace`, `worktree`.
- Docker 스타일 상위 동사: `paseo run/ls/attach/send/logs/stop`. 출력 포맷 옵션(JSON 등)으로 스크립팅 가능 — **CLI 가 자동화 1급 경로**.
- 근거: `packages/cli/src/commands/`, `public-docs/cli.md`
- **우리 현황**: `daemon start/stop/status`, `version`, `doctor`, `logs` 6종. 세션 조작 명령 없음.

### 1.18 운영 · 배포 · 진단

- 업데이트 채널(stable/beta), 단계적 롤아웃, electron-builder / npm 7종 / Docker / Nix 4경로 배포.
- 마이그레이션(`migrations/`), 페이지네이션(`pagination/`), 프로세스 진단(`process-diagnostics.ts`), 관리 프로세스 원장(`managed-processes/`, 부팅 시 `reapStale`), PID 락, 워처 생존 카나리(`watcher-liveness-canary.ts`), 로거.
- 근거: `public-docs/updates.md`, `public-docs/troubleshooting.md`, `migrations/`, `managed-processes/`
- **우리 현황**: PID 원장·reapStale·doctor·logs 는 있음. 업데이트/롤백은 M3 3.1 로 계획됨. 마이그레이션 프레임 없음(paseo 도 없음 — optional 필드로 전방 호환).

---

## 2. 갭 대조 한눈표

| # | 도메인 | paseo | 우리 | 판정 |
|---|---|---|---|---|
| 1.1 | 프로젝트·워크스페이스 3계층 | ✅ | ❌ | **전면 도입** |
| 1.2 | worktree 워크스페이스 + `paseo.json` | ✅ | ❌ | **전면 도입** |
| 1.3 | 워크스페이스 스크립트·서비스·프록시 | ✅ | ❌ | 축소 도입(스크립트만) |
| 1.4 | 터미널 | ✅ | ❌ | **전면 도입** |
| 1.5 | 파일 탐색·업로드·디렉토리 동기화 | ✅ | ❌ | 축소 도입(읽기·탐색) |
| 1.6 | git diff · Forge/PR | ✅ | ❌ | 축소 도입(diff 우선, forge 는 사내 호스팅 확인 후) |
| 1.7 | 오케스트레이션(역방향 툴·서브에이전트) | ✅ | ❌ | **전면 도입**(단계적) |
| 1.8 | 스케줄 | ✅ | ❌ | 보류 |
| 1.9 | 스킬 / MCP / 플러그인 | ✅ | 부분 | 스킬·MCP 도입, 플러그인 보류 |
| 1.10 | 주의 정책·알림 | ✅ | 부분 | **전면 도입**(데몬 이관) |
| 1.11 | 멀티 호스트·릴레이·웹 UI | ✅ | ❌ | 릴레이 제외 / 멀티 호스트 보류 / 웹 UI 보류 |
| 1.12 | 음성 | ✅ | ❌ | 제외 |
| 1.13 | 인앱 브라우저·브라우저 툴 | ✅ | ❌ | 제외(폐쇄망 가치 낮음) |
| 1.14 | 검색·커맨드 센터 | ✅ | ❌ | **전면 도입**(경량) |
| 1.15 | 메타데이터 자동 생성 | ✅ | ❌ | 축소 도입(세션 제목) |
| 1.16 | 설정 우선순위·핫 리로드 | ✅ | 부분 | **전면 도입** |
| 1.17 | CLI 자동화 표면 | 18 그룹 | 6 명령 | 축소 도입 |
| 1.18 | 업데이트·운영·진단 | ✅ | 부분 | 기존 M3 3.1 로 흡수 |

---

## 3. 도입 판정 기준 (왜 빼는가)

1. **폐쇄망 전제** — 외부 CDN·클라우드 의존 기능은 성립하지 않는다(음성 모델 다운로드, 릴레이 서비스, 업데이트 서버는 사내 저장소로 치환되어야 함 → C-2 선행).
2. **PURPOSE 제외 영역 준수** — 모바일 클라이언트, 멀티테넌트·서비스화, 외부 배포 패키징은 범위 밖. 릴레이·푸시(Expo)·웹 UI 호스팅은 이 축에 걸린다.
3. **토큰 제약** — 자동 메타데이터 생성·요약처럼 LLM 호출을 늘리는 기능은 **기본 off + 명시적 opt-in** 으로만 도입.
4. **AGPL 경계** — §6 참조. 개념·계약은 차용하되 **코드는 복제하지 않는다**.
5. **하네스 편차 흡수** — paseo 기능 중 상당수는 프로바이더 네이티브 기능(rewind, steering, 네이티브 서브에이전트)에 의존한다. 우리 1차 하네스(pi/omp/grok)에 없는 기능은 capability 플래그로 숨기는 것이 원칙(폴백 경로 금지).

---

## 4. 도입 계획 (2026-08-30 승인)

로드맵에 **M5~M7 3개 마일스톤**을 신설했다(M4 는 기존 "확장" 트랙이 선점). 각 웨이브는 앞 웨이브의 데이터 모델에 의존하며, **A→B→C 순차·즉시 착수**로 승인됐다.

### 웨이브 A — 작업 단위 모델 (M5 "워크스페이스" · [계획](../roadmap/m5-workspace.md) · [FR-7](../requirements/fr7-workspaces.md))

이것이 없으면 나머지가 전부 세션 옆에 매달린 부속물이 된다. **최우선.**

| WBS | 내용 | 근거 도메인 |
|---|---|---|
| 5.2 | 프로젝트 레지스트리(자동 탐지·불투명 ID·정합화 계약) | 1.1 |
| 5.3 | 워크스페이스 레지스트리(`cwd`/`checkoutRoot` 분리·아카이브·라벨) | 1.1 |
| 5.4 | 세션의 워크스페이스 귀속(`workspaceId` 1급화, cwd 추론 금지) | 1.1 |
| 5.5 | worktree 백킹 워크스페이스(분기/체크아웃/복구) + 프로젝트 설정 파일 setup/teardown | 1.2, 1.3 |
| 5.6 | 사이드바 정보구조 재편(프로젝트 → 워크스페이스 → 세션) | 1.1 |
| 5.7 | 정합화 불변식·worktree 수명주기 e2e·회귀 | 1.1, 1.2 |

### 웨이브 B — 작업 공간 (M6 "캔버스" · [계획](../roadmap/m6-canvas.md) · [FR-8](../requirements/fr8-workbench.md))

| WBS | 내용 | 근거 도메인 |
|---|---|---|
| 6.2 | 탭 타깃 일반화(세션 전용 → 다형 타깃) + 분할 페인 확장 | 1.1, 1.5 |
| 6.3 | 터미널(데몬 pty·바이너리 프레임 슬롯 다중화·복원 의미론) | 1.4 |
| 6.4 | 파일 탐색·파일 탭·경로 링크(읽기 우선) | 1.5 |
| 6.5 | working diff / commit diff 뷰 + 구독 복원 | 1.6 |
| 6.6 | 워크스페이스 스크립트 실행(감독 터미널 위, 서비스·프록시는 후순위) | 1.3 |

### 웨이브 C — 자동화·확장 (M7 "오케스트레이션" · [계획](../roadmap/m7-orchestration.md) · [FR-9](../requirements/fr9-orchestration.md))

| WBS | 내용 | 근거 도메인 |
|---|---|---|
| 7.1 | 데몬 주의(attention) 상태 1급화 + 알림 파이프라인 이관 | 1.10 |
| 7.2 | 역방향 툴 카탈로그(정본) + MCP 서버 노출(폴백 어댑터 구조) | 1.7, 1.9 |
| 7.3 | 서브에이전트 위임(팬아웃·조인, 트랙 UI) | 1.7 |
| 7.4 | 히스토리 검색 + 커맨드 팔레트 | 1.14 |
| 7.5 | CLI 자동화 표면 확장(session/workspace 계열) | 1.17 |
| 7.6 | 세션 제목 자동 생성(비 LLM 기본) | 1.15 |
| (M4 T1) | 조직 공용 스킬 동기화·MCP 정본 번들 — **기존 M4 확장 트랙이 담당**, 중복 정의하지 않는다 | 1.9 |

### 웨이브와 무관하게 즉시 흡수할 것 (M5 WP 5.0 으로 편입)

- **설정 우선순위·핫 리로드 규칙 정의**(1.16) — 지금 정하지 않으면 뒤에서 전부 재작업.
- **세션 레코드에 `requiresAttention`/`archivedAt`/`labels` 필드 선반영**(1.1, 1.10) — additive 라 지금이 가장 싸다.
- **`workspaceId` 자리만 미리 확보**(1.1) — 나중에 넣으면 마이그레이션이 필요해진다.

### 보류 / 제외

- 보류: 스케줄(1.8), 플러그인 SDK(1.9), 멀티 호스트·웹 UI 호스팅(1.11), 서비스 리버스 프록시(1.3)
- 제외: 음성(1.12), 인앱 브라우저·브라우저 툴(1.13), 릴레이 E2EE·페어링 QR·푸시(1.11), 모바일(PURPOSE 제외), Docker/Nix 배포(외부 배포 범위 밖)

---

## 5. 가져오는 방법 (실행 규칙)

1. **문서·계약 우선 참조**: paseo 의 `docs/`·`public-docs/` 는 계약을 산문으로 기술한다. 구현 파일보다 이쪽을 먼저 읽고, 우리 설계서에 **우리 언어로 다시 쓴다**.
2. **코드 복제 금지(§6)**. 파일·함수·타입 정의를 그대로 옮기지 않는다. 차용하는 것은 *구조적 결정*(3계층 모델, 식별자/메타데이터 분리, 폴백 금지 원칙, 정본+폴백 어댑터 패턴)이다.
3. **우리 프로토콜 규약 유지**: 신규 RPC 는 `domain.namespace.verb`, 신규 필드는 optional, 와이어 버전 고정 + capability/feature 플래그로 진화. 이건 이미 우리 `protocol-design` 이 채택한 전략이라 그대로 확장하면 된다.
4. **도메인마다 설계서 1개**: 웨이브 A~C 각 마일스톤 착수 전에 `docs/design/` 에 설계서를 만들고 승인받는다(M0 절차와 동일).
5. **하네스 편차는 capability 로**: 새 기능이 하네스 네이티브 기능을 요구하면 플래그를 추가하고 미지원 하네스에서는 UI 를 숨긴다.

## 6. 라이선스 경계 (필수 확인)

paseo 는 **AGPL-3.0-or-later** 다. 사내 전용 도구라도 다음을 지켜야 한다.

- **아이디어·아키텍처·프로토콜 설계는 저작권 대상이 아니다** — 분석해 우리 언어로 재구현하는 것은 문제 없다.
- **소스 코드·주석·문서 텍스트의 복제/파생은 AGPL 의무를 발생시킨다.** 우리 저장소에 paseo 코드 스니펫을 붙여넣지 않는다.
- 이미 M3 3.3.2 에 **clean-room 검수** 항목이 있다. 이 문서를 근거로 그 검수 범위를 "paseo 유래 코드 부재 확인"까지 확장할 것을 제안한다.
- 판단이 애매한 경우(예: `paseo.json` 스키마 키 이름을 그대로 쓸지)는 **사내 법무 확인(C-6 신설 후보)** 대상으로 올린다.

## 7. 미해결 질문

- **Q-A**: 워크스페이스 격리를 git worktree 로 갈 것인가, 단순 디렉토리 선택으로 갈 것인가? (사내 저장소 정책·디스크 여유에 좌우 — C-2 와 연동)
- **Q-B**: 역방향 툴 표면을 MCP 로 낼 것인가? 1차 하네스 3종의 MCP 지원 실측이 필요하다(pi 0.84.1 은 미지원 확인됨, omp/grok 미실측).
- **Q-C**: 터미널을 데몬이 소유하면 폐쇄망 감사 관점에서 셸 실행 경로가 하나 더 생긴다 — 보안 검토 필요 항목인가?
- ~~**Q-D**: 웨이브 A~C 를 M1/M2 완료 선언 전에 착수할 것인가?~~ → 2026-08-30 해소: **즉시 착수**(사내 협조 대기와 독립이라 병행)
