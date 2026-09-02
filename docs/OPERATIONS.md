<!-- standard-ai-workflow-kit: v1.4.0 -->

# custom-harness 운영 가이드

- 문서 목적: 사외 빌드 환경에서 만든 번들을 폐쇄망으로 반입·배포·갱신하고, 장애 시 안전하게 되돌리는 운영 절차를 고정한다.
- 대상 독자: 릴리스 담당자, 사내 반입·배포 담당자, 1차 지원 담당자. 일반 사용은 [사용자 가이드](./USER_GUIDE.md)를 따른다.
- 상태: active (2026-09-02 최초 작성 — WBS 3.6.2)
- 최종 수정일: 2026-09-02
- 관련 문서: [사용자 가이드](./USER_GUIDE.md), 패키징 설계·NFR·clean-room 검수 기록·사내 확인 체크리스트 (저장소 원본)

## 1. 운영 원칙과 역할

번들은 OS/아키텍처별 **불변 버전 세트**다. 하네스 하나만 교체하거나 사용자가 자체 업데이트하도록 두지 않는다. 새 버전은 새 번들을 만들고, 설치기를 다시 실행해 `current`만 전환한다.

| 역할                   | 책임                                                                            |
| ---------------------- | ------------------------------------------------------------------------------- |
| 릴리스 담당자          | 사외 빌드·검증, 해시·검수 기록, 반입 인계물 작성                                |
| 반입·배포 담당자       | 허가된 매체/파일 공유로 아카이브와 `.sha256`를 함께 이관, 대상 OS용 번들만 배포 |
| 사용자 지원            | 설치·`doctor`·로그 수집, 필요 시 롤백 안내                                      |
| 게이트웨이/보안 담당자 | 게이트웨이 접속·키 발급, 서명/미서명 배포 정책, 내부 저장소 여부 결정           |

개인 API 키, 사용자 세션, `~/.custom-harness/data/` 및 `logs/`는 반입물에 넣지 않는다.

## 2. 릴리스 전 결정과 차단 조건

아래 항목은 구현으로 대신 결정할 수 없는 조직 정책이다. 미확정이면 해당 경로를 시작하지 않는다.

| 확인                           | 관련 WBS    | 결정 전 기본 동작                                                     |
| ------------------------------ | ----------- | --------------------------------------------------------------------- |
| C-2 내부 아티팩트 저장소       | 0.5.2 / 3.2 | 파일 반입·수동 설치만 사용. 앱의 저장소 업데이트 기능은 제공하지 않음 |
| C-3 코드 서명·미서명 배포 정책 | 0.5.3 / 3.4 | 조직 승인된 Gatekeeper/SmartScreen 안내 없이는 배포하지 않음          |
| C-1 게이트웨이 실측·키 발급    | 0.5.4       | 파일 반입은 가능하지만 파일럿 전 실환경 연결 검증은 완료하지 못함     |

다음은 **배포 차단**이다.

- 필수 검증 하나라도 실패했거나, 아카이브 SHA-256이 인계 기록과 다름
- `npm run audit:cleanroom`이 실패함
- `doctor`가 동봉 하네스의 실물 버전과 manifest를 불일치로 보고함
- Grok 로컬 소스는 빌드 시 `--version`이 `sources.json` 고정 버전과 일치해야 한다. Linux 조달물은 고정 SHA-256을 검증한다. 둘 중 하나라도 불일치하면 빌드가 중단된다.

## 3. 사외 빌드 절차

### 3.1 빌드 환경 준비

- Node.js 22 이상, `npm`, `tar`, `zip`, macOS에서는 `shasum`을 준비한다.
- macOS arm64 빌드 호스트는 pi 패키지 원본을 준비한다. 기본 경로는 `bundle/sources.json`의 `pi.localDir`이며, 다른 위치라면 `--pi-source <절대경로>`를 사용한다.
- 외부 조달은 **사외 빌드 환경에서만** 허용한다. `bundle/cache/`는 고정 해시 조달물 캐시이며 저장소에 넣지 않는다.

```sh
npm ci
npm run typecheck
npm run -w @custom-harness/renderer build
```

### 3.2 OS별 번들 조립과 기본 검증

세 타깃을 각각 조립한다. `--verify`는 manifest를 재검증하고, 호스트와 같은 macOS arm64에서는 번들 데몬의 기동·상태·종료도 확인한다.

```sh
node bundle/build-bundle.mjs --target darwin-arm64 --verify
node bundle/build-bundle.mjs --target linux-x64 --verify
node bundle/build-bundle.mjs --target win32-x64 --verify
```

산출물은 `bundle/out/`에 생긴다.

| 대상        | 아카이브                                       | 동봉 하네스         |
| ----------- | ---------------------------------------------- | ------------------- |
| macOS arm64 | `custom-harness-<version>-darwin-arm64.tar.gz` | pi, omp, grok       |
| Linux x64   | `custom-harness-<version>-linux-x64.tar.gz`    | pi, omp, grok       |
| Windows x64 | `custom-harness-<version>-win32-x64.zip`       | pi, omp (grok 제외) |

각 아카이브에는 같은 이름의 `.sha256` 파일이 반드시 있어야 한다. 아카이브·해제본·`.sha256`의 버전 문자열이 모두 같은지 확인한다.

### 3.3 릴리스 검증 묶음

빌드가 끝난 뒤 다음을 실행한다. 첫 세 명령은 번들 유무에 따라 실제 번들 층까지 확인한다. macOS arm64에서는 동봉된 하네스 절대경로를 명시해 NFR-1/2를 검증한다.

```sh
npm test
npm run typecheck
npm run lint
npm run format:check
npm run audit:compat
npm run smoke:terminal -- "$PWD/bundle/out/custom-harness-<version>-darwin-arm64"
npm run smoke:update
npm run smoke:nfr8
npm run audit:cleanroom
npm run smoke:nfr1 -- \
  --pi-entry "$PWD/bundle/out/custom-harness-<version>-darwin-arm64/harnesses/pi/dist/cli.js" \
  --omp "$PWD/bundle/out/custom-harness-<version>-darwin-arm64/harnesses/omp/omp" \
  --grok "$PWD/bundle/out/custom-harness-<version>-darwin-arm64/harnesses/grok/grok"
```

사내 self-hosted macOS arm64 러너가 준비되면 GitHub Actions의 `release-nfr`도 같은 검증을 수행한다. 이 체크를 branch protection의 필수 상태 검사로 지정한다.

### 3.4 인계 기록

릴리스 담당자는 아래를 한 릴리스 기록에 남겨 반입 담당자에게 전달한다.

- 릴리스 버전, 생성 일시, 빌드 커밋 SHA
- 타깃별 아카이브 파일명·SHA-256·크기
- §3.3 명령의 통과 결과와 예외/경고
- 동봉 하네스 버전(`manifest.json`)과 `doctor` 실측 결과
- 서명 여부와 미서명일 경우 조직 승인 절차
- 롤백 대상인 직전 승인 버전

## 4. 폐쇄망 반입·배포

### 4.1 반입 전과 후의 해시 대조

반입할 때는 아카이브와 동명의 `.sha256`를 항상 한 쌍으로 취급한다. 반입 전과 후에 같은 값을 기록한다.

```sh
# macOS (bundle/out에서 실행)
shasum -a 256 -c custom-harness-<version>-darwin-arm64.tar.gz.sha256

# Linux (bundle/out에서 실행)
sha256sum -c custom-harness-<version>-linux-x64.tar.gz.sha256
```

```powershell
# Windows PowerShell — .sha256의 첫 토큰과 실제 SHA-256을 비교한다.
$expected = (Get-Content .\custom-harness-<version>-win32-x64.zip.sha256).Split()[0]
$actual = (Get-FileHash .\custom-harness-<version>-win32-x64.zip -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) { throw "SHA-256 불일치" }
```

불일치하면 해제·설치를 시도하지 않고 반입물을 폐기한 뒤, 사외 빌드 산출물부터 다시 대조한다.

### 4.2 대상 장비 설치

아카이브를 사용자 쓰기 가능한 임시 디렉터리에 해제한 뒤, 해제된 번들 루트에서 설치기를 실행한다. 관리자 권한은 필요하지 않다.

```sh
# macOS / Linux
tar -xzf custom-harness-<version>-<target>.tar.gz
cd custom-harness-<version>-<target>
./install.sh
~/.custom-harness/bin/custom-harness doctor
```

```powershell
# Windows
Expand-Archive .\custom-harness-<version>-win32-x64.zip -DestinationPath .\extracted
Set-Location .\extracted\custom-harness-<version>-win32-x64
powershell -ExecutionPolicy Bypass -File .\install.ps1
& "$env:USERPROFILE\.custom-harness\bin\custom-harness.cmd" doctor
```

설치기는 체크섬 검증 → 버전 디렉터리 배치 → 오프라인 프리셋 → `current` 전환 → 실행 진입점 생성을 수행한다. 설치가 실패하면 `current` 전환 전에는 기존 설치를 유지한다.

설치 후 `doctor`에서 manifest·하네스 버전·오프라인 프리셋·트래픽 경계를 확인한다. 경고나 실패가 있으면 사용자에게 온보딩을 진행시키지 말고 §6 절차로 넘긴다.

## 5. 갱신과 보존 정책

새 버전 아카이브를 반입한 뒤 §4.2의 설치기를 다시 실행하면 업데이트다. 실행 중인 데몬이 있으면 설치기가 중단하므로 먼저 앱을 종료하거나 데몬을 멈춘다.

```sh
custom-harness daemon stop
./install.sh                 # macOS / Linux
# Windows: powershell -ExecutionPolicy Bypass -File .\install.ps1
```

- 기본 보존 수는 이전 버전 3개다. 설치 시 `--keep N`(Windows `-Keep N`) 또는 `CUSTOM_HARNESS_KEEP_VERSIONS`로 조정한다.
- 보존 대상에서 `current`와 방금 설치한 버전은 제거하지 않는다.
- 업데이트는 전체 번들 교체만 허용한다. pi·omp·grok의 자체 업데이트와 개별 파일 복사는 금지한다.
- 설치 후 `doctor`, 기본 온보딩 연결, 필요한 경우 핵심 워크스페이스에서 1턴을 확인하고 릴리스 기록을 갱신한다.

## 6. 장애 대응과 롤백

### 6.1 1차 분류

| 증상                       | 먼저 할 일                                                        | 다음 조치                                                 |
| -------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| 설치 중 해시/manifest 실패 | 설치 중단                                                         | 반입 SHA-256과 빌드 인계 기록 재대조                      |
| 앱/하네스 기동 실패        | `custom-harness doctor`, `custom-harness logs daemon --lines 200` | 동봉 하네스·manifest 경고와 로그를 릴리스 담당자에게 전달 |
| 게이트웨이 연결 실패       | `doctor`의 게이트웨이·트래픽 경계 항목 확인                       | 주소·키·조직 네트워크 정책을 게이트웨이 담당자와 확인     |
| 업데이트 뒤 기능 회귀      | 데몬을 멈추고 롤백                                                | 직전 승인 버전으로 되돌린 뒤 증적 수집                    |

### 6.2 롤백 실행

`custom-harness-rollback`은 `current`를 거치지 않는다. 따라서 새 `current`가 깨져도 실행할 수 있다. 세션 이력·설정·크리덴셜은 버전 바깥 `data/`에 있으므로 롤백하지 않는다.

```sh
custom-harness daemon stop
custom-harness-rollback --list
custom-harness-rollback                 # 설치 시각 기준 직전 버전
# 또는 custom-harness-rollback <version>
custom-harness doctor
```

Windows에서는 `custom-harness-rollback.cmd --list`와 `custom-harness-rollback.cmd [version]`을 사용한다. 실행 중이라 중단되면 데몬을 멈춘 뒤 재시도한다. 자동화된 비대화 작업에서만 설치기·롤백의 `--force`/`-Force`를 사용하며, 사전에 영향 범위를 승인받는다.

### 6.3 증적과 에스컬레이션

지원 담당자는 원본 API 키·프롬프트·세션 원문을 외부로 보내지 않는다. 다음 최소 정보만 수집한다.

- 설치 버전과 OS/아키텍처, `doctor` 출력
- `custom-harness logs daemon --lines 200` 및 관련 하네스 로그의 비밀 제거본
- 실행한 설치/롤백 명령과 종료 코드
- 반입 SHA-256, 현재·직전 버전, 롤백 결과

## 7. 운영 종료 기준

한 릴리스가 배포 가능한 상태가 되려면 §3의 검증과 §4의 반입 해시 대조가 기록돼 있어야 하고, C-1~3 중 해당 조직 정책이 요구하는 항목이 결정돼 있어야 한다. 파일럿에서는 설치·온보딩·기본 세션·롤백의 결과와 피드백을 기록해 WBS 3.6.3·3.6.4의 입력으로 사용한다.
