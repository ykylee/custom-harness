#!/bin/sh
# custom-harness 설치기 — macOS/Linux (WBS 2.5.2·3.1.1, FR-4.3.1~3·FR-4.4)
# 관리자 권한 불요, 사용자 홈 설치. 순서: 상태 판정 → 실행 중 확인 → 체크섬 검증 →
# 버전 디렉토리 배치 → 오프라인 프리셋 선주입 → current 심링크 원자 전환 →
# 실행 진입점 생성 → 이전 버전 정리.
# 실패 시 이전 상태 불변 — current 전환은 마지막 단계에서만 수행 (NFR-8).
#
# **업데이트는 이 스크립트를 다시 돌리는 것이다** (FR-4.4.1) — 별도 업데이트 경로를 두지
# 않는다. 그래서 판단 둘이 앞에 붙는다: 무엇을 하는 것인지(신규/업그레이드/…), 그리고
# 지금 해도 되는지(데몬이 돌면 current 를 그 밑에서 바꾸게 된다 — FR-4.4.4).
#
# 옵션: --force  실행 중인 데몬이 있어도 진행 (비대화형이라 동의를 이 플래그로 갈음)
#       --keep N 이전 버전 보존 개수 (기본 3, CUSTOM_HARNESS_KEEP_VERSIONS 로도 지정)
# 테스트 오버라이드: CUSTOM_HARNESS_ROOT (기본 ~/.custom-harness)
set -eu

FORCE=""
KEEP_ARGS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE="--force" ;;
    --keep) KEEP_ARGS="--keep $2"; shift ;;
    *) echo "[install] 알 수 없는 옵션: $1" >&2; exit 2 ;;
  esac
  shift
done

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

echo "[install] 1/7 상태 판정"
run_node "$HERE/tools/versions-tool.mjs" plan "$ROOT" "$BUNDLE_NAME"

echo "[install] 2/7 실행 중 확인 (FR-4.4.4)"
# 종료 코드 3 = 데몬 실행 중이라 중단. set -e 가 먹기 전에 직접 판정한다
if ! run_node "$HERE/tools/versions-tool.mjs" guard "$ROOT" $FORCE; then
  exit 3
fi

echo "[install] 3/7 체크섬 검증 (FR-4.2.1 — 불일치 시 중단)"
run_node "$HERE/tools/manifest-tool.mjs" verify "$HERE"

echo "[install] 4/7 버전 디렉토리 배치"
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

echo "[install] 5/7 오프라인 프리셋 선주입 (기존 파일 보존)"
CUSTOM_HARNESS_HOME="$ROOT" run_node "$TARGET/tools/install-presets.mjs"

echo "[install] 6/7 current 전환 (원자 — rename(2))"
# 셸 `mv` 로는 못 한다: `current` 가 디렉토리를 가리키는 심링크면 `mv -f` 가 목적지를
# 따라가서 새 링크를 그 디렉토리 **안으로** 옮기고 성공을 반환한다(WBS 3.1.1 실측).
# rename(2) 은 링크 자체를 원자적으로 교체한다.
run_node "$TARGET/tools/versions-tool.mjs" switch "$ROOT" "$TARGET"

echo "[install] 7/7 실행 진입점 + 이전 버전 정리"
mkdir -p "$ROOT/bin"
# 심링크가 아니라 shim — 래퍼의 \$0 기준 상대 경로가 current 경유로 풀리게 한다
cat > "$ROOT/bin/custom-harness" <<SHIM
#!/bin/sh
exec "$ROOT/current/bin/custom-harness" "\$@"
SHIM
chmod 0755 "$ROOT/bin/custom-harness"

# 롤백 진입점 (FR-4.4.2) — **current 를 거치지 않는다.** 롤백은 current 가 깨졌을 때
# 쓰는 것이라, 그 링크를 타고 실행되는 도구로는 정작 필요할 때 못 쓴다. 그래서 설치된
# 버전들을 훑어 쓸 수 있는 번들 Node 를 직접 찾는다.
cat > "$ROOT/bin/custom-harness-rollback" <<'ROLLBACK'
#!/bin/sh
# custom-harness 롤백 — current 를 이전 버전으로 되돌린다 (WBS 3.1.2, FR-4.4.2)
# 사용: custom-harness-rollback [버전]        되돌리기 (미지정 = 직전 버전)
#       custom-harness-rollback --list        설치된 버전 목록
# 세션 데이터(data/)는 버전 디렉토리 밖이라 영향받지 않는다.
set -eu
ROOT="${CUSTOM_HARNESS_ROOT:-$HOME/.custom-harness}"
NODE_BIN=""
TOOL=""
for v in "$ROOT"/versions/*; do
  [ -d "$v" ] || continue
  [ -f "$v/tools/versions-tool.mjs" ] || continue
  if [ -x "$v/app/Electron.app/Contents/MacOS/Electron" ]; then
    NODE_BIN="$v/app/Electron.app/Contents/MacOS/Electron"
  elif [ -x "$v/app/electron/electron" ]; then
    NODE_BIN="$v/app/electron/electron"
  else
    continue
  fi
  TOOL="$v/tools/versions-tool.mjs"
  break
done
if [ -z "$NODE_BIN" ]; then
  echo "[rollback] 쓸 수 있는 설치본을 찾지 못했습니다: $ROOT/versions" >&2
  exit 1
fi
if [ "${1:-}" = "--list" ]; then
  shift
  ELECTRON_RUN_AS_NODE=1 exec "$NODE_BIN" "$TOOL" list "$ROOT" "$@"
fi
ELECTRON_RUN_AS_NODE=1 exec "$NODE_BIN" "$TOOL" rollback "$ROOT" "$@"
ROLLBACK
chmod 0755 "$ROOT/bin/custom-harness-rollback"

# 이전 버전은 롤백 대상이라 보존한다 (FR-4.4.1) — 정리는 current 전환 **뒤**에만.
# 여기서 실패해도 설치는 이미 성립했으므로 경고로 끝낸다.
run_node "$TARGET/tools/versions-tool.mjs" prune "$ROOT" "$BUNDLE_NAME" $KEEP_ARGS ||
  echo "[install] 경고: 이전 버전 정리 실패 — 설치 자체는 완료됨" >&2

echo "[install] 완료 — 실행: $ROOT/bin/custom-harness (GUI) / $ROOT/bin/custom-harness daemon status (CLI)"
echo "[install] 되돌리기: $ROOT/bin/custom-harness-rollback --list / custom-harness-rollback [버전]"
echo "[install] 최초 실행 시 앱 온보딩에서 게이트웨이 주소·API 키를 입력하면 zero-config 완료"
