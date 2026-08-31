---
type: entity
status: active
updated: 2026-08-31
last_ingested_from: docs/reference/grok-integration-paths.md, docs/reference/harness-mcp-support.md, packages/daemon/src/adapters/acp/grok.ts
related_pages: [harness-pi, harness-omp, grok-permission-mode-default]
---

# grok build (하네스)

**번들 버전 1.0.13** · Apache 2.0 · xAI 공식 터미널 코딩 CLI(Rust TUI). 2026-07 오픈소스화(`xai-org/grok-build`).

air-gapped 배포가 공식 설계에 반영돼 있어 폐쇄망 적합성이 좋다.

## 통합 — ACP 경로

`grok agent stdio` (Agent Client Protocol). headless `grok -p` + stream-json 도 가능했으나 ACP 를 채택했다(2026-08-25 승인) → [[decisions/grok-acp-path]]

| 항목 | 값 |
|---|---|
| 설정 격리 | `GROK_HOME` — 사용자 `~/.grok` 와 완전 분리 |
| 게이트웨이 주입 | `config.toml` — 커스텀 모델 + 기본 모델 고정 + `env_key` |
| 오프라인 | `[cli]` / `[features]` 3스위치 (**구조체 형식** — 1.0.5 에서 구문 재작성했다) |
| 권한 모드 | **`--permission-mode default` 항상 명시** → [[decisions/grok-permission-mode-default]] |

## ⚠ 바이너리 이름 충돌

커뮤니티 `superagent-ai/grok-cli` 등 **비공식 도구 다수가 같은 `grok` 바이너리명**을 쓴다. 어댑터는 반드시 번들 절대 경로로 실행하고 `grok --version` 으로 검증한다 — PATH 를 타면 사용자 PC 의 다른 도구가 잡힌다.

(참고: 2026-07 리포지토리 클라우드 무단 업로드 논란 이력이 있다. 민감 코드베이스 적용 시 데이터 정책 확인 필요.)

## ACP 실측으로 확정한 것들

- **`session/load` 응답 전에 리플레이가 온다** — 응답을 기다린 뒤 처리하면 놓친다
- `session/set_model` · `session/cancel` 동작 확인, SIGTERM 시 세션 저장됨
- 거부(reject)는 에러가 아니라 **턴 완결**로 처리된다
- `compaction` 은 `/compact` 슬래시 커맨드 경로뿐 — 계약 메서드가 없어 ✗ 1차

### 승인 옵션이 버전 사이에 늘었다

1.0.5 는 `allow-once`/`reject-once` **2종**뿐이었으나, 1.0.13 의 `default` 모드는 **영속 승인을 함께 노출**한다:

| 대상 | 옵션 (ACP `kind`) |
|---|---|
| MCP 툴 | `always-allow`(`allow_always`) · `allow-once` · `reject-once` |
| 파일 쓰기 | `allow-edits-session`(`allow_always`) · `allow-once` · `reject-once` |

grok 이 ACP 표준 `kind` 를 정확히 보내므로 어댑터가 영속 승인을 1회 승인으로 잘못 라벨링하지 않는다(실측 확인). 영속 승인의 UI 표기·감사 기록은 FR-1.5 후속 — 격리 `GROK_HOME` 덕에 영속 범위는 번들 데이터 안으로 한정된다.

## MCP — 네이티브, 메타 툴 경유

- **등록은 하네스 CLI 에 위임한다.** `grok mcp add <name> --scope user -e K=V -- <command...>` 가 `$GROK_HOME/config.toml` 의 `[mcp_servers.<name>]` 을 쓴다. **우리가 TOML 스키마를 추측할 필요가 없다.**
- `grok mcp doctor` 가 소스별 서버 수 + handshake + 툴 개수를 찍는다 — 온보딩·doctor(M3)에 그대로 물릴 수 있는 표면
- **노출은 항상 `search_tool` → `use_tool` 2단 메타 툴** 뒤다(`<server>__<tool>`). top-level 인라인 옵션은 없다. 세션 시작 시 시스템 리마인더로 "`use_tool` 전에 반드시 `search_tool`" 규약을 주입한다
- **그 규약을 어기면 간헐 실패한다** — 초기 재현율 약 1/3, 순서를 지키면 3/3 결정적 성공. 우리 툴 설명 문구가 이 규약을 깨지 않아야 한다

## 조달

- Windows 는 **제외**(번들 축소안: pi + omp)
- linux-x64 는 x.ai CDN(primary) / GCS(fallback) **이중 소스 sha256 교차 검증** — 공식 체크섬 미공개를 실측 확인했다. 번들 갱신마다 재수행
