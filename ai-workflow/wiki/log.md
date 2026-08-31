# Wiki Ingest/Query Log

- 문서 목적: 모든 ingest / query / lint 이벤트의 append-only 작업 로그. 시간 순 보존, 편집 금지 (append only).
- 갱신 규칙: ingest 종료 시 또는 query/lint 실행 시 한 줄 추가. 형식 `## [YYYY-MM-DD] <event> | <summary>`.
- 최종 갱신일: 2026-08-31

## [2026-08-31] retro-ingest | wiki 계층 소급 구축 (26 페이지)

- 계기: `wk session-start` 의 상시 경고 `wiki concepts 디렉토리 부재 — cross-reference skipped`. 원인은 손상이 아니라 **부트스트랩 시 `--enable-wiki` 미적용**(킷의 옵트인 기능)이었고, `CLAUDE.md:35` 가 없는 `wiki/index.md` 를 "가장 먼저 로드하라"고 지시하고 있었다.
- 범위: 누적 지식의 소급 정리. concepts 9 / entities 5 / decisions 5 / patterns 3 / queries 4 = **26 페이지** + SCHEMA·index·log.
- 원천: `docs/` 설계서 14종·요구사항 11종·레퍼런스 8종·로드맵 12종, `session_handoff.md`(28KB), `packages/` 구현. 특히 handoff 에 축적된 **실측 사실**을 주제별로 재배치한 것이 이번 ingest 의 본체다.
- 원칙: 원 문서를 복사하지 않고 **왜**를 담아 링크로 넘긴다(SCHEMA §6). 모든 페이지에 `last_ingested_from` 기입 — 36개 경로 전부 실재 확인.
- 태스크: TASK-2026-08-31-main-007
