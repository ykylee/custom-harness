---
type: query
status: active
updated: 2026-08-31
last_ingested_from: scripts/nfr1-smoke.mjs, docs/requirements/nfr.md, packages/daemon/src/gateway/service.ts
related_pages: [closed-network-self-containment, home-isolation, measure-dont-assume]
---

# 질문 — 외부 접속 0(NFR-1)을 어떻게 확인하나?

## 짧은 답

```bash
npm run smoke:nfr1
```

목 게이트웨이(OpenAI 호환 SSE)를 띄우고 실물 하네스로 1턴을 돌린 뒤 `lsof` 로 실제 커넥션을 판정한다. 허용 외 목적지 **0건**이어야 통과.

허용 목적지는 셋뿐: 게이트웨이 · (설정 시) 내부 아티팩트 저장소 · localhost.

## 무엇을 감시하는가 — 여기가 두 번 틀렸다

현재(v3)는 **하네스의 자손 프로세스 트리 전체**를 본다. `ps -Ao pid=,ppid=` 로 PID 원장의 pid 부터 BFS.

이전 버전들이 놓친 것:

- **v1** — pi 1턴만
- **v2** — 3하네스 + 혼합 6세션 부하로 확장
- **v3** — PID 원장의 하네스 **자신만** 보던 것을 자손 트리로. 계기는 하네스가 띄운 **MCP 서버(손자)** 가 원장에 없어 감시망 밖이었던 것 → [[concepts/home-isolation]]

**감시 범위를 의심하는 것이 이 검증의 핵심이다.** "0건 통과"는 감시 대상이 맞을 때만 의미가 있다.

## 정적 검사도 있다

기동 시 **트래픽 경계 검사**(FR-2.5) — 하네스 설정에 게이트웨이 아닌 목적지가 있으면 경고한다. M7 에서 추가된 항목:

- omp `mcp.json` 의 `mcpServers.*.url`
- grok `config.toml` 의 `[mcp_servers.*].url`

stdio 등록은 목적지가 없으므로 위반이 아니다.

## 실제로 잡힌 것

| 시점 | 무엇 |
|---|---|
| M5 | omp 가 lm-studio·ollama·llama.cpp·vllm 자동 탐지 → 로컬 LM Studio(:1234) 접속 |
| M7 | omp·grok 이 사용자 `$HOME` 의 MCP 설정을 읽어 외부 서버 기동 (툴 40여 개) |

## 하네스를 갱신했다면

**재실측이 필요하다.** omp 의 내장 로컬 프로바이더 id 목록은 버전마다 늘 수 있고, 새 id 는 곧 새 우회 통로다. → [[patterns/measure-dont-assume]]
