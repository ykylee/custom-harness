---
type: concept
status: active
updated: 2026-08-31
last_ingested_from: docs/requirements/nfr.md, scripts/nfr1-smoke.mjs, packages/daemon/src/gateway/service.ts
related_pages: [home-isolation, zero-config-bundle, harness-wrapping]
---

# 폐쇄망 자기완결 (NFR-1)

이 프로젝트의 **가장 강한 제약**이자 존재 이유. 설치·기동·세션 실행·업데이트 확인의 전 과정에서 허용된 목적지는 셋뿐이다.

1. 커스텀 게이트웨이
2. (FR-4.6 으로 설정한 경우) 내부 아티팩트 저장소
3. localhost

그 외 **전부 위반**이다 — 하네스 버전 체크, 텔레메트리, npm·모델 카탈로그 페치, CDN 자원, Electron 자동 업데이트 확인.

## 왜 "최소화"가 아니라 "0" 인가

사내망에서는 외부 접속이 느려지는 게 아니라 **막힌다**. 하나라도 남아 있으면 그 지점에서 기능이 죽거나, 타임아웃까지 매달려 있다가 죽는다. 그래서 목표치가 "적게"가 아니라 **0** 이고, 판정도 비율이 아니라 건수다.

## 검증은 선언이 아니라 측정이다

`npm run smoke:nfr1` — 목 게이트웨이(OpenAI 호환 SSE)를 띄우고 실물 하네스로 1턴을 돌린 뒤 `lsof` 로 실제 커넥션을 판정한다. 허용 외 목적지 0건이어야 통과.

측정 범위가 두 번 넓어졌고, 두 번 다 **실제 누수를 놓치고 있었다**:

- **v2 (M2)**: pi 1턴 → 3하네스 + 혼합 6세션 부하
- **v3 (M7 7.2.0a)**: PID 원장의 하네스 프로세스만 → **자손 프로세스 트리 전체**. `ps -Ao pid=,ppid=` 로 BFS. 계기는 [[concepts/home-isolation]] — 하네스가 띄운 MCP 서버(손자)가 원장에 없어 감시망 밖이었다.

기동 시 정적 검사도 병행한다(FR-2.5 트래픽 경계 검사): 하네스 설정 파일에 게이트웨이 아닌 목적지가 있으면 경고. M7 에서 **원격 MCP 등록**(omp `mcp.json` 의 `mcpServers.*.url`, grok `config.toml` 의 `[mcp_servers.*].url`)을 검사 항목에 추가했다. stdio 등록은 목적지가 없으므로 위반이 아니다.

## 실제로 잡힌 위반 2건

측정이 없었으면 전부 조용히 새고 있었을 것들이다.

| 시점 | 위반 | 조치 |
|---|---|---|
| M5 (2026-08-30) | omp 17.3.8 이 lm-studio·ollama·llama.cpp·vllm 을 **내장 프로바이더로 자동 탐지**해 로컬 LM Studio(:1234)에 접속 | `models.yml` 선점 차단. 사용자 설정 항목은 보존하고 경계 검사가 경고 |
| M7 (2026-08-31) | omp·grok 이 사용자 실제 `$HOME` 의 MCP 설정을 읽어 외부 서버를 기동 — 툴 40여 개 유입 | [[concepts/home-isolation]] |

두 번째는 특히 **원격 MCP 서버가 하나라도 설정돼 있었으면 곧바로 게이트웨이 경계 밖 접속**이었다. 걸리지 않은 이유는 측정 PC 의 서버가 우연히 전부 stdio 였기 때문이다.

## 유지 비용

하네스 버전을 올릴 때마다 재실측이 필요하다. omp 의 내장 로컬 프로바이더 id 목록은 버전마다 늘 수 있고, 새 id 가 추가되면 우회 통로가 다시 생긴다. [[patterns/measure-dont-assume]] 이 이 항목에서 가장 비싸게 적용된다.
