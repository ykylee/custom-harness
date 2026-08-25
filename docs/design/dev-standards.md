<!-- standard-ai-workflow-kit: v1.4.0 -->

# 개발 기반 표준 (M0 WBS 0.6.1 산출물)

- 문서 목적: 모노레포 구조·빌드·테스트·린트 도구를 확정한다. 확정 스택(TS/Electron/React — [tech-stack](./tech-stack.md)) 위의 실무 표준.
- 상태: approved (v1, 2026-08-25 사용자 승인)
- 최종 수정일: 2026-08-25
- 관련: [ROADMAP M0](../roadmap/m0-design.md) WP 0.6, [기술 스택](./tech-stack.md)

## 1. 모노레포 구조 (npm workspaces)

```
custom-harness/
├── package.json               # workspaces 루트
├── packages/
│   ├── protocol/              # zod 스키마 단일 소스 (의존성: zod 만 — 순수성 유지)
│   ├── daemon/                # 데몬 본체 + 어댑터 (adapters/pi, adapters/omp, adapters/grok, adapters/mock)
│   ├── renderer/              # React UI (브라우저 타깃)
│   ├── shell/                 # Electron 메인 프로세스 (렌더러 코드 없음 — 수명주기만)
│   └── cli/                   # 관리 CLI
├── bundle/                    # 번들 조립 스크립트·manifest 도구·설정 템플릿 (FR-4)
└── docs/
```

- 의존 방향 규칙: `protocol ← daemon / renderer / shell / cli` (protocol 은 무엇에도 의존하지 않음). renderer ↛ daemon 직접 import 금지 — 통신은 프로토콜로만.
- 어댑터는 daemon 내 서브디렉토리로 시작 (조기 패키지 분리는 과설계). mock 어댑터는 계약 테스트·UI 개발용으로 1급 취급.

## 2. 도구 확정

| 영역 | 선택 | 근거 |
|---|---|---|
| 언어 | TypeScript 5.x, `strict` | 확정 스택 |
| Node 버전 | **Electron 동봉 버전으로 고정** (`.nvmrc` 를 Electron 내장 Node 와 일치) | 개발·번들 런타임 일치 (FR-4.1.3) |
| 패키지 매니저 | npm (workspaces) | 확정 사항. lockfile 커밋 필수 |
| 데몬/CLI 빌드 | esbuild | 단순·고속, 단일 번들 산출 |
| 렌더러 빌드 | Vite (React) | 표준적 DX, 정적 산출물을 셸이 로드 |
| 셸 패키징 | electron-builder (아카이브 출력만 사용 — 자동업데이트 기능 미사용) | FR-4.4 전체 번들 교체 정책과 충돌 방지 |
| 테스트 | vitest (+ 계약 테스트는 mock 어댑터 기반) | 모노레포 단일 러너 |
| 린트/포맷 | eslint + prettier | 범용성·팀 온보딩 우선 (oxc 계열은 성숙도 확인 후 전환 검토) |
| 스키마 | zod v4 | protocol 단일 소스 (와이어 스키마에 `.transform()` 금지 — 순수성 규칙) |

## 3. 규칙

- **COMPAT 태그**: 모든 호환 코드는 `// COMPAT(<name>): <이유>, remove after <YYYY-MM-DD>` — 정기 스캔 대상 (NFR-5).
- **clean-room**: paseo 소스 열람·복사 금지. 참고는 이 저장소의 분석 문서만 (NFR-4). PR/커밋 체크리스트 항목화.
- **외부 의존 최소화**: 런타임 의존성 추가는 폐쇄망 영향(전이 의존성·다운로드) 검토 후. 빌드 타임 의존은 자유.
- 커밋·브랜치 규칙, CI 게이트 상세는 0.6.2(테스트 전략)에서 정의.
