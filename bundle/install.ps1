# custom-harness 설치기 — Windows x64 (WBS 2.5.2·2.5.4·3.1.1, FR-4.3.1~3·FR-4.4, NFR-9)
# 관리자 권한 불요, 사용자 홈 설치. 실행 정책이 스크립트를 막으면 (0.5.1 실측 반영):
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
# 순서: 상태 판정 → 실행 중 확인 → 체크섬 검증 → 버전 디렉토리 배치 → 오프라인 프리셋 →
#       current junction 전환 → 진입점 → 이전 버전 정리.
# 참고: junction 교체(제거→생성)는 POSIX 심링크 rename 과 달리 완전 원자가 아니다 —
# 교체 순간의 짧은 공백은 1차 수용 (설치 실패 시 이전 junction 은 건드리지 않음).
#
# **업데이트는 이 스크립트를 다시 돌리는 것이다** (FR-4.4.1). 판단은 install.sh 와 같은
# node 도구(versions-tool.mjs)가 내린다 — 두 설치기에 같은 규칙을 두 번 쓰면 갈라진다.
#
# 옵션: -Force  실행 중인 데몬이 있어도 진행 / -Keep N  이전 버전 보존 개수 (기본 3)
param(
    [switch]$Force,
    [int]$Keep = 0
)
$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = if ($env:CUSTOM_HARNESS_ROOT) { $env:CUSTOM_HARNESS_ROOT } else { Join-Path $env:USERPROFILE '.custom-harness' }
$BundleName = Split-Path -Leaf $Here

# 번들 동봉 Electron 을 Node 로 겸용 (FR-4.1.3)
$NodeBin = Join-Path $Here 'app\electron\electron.exe'
if (-not (Test-Path $NodeBin)) { throw "[install] 번들 Electron 을 찾을 수 없음: $NodeBin" }
function Invoke-BundleNode {
    param([string[]]$NodeArgs)
    $env:ELECTRON_RUN_AS_NODE = '1'
    try {
        & $NodeBin @NodeArgs
        if ($LASTEXITCODE -ne 0) { throw "[install] 실패 (exit $LASTEXITCODE): $($NodeArgs -join ' ')" }
    } finally {
        Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    }
}

Write-Host '[install] 1/7 상태 판정'
Invoke-BundleNode @((Join-Path $Here 'tools\versions-tool.mjs'), 'plan', $Root, $BundleName)

Write-Host '[install] 2/7 실행 중 확인 (FR-4.4.4)'
# 종료 코드 3 = 데몬 실행 중이라 중단. 여기서는 예외가 아니라 그 코드를 그대로 전달한다
$GuardArgs = @((Join-Path $Here 'tools\versions-tool.mjs'), 'guard', $Root)
if ($Force) { $GuardArgs += '--force' }
$env:ELECTRON_RUN_AS_NODE = '1'
try { & $NodeBin @GuardArgs } finally { Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '[install] 3/7 체크섬 검증 (FR-4.2.1 — 불일치 시 중단)'
Invoke-BundleNode @((Join-Path $Here 'tools\manifest-tool.mjs'), 'verify', $Here)

Write-Host '[install] 4/7 버전 디렉토리 배치'
$Versions = Join-Path $Root 'versions'
$Target = Join-Path $Versions $BundleName
New-Item -ItemType Directory -Force -Path $Versions | Out-Null
if ($Here -like "$Versions*") {
    $Target = $Here  # 이미 versions\ 아래 — 복사 생략
} elseif (Test-Path $Target) {
    Write-Host "[install] 동일 버전 디렉토리가 이미 존재: $Target — 기존 설치 유지, 전환만 수행"
} else {
    # 중단된 이전 설치의 잔여물을 먼저 지운다 (WBS 3.1.3) — 남아 있으면 재시도가
    # 불완전한 트리 위에 덧씌워져 정상처럼 보이는 깨진 설치본이 된다
    if (Test-Path "$Target.partial") { Remove-Item -Recurse -Force "$Target.partial" }
    # 부분 복사가 노출되지 않게 partial 후 rename (NFR-8). MAX_PATH 는 매니페스트 경로가 짧아 회피
    Copy-Item -Recurse -Path $Here -Destination "$Target.partial"
    Rename-Item -Path "$Target.partial" -NewName $BundleName
}

Write-Host '[install] 5/7 오프라인 프리셋 선주입 (기존 파일 보존)'
$env:CUSTOM_HARNESS_HOME = $Root
try {
    Invoke-BundleNode @((Join-Path $Target 'tools\install-presets.mjs'))
} finally {
    Remove-Item Env:\CUSTOM_HARNESS_HOME -ErrorAction SilentlyContinue
}

Write-Host '[install] 6/7 current 전환 (junction — 0.5.1 실측 반영)'
$Current = Join-Path $Root 'current'
if (Test-Path $Current) {
    # junction 은 rmdir 로만 제거 (내용물 삭제 아님)
    (Get-Item $Current).Delete()
}
New-Item -ItemType Junction -Path $Current -Target $Target | Out-Null

Write-Host '[install] 7/7 실행 진입점 + 이전 버전 정리 (.cmd 심 — 심링크 권한 불요)'
$BinDir = Join-Path $Root 'bin'
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
@(
    '@echo off',
    'call "%~dp0..\current\bin\custom-harness.cmd" %*'
) | Set-Content -Path (Join-Path $BinDir 'custom-harness.cmd') -Encoding ascii

# 롤백 진입점 (FR-4.4.2) — current 를 거치지 않는다. 롤백은 current 가 깨졌을 때 쓰는
# 것이라, 그 junction 을 타고 실행되는 도구로는 정작 필요할 때 못 쓴다.
@(
    '@echo off',
    'setlocal',
    'if "%CUSTOM_HARNESS_ROOT%"=="" (set "CH_ROOT=%USERPROFILE%\.custom-harness") else (set "CH_ROOT=%CUSTOM_HARNESS_ROOT%")',
    'set "CH_NODE="',
    'for /d %%v in ("%CH_ROOT%\versions\*") do (',
    '  if exist "%%v\tools\versions-tool.mjs" if exist "%%v\app\electron\electron.exe" (',
    '    if not defined CH_NODE (',
    '      set "CH_NODE=%%v\app\electron\electron.exe"',
    '      set "CH_TOOL=%%v\tools\versions-tool.mjs"',
    '    )',
    '  )',
    ')',
    'if not defined CH_NODE (echo [rollback] 쓸 수 있는 설치본을 찾지 못했습니다: %CH_ROOT%\versions 1>&2 & exit /b 1)',
    'set ELECTRON_RUN_AS_NODE=1',
    'if "%~1"=="--list" (shift & "%CH_NODE%" "%CH_TOOL%" list "%CH_ROOT%" %* & exit /b %ERRORLEVEL%)',
    '"%CH_NODE%" "%CH_TOOL%" rollback "%CH_ROOT%" %*',
    'exit /b %ERRORLEVEL%'
) | Set-Content -Path (Join-Path $BinDir 'custom-harness-rollback.cmd') -Encoding ascii

# 이전 버전은 롤백 대상이라 보존한다 (FR-4.4.1) — 정리는 current 전환 뒤에만.
# 실패해도 설치는 이미 성립했으므로 경고로 끝낸다.
$PruneArgs = @((Join-Path $Target 'tools\versions-tool.mjs'), 'prune', $Root, $BundleName)
if ($Keep -gt 0) { $PruneArgs += @('--keep', "$Keep") }
try {
    Invoke-BundleNode $PruneArgs
} catch {
    Write-Warning '[install] 이전 버전 정리 실패 — 설치 자체는 완료됨'
}

Write-Host "[install] 완료 — 실행: $BinDir\custom-harness.cmd (GUI) / custom-harness.cmd daemon status (CLI)"
Write-Host "[install] 되돌리기: $BinDir\custom-harness-rollback.cmd --list / custom-harness-rollback.cmd [버전]"
Write-Host '[install] 최초 실행 시 앱 온보딩에서 게이트웨이 주소·API 키를 입력하면 zero-config 완료'
