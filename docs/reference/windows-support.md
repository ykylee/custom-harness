<!-- standard-ai-workflow-kit: v1.4.0 -->

# Windows x64 지원 조사 보고 (M0 WBS 0.5.1)

- 문서 목적: 1차 타깃 하네스 3종의 Windows x64 지원 현황 조사 — M2 Windows 번들 범위 결정의 근거.
- 조사일: 2026-08-25 (웹 조사 — 공식 문서·GitHub Releases·이슈 트래커. 실기기 실측 미수행: [체크리스트 C-5](../roadmap/m0-internal-checklist.md))
- 관련: [packaging](../design/packaging.md) §6, [ROADMAP M0](../roadmap/m0-design.md) 0.5.1

## 0. 종합 판정

| 하네스 | Windows x64 판정 | 오프라인 번들 반입 난도 |
|---|---|---|
| **oh my pi** | **네이티브 지원 (가장 명확)** — "no WSL bridge" 명시, GitHub Releases 에 `omp-windows-x64.exe`(143MB, v18.0.4) 제공 | **낮음** — 단일 exe |
| **pi** | 조건부 — 네이티브 가능하나 **Git Bash 필수**, 설치/실행 이슈 다수(신규 설치 실행 불가·spawn ENOENT 계열), 메인테이너는 WSL2 를 최소 문제 경로로 인식 | 중간 — `pi-windows-x64.zip` 존재하나 **첫 실행 시 외부 바이너리(fd 등) 다운로드 시도** |
| **grok build** | 조건부 — 설치 경로(install.ps1)는 공식이나 README 에 "**Windows builds are best-effort and not currently tested**" 명시 | **높음 — GitHub Releases 에 asset 자체가 없음**(전 플랫폼). 바이너리는 x.ai CDN 설치 스크립트로만 배포 |

## 1. 주요 발견 상세

### grok build

- GitHub Releases 가 비어 있음 — **전 플랫폼에서** 바이너리를 릴리스에서 받을 수 없고, x.ai CDN 설치 스크립트(`install.ps1`/셸)가 유일 경로. 폐쇄망 번들용으로는 CDN 바이너리를 미러링해야 하며 버전 고정·해시 검증이 GitHub Releases 대비 불투명.
- Windows 는 네이티브 지원 선언이나 "best-effort, 미테스트" — TUI 잔상, verbatim path(`\\?\`) 등 이슈 이력. headless 모드의 Windows 검증 정보 없음.

### pi

- 공식 windows.md 존재 — 단 **Git for Windows(Git Bash) 사전 설치가 전제**. 설치 실패·실행 불가 이슈 반복 보고(#1348, #4399, #4665, #5103), Windows 전략 자체가 미확정(#7547).
- **첫 실행 시 fd 등 외부 바이너리 다운로드 시도**(#1348) — `PI_OFFLINE=1` 이 이를 차단하는지 실측 필요 (미차단 시 해당 바이너리 번들 동봉 필요).

### oh my pi

- 3종 중 유일하게 명시적 Windows 네이티브 선언 + 단일 exe 릴리스. 단 LSP/DAP·브라우저 자동화 확장은 언어 서버·브라우저 등 **외부 구성요소를 별도 조달**해야 하므로 폐쇄망에선 코어 기능 위주로 기대치 설정.

## 2. 계획 영향 (동기화 반영)

1. **[M2 Windows 범위 — 확정 (2026-08-25 사용자 승인)]** Windows 번들 1차 구성: **omp 확정 + pi 조건부(실기기 실측 통과 시) + grok 제외**. [m2-multi.md](../roadmap/m2-multi.md) 진입 조건에 반영 완료.
2. **[전 플랫폼 영향]** grok 바이너리 조달 경로가 CDN 미러링으로 확정 — 번들 빌드 파이프라인(M2 2.5.3)에 "CDN 미러 + 자체 해시 고정" 절차 필요. [packaging](../design/packaging.md) §6 파생 과제에 반영. → **2026-08-25 절차 확정·linux 적용 완료** ([packaging §6-1](../design/packaging.md))
3. **[신규 실측 항목]** pi 의 첫 실행 외부 바이너리 다운로드를 `PI_OFFLINE` 이 차단하는지 — NFR-1 위반 리스크. M0 0.7.1 스파이크 항목에 추가.
4. **[Windows 전제조건]** pi 채택 시 Git Bash 동봉 또는 사전 설치 요구 — 설치 스크립트·가이드(M2 2.5.4) 반영 필요.

## 3. 출처

- xai-org/grok-build Releases(부재 확인)·README·docs.x.ai headless 문서
- earendil-works/pi windows.md, 이슈 #1348/#4399/#4665/#5103/#7547
- can1357/oh-my-pi README·Releases v18.0.4, npm 패키지 페이지
