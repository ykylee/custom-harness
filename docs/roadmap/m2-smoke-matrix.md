<!-- standard-ai-workflow-kit: v1.4.0 -->

# M2 3×3 스모크 매트릭스 (WBS 2.7.2, NFR-9)

- 문서 목적: 3 OS × 3 하네스 기능 체크리스트의 실측 기록. M2 완료 기준의 "3 하네스 × 3 OS 스모크 매트릭스 통과(축소안 반영 범위 내)" 판정 근거.
- 상태: in_progress — **darwin 열 실측 완료, linux/win 열은 실기기(C-5) 대기**
- 최종 수정일: 2026-08-25
- 실행 방법: 각 OS 실기기에서 ① 번들 설치(install 스크립트) ② `custom-harness doctor` ③ `npm run smoke:nfr1`(개발 트리) 또는 앱 온보딩→세션 1턴 ④ 아래 체크리스트 확인

## 범위 (승인된 축소안)

| | macOS arm64 | Linux x64 | Windows x64 |
|---|---|---|---|
| pi | 대상 | 대상 | **조건부** (Git Bash 전제 — C-5 실측 후 확정) |
| omp | 대상 | 대상 | 대상 |
| grok | 대상 | 조달 절차 미확정 (CDN 미러 — packaging §6) | **제외** (2026-08-25 결정) |

## 기능 체크리스트 × 실측 결과

체크 항목 (NFR-9 플랫폼 일관성): ①번들 조립·manifest 검증 ②설치 스크립트 ③doctor 전 항목 ④하네스 세션 1턴(스트리밍) ⑤승인/중재(pi·grok) ⑥세션 재개 ⑦NFR-1(허용 외 커넥션 0) ⑧동시 세션 부하

### macOS arm64 — 2026-08-25 실측 (개발 실기기)

| 항목 | 결과 | 근거 |
|---|---|---|
| ① 번들 조립·검증 | **PASS** | 205.7MB tar.gz, manifest 전 구성물 일치, 번들 데몬 기동 스모크 (2.5.3) |
| ② install.sh | **PASS** | 격리 루트 실설치 → 설치본 CLI 데몬 기동/상태/종료 (2.5.2) |
| ③ doctor | **PASS** | 실물 번들 대상 manifest 일치 + pi 0.84.1/omp 17.3.8/grok 1.0.5 실행·버전 확인 (2.6.1) |
| ④ 3하네스 1턴 | **PASS** | NFR-1 v2 단계 A — pi 0.6s·omp 0.6s·grok 1.3s, 델타 스트리밍 수신 (2.7.1) |
| ⑤ 승인 중재 | **PASS** (계약 테스트) | pi extension_ui·grok request_permission 계약 스위트 + grok 실측 프로브 (1.3.3·2.2.3). omp 는 §4 결정으로 중재 없음(--approval-mode) |
| ⑥ 세션 재개 | **PASS** (계약 테스트+실측) | pi/omp --session·grok session/load 리플레이 드롭 실측 (1.3·2.1·2.2) |
| ⑦ NFR-1 | **PASS** | 허용 외 TCP 커넥션 0건 (프록시 블랙홀 + lsof 전 구간 감시, LLM 호출 16건 전부 목 게이트웨이) |
| ⑧ 동시 부하 | **PASS** | 혼합 6세션(2×3) 동시 턴 1.4s 완료, seq 단조·세션 정합 (2.7.3) — 검출·수정: PID 원장 동시 쓰기 경합 |

### Linux x64 — 실기기 대기 (C-5)

- 번들 조립·manifest 검증까지는 사외 빌드에서 **PASS** (244.4MB, 2.5.3 — grok 제외 구성).
- ②~⑧: 실기기 필요. 절차: install.sh → doctor → 온보딩 → pi·omp 각 1턴 → NFR-1 스모크.

### Windows x64 — 실기기 대기 (C-5)

- 번들 조립·manifest 검증까지는 사외 빌드에서 **PASS** (260.7MB zip, 2.5.4 — omp+pi 조건부 구성).
- ②~⑧: 실기기 필요. 절차: install.ps1(ExecutionPolicy Bypass) → doctor → 온보딩 → omp 1턴 → pi 조건부 판정(Git Bash 유무별) → junction 전환·재설치 확인.

## 잔여 → M2 완료 판정 조건

- [ ] Linux/Windows 실기기 실측 (C-5) — 사내 체크리스트로 요청
- [ ] grok Linux 조달(CDN 미러 절차) 확정 시 Linux 열에 grok 추가
- 매트릭스 "축소안 반영 범위 내" 기준: darwin 전 항목 + linux(pi·omp) + win(omp, pi 조건부) 통과 시 충족
