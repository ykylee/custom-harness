<!-- standard-ai-workflow-kit: v1.4.0 -->

# FR-4 상세 — 패키징·설치·업데이트

- 문서 목적: [REQUIREMENTS](../REQUIREMENTS.md) FR-4 그룹의 상세 요구사항. 오프라인 아카이브 번들의 구성·설치·갱신.
- 상태: approved (v1, 2026-08-25 사용자 승인)
- 최종 수정일: 2026-08-25
- 근거 문서: [패키지 배포 형태](../design/packaging.md), [기술 스택](../design/tech-stack.md)

## FR-4.1 번들 구성 (M, M1: macOS 1종 / M2: 3종)

- FR-4.1.1 OS/아키텍처별 단일 아카이브 3종: macOS arm64 / Windows x64 / Linux x64. 설치·실행 중 외부 다운로드 0 (NFR-1). **(2026-08-25 개정)** Windows 아카이브의 하네스 구성은 **omp + pi(조건부)** — grok 는 Windows 제외 ([결정 근거](../reference/windows-support.md)).
- FR-4.1.2 번들 레이아웃(예시 — 확정은 M0 설계):

```
custom-harness-<ver>-<os>-<arch>/
├── manifest.json                  # FR-4.2 버전 세트
├── app/                           # Electron 앱 (셸+데몬+렌더러, Node 겸용)
├── harnesses/
│   ├── pi/        (npm 패키지 해제본)
│   ├── omp/       (npm 패키지 해제본)
│   └── grok/      (단일 바이너리)
├── config-templates/              # FR-2.1 주입 템플릿 (하네스별)
├── licenses/                      # FR-4.5 NOTICE + 라이선스 원문
└── install.(sh|ps1)               # FR-4.3
```

- FR-4.1.3 별도 Node 런타임은 동봉하지 않는다 — Electron 내장 Node 를 `ELECTRON_RUN_AS_NODE` 로 데몬·pi/omp 실행에 겸용.

## FR-4.2 manifest 버전 세트 (M, M2)

manifest.json 필수 필드:

| 필드 | 내용 |
|---|---|
| `bundleVersion` | 번들 버전 (semver) |
| `os` / `arch` | 대상 플랫폼 |
| `harnesses[]` | 하네스별 `{name, version, checksum(sha256), path, verifiedAt}` |
| `app` | 본체 `{version, checksum}` |
| `configTemplates` | 주입 템플릿 버전 |
| `electronVersion` | 겸용 런타임 버전 |

- FR-4.2.1 설치기는 해제 후 전 구성물의 체크섬을 검증하고, 불일치 시 설치를 중단한다 (NFR-8).
- FR-4.2.2 어댑터의 버전 검증(FR-1.8)은 이 manifest 를 참조한다.

## FR-4.3 설치 (M, M2 — M1 은 수동 절차로 대체 가능)

- FR-4.3.1 설치 스크립트(macOS/Linux: `install.sh`, Windows: `install.ps1`)는 관리자 권한 없이 사용자 홈(`~/.custom-harness/versions/<ver>/` 상당)에 설치한다.
- FR-4.3.2 설치 단계: 체크섬 검증 → 버전 디렉토리 해제 → 하네스 설정 주입(FR-2.1, 기존 설정 백업) → 오프라인 프리셋(FR-2.2) → `current` 심링크(Windows: junction) 전환 → 실행 진입점(앱 바로가기/심링크) 생성.
- FR-4.3.3 설치 실패 시 이전 상태를 변경하지 않는다 — 심링크 전환은 마지막 단계에서 원자적으로 수행 (NFR-8).
- FR-4.3.4 제거 스크립트 제공: 버전 디렉토리·심링크·주입 설정 블록 제거(사용자 데이터·세션 이력은 별도 확인 후 삭제). (S, M3)

## FR-4.4 업데이트·롤백 (M, M3)

- FR-4.4.1 업데이트 = 새 번들로 FR-4.3 재수행. 이전 버전 디렉토리는 보존(보존 개수 설정 가능).
- FR-4.4.2 롤백 = `current` 심링크를 이전 버전으로 전환하는 단일 조작. 세션 데이터는 버전 디렉토리 밖에 있어 롤백에 영향받지 않는다.
- FR-4.4.3 하네스 개별 패치 경로는 제공하지 않는다 — 버전 세트 불변성 유지.
- FR-4.4.4 실행 중 업데이트 시도 시 데몬·세션 종료를 안내하고 동의 후 진행.

## FR-4.5 라이선스 고지 (M, M3)

- NOTICE(동봉물 목록·버전·라이선스 요약) + 각 라이선스 원문(MIT: pi/omp, Apache 2.0: grok build + NOTICE 파일 승계, Electron/의존성 고지 포함)을 `licenses/` 에 동봉하고 앱 정보 화면에서 열람 가능하게 한다.

## FR-4.6 내부 아티팩트 저장소 연동 (C, M3)

- 설정에 저장소 URL 등록 시: 본체가 **해당 저장소만** 대상으로 새 번들 버전 확인 → 다운로드 → FR-4.3 설치 실행을 지원한다. 미설정 시 이 기능은 완전 비활성(네트워크 시도 0).
- 저장소 유무는 OPEN-3 확인 결과에 따라 M3 범위 확정.

## FR-4.7 빌드 파이프라인 (M, M2 — 문서화는 M3)

- 사외 빌드 환경에서 3 OS 번들 생성 → 체크섬·(가능 시) 서명 → 반입 절차용 산출물 패키징까지를 재현 가능한 파이프라인으로 구성한다. 코드 서명 적용 범위는 OPEN-3 확인 결과에 따른다.
