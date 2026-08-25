# custom-harness 제거기 — Windows x64 (WBS 3.5.2, FR-4.3.4, NFR-9)
# 기본: 프로그램(versions\·current junction·bin 진입점)만 제거, 사용자 데이터(data\·logs\)는 보존.
# 주입 설정 블록은 전부 data\ 아래 격리 홈에 있어 사용자 프로필의 외부 파일은 건드리지 않는다.
# 실행 정책이 스크립트를 막으면: powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
# 사용: .\uninstall.ps1 [-Purge] [-Yes]
param(
    [switch]$Purge,
    [switch]$Yes
)
$ErrorActionPreference = 'Stop'

$Root = if ($env:CUSTOM_HARNESS_ROOT) { $env:CUSTOM_HARNESS_ROOT } else { Join-Path $env:USERPROFILE '.custom-harness' }

if (-not (Test-Path $Root)) {
    Write-Host "[uninstall] 설치 없음: $Root"
    exit 0
}

Write-Host '[uninstall] 1/3 데몬 정지 (best-effort)'
$Cli = Join-Path $Root 'current\bin\custom-harness.cmd'
if (Test-Path $Cli) {
    try { & $Cli daemon stop *> $null } catch { }
}

Write-Host '[uninstall] 2/3 프로그램 제거 (versions\·current·bin)'
$Current = Join-Path $Root 'current'
if (Test-Path $Current) {
    # junction 은 Delete() 로 링크만 제거 (대상 내용물 삭제 아님 — install.ps1 과 동일 방식)
    (Get-Item $Current).Delete()
}
$BinShim = Join-Path $Root 'bin\custom-harness.cmd'
if (Test-Path $BinShim) { Remove-Item -Force $BinShim }
$BinDir = Join-Path $Root 'bin'
if ((Test-Path $BinDir) -and -not (Get-ChildItem $BinDir)) { Remove-Item $BinDir }
$Versions = Join-Path $Root 'versions'
if (Test-Path $Versions) { Remove-Item -Recurse -Force $Versions }

Write-Host '[uninstall] 3/3 사용자 데이터 (data\·logs\ — 세션 이력·크리덴셜·격리 홈 주입 설정)'
if ($Purge) {
    if (-not $Yes) {
        # 비가역 삭제는 별도 확인 필수 (FR-4.3.4)
        $answer = Read-Host "[uninstall] $Root 의 데이터를 영구 삭제합니다. 계속하려면 'yes' 입력"
        if ($answer -ne 'yes') {
            Write-Host "[uninstall] 취소 — 데이터 보존됨 ($Root\data, $Root\logs)"
            exit 1
        }
    }
    foreach ($dir in @('data', 'logs')) {
        $path = Join-Path $Root $dir
        if (Test-Path $path) { Remove-Item -Recurse -Force $path }
    }
    if ((Test-Path $Root) -and -not (Get-ChildItem $Root)) { Remove-Item $Root }
    Write-Host '[uninstall] 완료 — 프로그램·데이터 전부 삭제됨'
} else {
    Write-Host "[uninstall] 완료 — 프로그램 제거됨. 데이터 보존: $Root\data, $Root\logs"
    Write-Host '[uninstall] 데이터까지 삭제하려면: .\uninstall.ps1 -Purge'
}
