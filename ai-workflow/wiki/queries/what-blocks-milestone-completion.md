---
type: query
status: active
updated: 2026-08-31
last_ingested_from: docs/roadmap/m0-internal-checklist.md, docs/roadmap/m2-smoke-matrix.md, docs/roadmap/PROGRESS.md
related_pages: [gateway, workbench-canvas, home-isolation]
---

# 질문 — M1·M2 는 왜 아직 완료 선언이 안 됐나?

**기능은 다 됐다. 막고 있는 것은 전부 사내 협조 대기 항목이다.** 사외에서 할 수 있는 일이 남아서가 아니다.

## C-1 — 실 게이트웨이 실측

지금까지의 모든 검증은 **목 게이트웨이** 기준이다. 실 게이트웨이로 확인해야 하는 것:

- SSE 스트리밍 품질(중계 버퍼링 여부) — 깨지면 NFR-6 이 우리 통제 밖에서 무너진다
- 비표준 응답 형태 → compat 플래그 확정
- `/v1/models` 응답 형태

→ 이것이 **1.7.3 M1 수용 시나리오**의 입력이고, **M1 완료 선언의 마지막 조건**이다. M2 완료 선언은 M1 완료가 선행이다.

## C-5 — 실기기 매트릭스 (linux / win)

darwin 만 실검증됐다. Windows 는 특히 경로가 다르다:

- install.ps1 · uninstall.ps1 검증
- **터미널** — conpty 경로라 darwin 결과가 이어지지 않는다
- **홈 격리** — `USERPROFILE` 덮기와 심볼릭 링크 반입(권한 필요)이 성립하는지
- git `--show-prefix` 경로 유도가 **junction 환경**에서 성립하는지
- pi Windows 조건부 판정(Git Bash 전제)

## 그 밖

- **C-2** 내부 아티팩트 저장소 유무 → M3 WP3.2 조건부
- **C-3** 코드 서명 체계 → M3 WP3.4 갈래
- **C-4** 게이트웨이 키 발급 API 유무 → 자동 프로비저닝 가부

## 그래서 지금 무엇을 하고 있나

**M5·M6 는 이 대기와 독립**이라 병행했고 완료됐다. 현재는 M7 오케스트레이션 진행 중. 자원 경합이 생기면 M3(릴리스 1.0)를 우선한다.

## 관련 문서

`docs/roadmap/m0-internal-checklist.md` (요청 체크리스트) · `docs/roadmap/m2-smoke-matrix.md` (실기기 절차) · `docs/roadmap/PROGRESS.md`
