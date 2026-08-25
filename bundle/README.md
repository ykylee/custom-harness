# bundle/ — 3 OS 오프라인 번들 파이프라인 (FR-4)

- `build-bundle.mjs` — 번들 조립 (WBS 2.5.3·2.5.4): `node bundle/build-bundle.mjs [--target darwin-arm64|linux-x64|win32-x64] [--verify]`. 선행: `npm run typecheck` + renderer `npm run build`
- `sources.json` — 조달 소스 + 고정 해시 (버전 세트 불변성). grok linux 는 x.ai CDN 미러 절차([packaging §6-1](../docs/design/packaging.md))로 자체 해시 고정
- `lib/manifest.mjs`, `tools/` — manifest 생성·검증, 오프라인 프리셋 주입 (설치기가 호출)
- `install.sh` / `install.ps1` — 설치기 (WBS 2.5.2, FR-4.3.1~3)
- `uninstall.sh` / `uninstall.ps1` — 제거기 (WBS 3.5.2, FR-4.3.4): 기본은 프로그램만 제거·데이터 보존, `--purge` 로 확인 후 전체 삭제
- `licenses-src/` — 하네스 라이선스 원문 반입본 + PROVENANCE (WBS 3.3.1, FR-4.5) — 번들 `licenses/` 로 동봉됨
- `cache/` — 고정 해시 조달물 캐시 (오프라인 재조립용, git 미추적) / `out/` — 산출물 (아카이브 + .sha256)
