#!/bin/sh
# custom-harness 제거기 — macOS/Linux (WBS 3.5.2, FR-4.3.4)
# 기본: 프로그램(versions/·current·bin 진입점)만 제거, 사용자 데이터(data/·logs/)는 보존.
# 주입 설정 블록은 전부 data/ 아래 격리 홈(pi-home·omp-home·grok-home)에 있어
# 사용자 홈의 ~/.pi 등 외부 파일은 건드리지 않는다 (credential-injection-design §2).
# 사용:
#   ./uninstall.sh              # 프로그램만 제거 (데이터 보존)
#   ./uninstall.sh --purge      # 데이터·세션 이력까지 삭제 (대화식 확인)
#   ./uninstall.sh --purge --yes  # 확인 생략 (비대화 환경)
# 테스트 오버라이드: CUSTOM_HARNESS_ROOT (기본 ~/.custom-harness)
set -eu

ROOT="${CUSTOM_HARNESS_ROOT:-$HOME/.custom-harness}"
PURGE=0
YES=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --yes) YES=1 ;;
    *) echo "[uninstall] 알 수 없는 옵션: $arg (--purge, --yes)" >&2; exit 2 ;;
  esac
done

if [ ! -d "$ROOT" ]; then
  echo "[uninstall] 설치 없음: $ROOT"
  exit 0
fi

echo "[uninstall] 1/3 데몬 정지 (best-effort)"
if [ -x "$ROOT/current/bin/custom-harness" ]; then
  "$ROOT/current/bin/custom-harness" daemon stop >/dev/null 2>&1 || true
fi

echo "[uninstall] 2/3 프로그램 제거 (versions/·current·bin)"
rm -f "$ROOT/bin/custom-harness"
rmdir "$ROOT/bin" 2>/dev/null || true
rm -f "$ROOT/current"
rm -rf "$ROOT/versions"

echo "[uninstall] 3/3 사용자 데이터 (data/·logs/ — 세션 이력·크리덴셜·격리 홈 주입 설정)"
if [ "$PURGE" -eq 1 ]; then
  if [ "$YES" -ne 1 ]; then
    # 비가역 삭제는 별도 확인 필수 (FR-4.3.4) — 터미널이 아니면 안전하게 중단
    if [ ! -t 0 ]; then
      echo "[uninstall] 오류: 비대화 환경에서 --purge 는 --yes 가 필요" >&2
      exit 2
    fi
    printf "[uninstall] %s 의 데이터를 영구 삭제합니다. 계속하려면 'yes' 입력: " "$ROOT"
    read -r answer
    if [ "$answer" != "yes" ]; then
      echo "[uninstall] 취소 — 데이터 보존됨 ($ROOT/data, $ROOT/logs)"
      exit 1
    fi
  fi
  rm -rf "$ROOT/data" "$ROOT/logs"
  rmdir "$ROOT" 2>/dev/null || true
  echo "[uninstall] 완료 — 프로그램·데이터 전부 삭제됨"
else
  echo "[uninstall] 완료 — 프로그램 제거됨. 데이터 보존: $ROOT/data, $ROOT/logs"
  echo "[uninstall] 데이터까지 삭제하려면: ./uninstall.sh --purge"
fi
