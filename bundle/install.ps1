# custom-harness 설치기 — Windows x64 (WBS 2.5.2·2.5.4, FR-4.3.1~3, NFR-9)
# 관리자 권한 불요, 사용자 홈 설치. 실행 정책이 스크립트를 막으면 (0.5.1 실측 반영):
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
# 순서: 체크섬 검증 → 버전 디렉토리 배치 → 오프라인 프리셋 → current junction 전환 → 진입점.
# 참고: junction 교체(제거→생성)는 POSIX 심링크 rename 과 달리 완전 원자가 아니다 —
# 교체 순간의 짧은 공백은 1차 수용 (설치 실패 시 이전 junction 은 건드리지 않음).
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

Write-Host '[install] 1/5 체크섬 검증 (FR-4.2.1 — 불일치 시 중단)'
Invoke-BundleNode @((Join-Path $Here 'tools\manifest-tool.mjs'), 'verify', $Here)

Write-Host '[install] 2/5 버전 디렉토리 배치'
$Versions = Join-Path $Root 'versions'
$Target = Join-Path $Versions $BundleName
New-Item -ItemType Directory -Force -Path $Versions | Out-Null
if ($Here -like "$Versions*") {
    $Target = $Here  # 이미 versions\ 아래 — 복사 생략
} elseif (Test-Path $Target) {
    Write-Host "[install] 동일 버전 디렉토리가 이미 존재: $Target — 기존 설치 유지, 전환만 수행"
} else {
    # 부분 복사가 노출되지 않게 partial 후 rename (NFR-8). MAX_PATH 는 매니페스트 경로가 짧아 회피
    Copy-Item -Recurse -Path $Here -Destination "$Target.partial"
    Rename-Item -Path "$Target.partial" -NewName $BundleName
}

Write-Host '[install] 3/5 오프라인 프리셋 선주입 (기존 파일 보존)'
$env:CUSTOM_HARNESS_HOME = $Root
try {
    Invoke-BundleNode @((Join-Path $Target 'tools\install-presets.mjs'))
} finally {
    Remove-Item Env:\CUSTOM_HARNESS_HOME -ErrorAction SilentlyContinue
}

Write-Host '[install] 4/5 current 전환 (junction — 0.5.1 실측 반영)'
$Current = Join-Path $Root 'current'
if (Test-Path $Current) {
    # junction 은 rmdir 로만 제거 (내용물 삭제 아님)
    (Get-Item $Current).Delete()
}
New-Item -ItemType Junction -Path $Current -Target $Target | Out-Null

Write-Host '[install] 5/5 실행 진입점 (.cmd 심 — 심링크 권한 불요)'
$BinDir = Join-Path $Root 'bin'
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
@(
    '@echo off',
    'call "%~dp0..\current\bin\custom-harness.cmd" %*'
) | Set-Content -Path (Join-Path $BinDir 'custom-harness.cmd') -Encoding ascii

Write-Host "[install] 완료 — 실행: $BinDir\custom-harness.cmd (GUI) / custom-harness.cmd daemon status (CLI)"
Write-Host '[install] 최초 실행 시 앱 온보딩에서 게이트웨이 주소·API 키를 입력하면 zero-config 완료'
