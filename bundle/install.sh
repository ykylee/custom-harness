#!/bin/sh
# custom-harness 설치기 — macOS/Linux (WBS 2.5.2, FR-4.3.1~3)
# 관리자 권한 불요, 사용자 홈 설치. 순서: 체크섬 검증 → 버전 디렉토리 배치 →
# 오프라인 프리셋 선주입 → current 심링크 원자 전환 → 실행 진입점 생성.
# 실패 시 이전 상태 불변 — current 전환은 마지막 단계에서만 수행 (NFR-8).
# 테스트 오버라이드: CUSTOM_HARNESS_ROOT (기본 ~/.custom-harness)
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${CUSTOM_HARNESS_ROOT:-$HOME/.custom-harness}"
BUNDLE_NAME="$(basename "$HERE")"

# 번들 동봉 Electron 을 Node 로 겸용 (FR-4.1.3) — 별도 Node 불요
if [ -x "$HERE/app/Electron.app/Contents/MacOS/Electron" ]; then
  NODE_BIN="$HERE/app/Electron.app/Contents/MacOS/Electron"
elif [ -x "$HERE/app/electron/electron" ]; then
  NODE_BIN="$HERE/app/electron/electron"
else
  echo "[install] 오류: 번들 Electron 을 찾을 수 없음" >&2
  exit 1
fi
run_node() {
  ELECTRON_RUN_AS_NODE=1 "$NODE_BIN" "$@"
}

echo "[install] 1/5 체크섬 검증 (FR-4.2.1 — 불일치 시 중단)"
run_node "$HERE/tools/manifest-tool.mjs" verify "$HERE"

echo "[install] 2/5 버전 디렉토리 배치"
VERSIONS="$ROOT/versions"
TARGET="$VERSIONS/$BUNDLE_NAME"
mkdir -p "$VERSIONS"
case "$HERE" in
  "$VERSIONS"/*)
    TARGET="$HERE" # 이미 versions/ 아래에서 실행 중 — 복사 생략
    ;;
  *)
    if [ -e "$TARGET" ]; then
      echo "[install] 동일 버전 디렉토리가 이미 존재: $TARGET — 기존 설치 유지, 전환만 수행"
    else
      cp -R "$HERE" "$TARGET.partial"
      mv "$TARGET.partial" "$TARGET" # 부분 복사가 노출되지 않게 (NFR-8)
    fi
    ;;
esac

echo "[install] 3/5 오프라인 프리셋 선주입 (기존 파일 보존)"
CUSTOM_HARNESS_HOME="$ROOT" run_node "$TARGET/tools/install-presets.mjs"

echo "[install] 4/5 current 전환 (원자)"
ln -s "$TARGET" "$ROOT/current.new"
mv -f "$ROOT/current.new" "$ROOT/current" 2>/dev/null || {
  # 일부 플랫폼에서 mv 가 심링크 교체를 못 하면 rename 폴백
  rm -f "$ROOT/current" && mv "$ROOT/current.new" "$ROOT/current"
}

echo "[install] 5/5 실행 진입점"
mkdir -p "$ROOT/bin"
# 심링크가 아니라 shim — 래퍼의 \$0 기준 상대 경로가 current 경유로 풀리게 한다
cat > "$ROOT/bin/custom-harness" <<SHIM
#!/bin/sh
exec "$ROOT/current/bin/custom-harness" "\$@"
SHIM
chmod 0755 "$ROOT/bin/custom-harness"

echo "[install] 완료 — 실행: $ROOT/bin/custom-harness (GUI) / $ROOT/bin/custom-harness daemon status (CLI)"
echo "[install] 최초 실행 시 앱 온보딩에서 게이트웨이 주소·API 키를 입력하면 zero-config 완료"
