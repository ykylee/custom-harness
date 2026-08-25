#!/usr/bin/env node
// 3 OS 번들 빌드 파이프라인 (WBS 2.5.3·2.5.4, FR-4.1/FR-4.7 — M1 1.7.1 프로토타입 확장)
// 사용: node bundle/build-bundle.mjs [--target darwin-arm64|linux-x64|win32-x64]
//       [--verify] [--skip-archive] [--pi-source <dir>]
// 전제: `npm run typecheck`(dist)와 renderer `npm run build`(dist-web) 선행.
// 사외 빌드 환경 전제(FR-4.7): 크로스 타깃은 고정 해시(sources.json)로 조달물을 다운로드해
// bundle/cache/ 에 캐시한다 — 재실행은 캐시로 오프라인 재현 가능. 반입 산출물 = 아카이브+sha256.
// Windows 구성(2026-08-25 승인): omp + pi(조건부, C-5 실측 대기) — grok 제외.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, verifyBundle } from './lib/manifest.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const bundleDir = join(repoRoot, 'bundle');
const cacheDir = join(bundleDir, 'cache');
const args = process.argv.slice(2);
const argValue = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const hostTarget = `${process.platform}-${process.arch}`;
const target = argValue('--target') ?? hostTarget;
const TARGETS = {
  'darwin-arm64': { os: 'darwin', arch: 'arm64', electronPlatform: 'darwin-arm64' },
  'linux-x64': { os: 'linux', arch: 'x64', electronPlatform: 'linux-x64' },
  'win32-x64': { os: 'win32', arch: 'x64', electronPlatform: 'win32-x64' },
};
const targetInfo = TARGETS[target];
if (!targetInfo) throw new Error(`지원하지 않는 타깃: ${target} (${Object.keys(TARGETS).join('|')})`);
const isWindows = targetInfo.os === 'win32';
const isDarwin = targetInfo.os === 'darwin';

const rootPackage = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
const electronPackage = JSON.parse(
  await readFile(join(repoRoot, 'node_modules/electron/package.json'), 'utf8'),
);
const sources = JSON.parse(await readFile(join(bundleDir, 'sources.json'), 'utf8'));
const bundleVersion = rootPackage.version;
const bundleName = `custom-harness-${bundleVersion}-${targetInfo.os}-${targetInfo.arch}`;
const outDir = join(bundleDir, 'out');
const staging = join(outDir, bundleName);

console.log(`[bundle] ${bundleName} 조립 시작 (호스트 ${hostTarget})`);
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await mkdir(cacheDir, { recursive: true });

// ── 조달: 고정 해시 다운로드 + 캐시 (FR-4.7 재현성) ───────────────────────
function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function fetchPinned(url, expectedSha256, cacheName) {
  const cached = join(cacheDir, cacheName);
  try {
    const existing = await readFile(cached);
    if (sha256Of(existing) === expectedSha256) {
      console.log(`[bundle] 캐시 사용: ${cacheName}`);
      return cached;
    }
    console.warn(`[bundle] 캐시 해시 불일치 — 재다운로드: ${cacheName}`);
  } catch {
    /* 캐시 없음 */
  }
  console.log(`[bundle] 다운로드: ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`다운로드 실패 (${response.status}): ${url}`);
  const body = Buffer.from(await response.arrayBuffer());
  const actual = sha256Of(body);
  if (expectedSha256 && actual !== expectedSha256) {
    throw new Error(`해시 불일치: ${url}\n  기대 ${expectedSha256}\n  실제 ${actual}`);
  }
  await writeFile(cached, body);
  return cached;
}

/** Electron 공식 릴리스 zip — SHASUMS256.txt 로 해시 확정 후 fetchPinned */
async function fetchElectronZip() {
  const version = electronPackage.version;
  const zipName = `electron-v${version}-${targetInfo.electronPlatform}.zip`;
  const base = `https://github.com/electron/electron/releases/download/v${version}`;
  const shasumsCache = join(cacheDir, `electron-v${version}-SHASUMS256.txt`);
  let shasums;
  try {
    shasums = await readFile(shasumsCache, 'utf8');
  } catch {
    const response = await fetch(`${base}/SHASUMS256.txt`, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Electron SHASUMS 다운로드 실패 (${response.status})`);
    shasums = await response.text();
    await writeFile(shasumsCache, shasums);
  }
  const line = shasums.split('\n').find((l) => l.trim().endsWith(`*${zipName}`));
  if (!line) throw new Error(`SHASUMS256.txt 에 ${zipName} 없음`);
  const expected = line.trim().split(/\s+/)[0];
  return fetchPinned(`${base}/${zipName}`, expected, zipName);
}

// ── app/ — Electron (셸+데몬+렌더러+CLI, Node 겸용 FR-4.1.3) ──────────────
const appDir = join(staging, 'app');
if (isDarwin && hostTarget === target) {
  // 호스트 산출물 직접 복사 (M1 방식) — 사외 빌드에서도 darwin 은 zip 경로 사용 가능
  await cp(join(repoRoot, 'node_modules/electron/dist/Electron.app'), join(appDir, 'Electron.app'), {
    recursive: true,
    verbatimSymlinks: true,
  });
} else {
  const zip = await fetchElectronZip();
  const extractTo = join(appDir, isDarwin ? '.' : 'electron');
  await mkdir(extractTo, { recursive: true });
  // unzip: 심링크·실행권한 보존 (macOS/린uxCI 공통 가용)
  execFileSync('unzip', ['-q', zip, '-d', extractTo]);
}

const scopeDir = join(appDir, 'node_modules', '@custom-harness');
for (const [name, artifacts] of [
  ['protocol', ['dist']],
  ['daemon', ['dist']],
  ['cli', ['dist']],
  ['shell', ['dist']],
  ['renderer', ['dist-web']],
]) {
  const source = join(repoRoot, 'packages', name);
  const packageTarget = join(scopeDir, name);
  await mkdir(packageTarget, { recursive: true });
  await cp(join(source, 'package.json'), join(packageTarget, 'package.json'));
  for (const artifact of artifacts) {
    await cp(join(source, artifact), join(packageTarget, artifact), { recursive: true });
  }
}
// 런타임 외부 의존 — 전부 무의존 패키지 (renderer 는 사전 번들)
const RUNTIME_DEPS = ['zod', 'ws', 'yaml', 'smol-toml'];
for (const dep of RUNTIME_DEPS) {
  await cp(join(repoRoot, 'node_modules', dep), join(appDir, 'node_modules', dep), {
    recursive: true,
  });
}

// ── harnesses/ ────────────────────────────────────────────────────────────
const manifestHarnesses = [];
const wrapperEnv = []; // [envName, 번들 상대 경로]

// pi — npm 패키지 해제본 (Windows 는 조건부 동봉 — C-5 실측 대기, sources.json 주기)
{
  const piSource = argValue('--pi-source') ?? sources.pi.localDir;
  const piPackage = JSON.parse(await readFile(join(piSource, 'package.json'), 'utf8'));
  if (piPackage.version !== sources.pi.version) {
    console.warn(
      `[bundle] 경고: pi 로컬 버전(${piPackage.version}) ≠ sources 고정(${sources.pi.version})`,
    );
  }
  const piTarget = join(staging, 'harnesses', 'pi');
  await cp(piSource, piTarget, { recursive: true, verbatimSymlinks: true });
  manifestHarnesses.push({
    name: 'pi',
    version: piPackage.version,
    kind: 'dir',
    path: 'harnesses/pi',
    entry: 'harnesses/pi/dist/cli.js',
  });
  wrapperEnv.push(['CUSTOM_HARNESS_PI_ENTRY', 'harnesses/pi/dist/cli.js']);
  if (isWindows) console.warn(`[bundle] 주의: ${sources.pi.windowsNote}`);
}

// omp — 릴리스 바이너리 (고정 해시)
{
  const asset = sources.omp.assets[target];
  const binary = await fetchPinned(asset.url, asset.sha256, `omp-${sources.omp.version}-${target}`);
  const ompDir = join(staging, 'harnesses', 'omp');
  await mkdir(ompDir, { recursive: true });
  const binaryPath = join(ompDir, asset.binaryName);
  await cp(binary, binaryPath);
  await chmod(binaryPath, 0o755);
  manifestHarnesses.push({
    name: 'omp',
    version: sources.omp.version,
    kind: 'file',
    path: `harnesses/omp/${asset.binaryName}`,
  });
  wrapperEnv.push(['CUSTOM_HARNESS_OMP_PATH', `harnesses/omp/${asset.binaryName}`]);
}

// grok — darwin 은 로컬 실측 바이너리, linux 는 CDN 미러 절차 미확정, Windows 는 제외 결정
{
  const asset = sources.grok.assets[target];
  if (asset?.unavailable) {
    console.warn(`[bundle] grok 제외: ${asset.unavailable}`);
  } else if (asset) {
    const source = asset.localFile
      ? asset.localFile.replace(/^~/, homedir())
      : await fetchPinned(asset.url, asset.sha256, `grok-${sources.grok.version}-${target}`);
    const grokDir = join(staging, 'harnesses', 'grok');
    await mkdir(grokDir, { recursive: true });
    const binaryPath = join(grokDir, asset.binaryName);
    await cp(source, binaryPath);
    await chmod(binaryPath, 0o755);
    manifestHarnesses.push({
      name: 'grok',
      version: sources.grok.version,
      kind: 'file',
      path: `harnesses/grok/${asset.binaryName}`,
    });
    wrapperEnv.push(['CUSTOM_HARNESS_GROK_PATH', `harnesses/grok/${asset.binaryName}`]);
  }
}

// ── config-templates/ — 주입 템플릿·프리셋 (FR-2.1.4 버전 관리) ───────────
const templates = {
  'pi/models.json.tmpl': JSON.stringify(
    {
      providers: {
        gateway: {
          baseUrl: '${GATEWAY_BASE_URL}',
          api: 'openai-completions',
          apiKey: '$CUSTOM_HARNESS_GATEWAY_KEY',
          authHeader: true,
          models: [{ id: '${GATEWAY_MODEL_ID}' }],
        },
      },
    },
    null,
    2,
  ),
  // omp: apiKey 는 bare env 변수명 (17.3.8 실측 — omp-injection 과 동일)
  'omp/models.yml.tmpl': [
    'providers:',
    '  gateway:',
    '    baseUrl: ${GATEWAY_BASE_URL}',
    '    api: openai-completions',
    '    apiKey: CUSTOM_HARNESS_GATEWAY_KEY',
    '    authHeader: true',
    '    models:',
    '      - id: ${GATEWAY_MODEL_ID}',
    '',
  ].join('\n'),
  'omp/config.yml.preset': [
    'startup:',
    '  checkUpdate: false',
    'marketplace:',
    '  autoUpdate: false',
    'dev:',
    '  autoqa: false',
    '  autoqaConsent: denied',
    '',
  ].join('\n'),
  // grok: env_key 참조 + 오프라인 3스위치 (1.0.5 실측 — grok-injection 과 동일)
  'grok/config.toml.tmpl': [
    '[cli]',
    'auto_update = false',
    '',
    '[features]',
    'telemetry = false',
    'remote_fetch = false',
    'managed_config = false',
    '',
    '[models]',
    'default = "${GATEWAY_MODEL_ID}"',
    'web_search = "${GATEWAY_MODEL_ID}"',
    '',
    '[model."${GATEWAY_MODEL_ID}"]',
    'model = "${GATEWAY_MODEL_ID}"',
    'base_url = "${GATEWAY_BASE_URL}"',
    'api_backend = "chat_completions"',
    'env_key = "CUSTOM_HARNESS_GATEWAY_KEY"',
    '',
  ].join('\n'),
};
for (const [path, content] of Object.entries(templates)) {
  const full = join(staging, 'config-templates', path);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
}
const configTemplates = { pi: 'pi-models-v1', omp: 'omp-models-v1', grok: 'grok-config-v1' };

// ── 설치기 + 도구 동봉 (FR-4.3) ───────────────────────────────────────────
await cp(join(bundleDir, 'lib'), join(staging, 'lib'), { recursive: true });
await cp(join(bundleDir, 'tools'), join(staging, 'tools'), { recursive: true });
if (isWindows) {
  await cp(join(bundleDir, 'install.ps1'), join(staging, 'install.ps1'));
  await cp(join(bundleDir, 'uninstall.ps1'), join(staging, 'uninstall.ps1'));
} else {
  for (const script of ['install.sh', 'uninstall.sh']) {
    await cp(join(bundleDir, script), join(staging, script));
    await chmod(join(staging, script), 0o755);
  }
}

// ── 실행 래퍼 — GUI(인자 없음) / CLI(인자 있음) ───────────────────────────
const binDir = join(staging, 'bin');
await mkdir(binDir, { recursive: true });
if (isWindows) {
  await writeFile(
    join(binDir, 'custom-harness.cmd'),
    [
      '@echo off',
      'rem custom-harness 실행 래퍼 — GUI: 인자 없이 / CLI: custom-harness daemon status 등',
      'setlocal',
      'set "HERE=%~dp0.."',
      'set "ELECTRON=%HERE%\\app\\electron\\electron.exe"',
      ...wrapperEnv.map(
        ([name, path]) => `set "${name}=%HERE%\\${path.split('/').join('\\')}"`,
      ),
      'set "CUSTOM_HARNESS_MANIFEST=%HERE%\\manifest.json"',
      'if "%~1"=="" (',
      '  "%ELECTRON%" "%HERE%\\app\\node_modules\\@custom-harness\\shell\\dist\\index.js"',
      ') else (',
      '  set ELECTRON_RUN_AS_NODE=1',
      '  "%ELECTRON%" "%HERE%\\app\\node_modules\\@custom-harness\\cli\\dist\\index.js" %*',
      ')',
    ].join('\r\n'),
  );
} else {
  const electronPath = isDarwin
    ? 'app/Electron.app/Contents/MacOS/Electron'
    : 'app/electron/electron';
  await writeFile(
    join(binDir, 'custom-harness'),
    `#!/bin/sh
# custom-harness 실행 래퍼 — GUI: 인자 없이 / CLI: custom-harness daemon status 등
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON="$HERE/${electronPath}"
${wrapperEnv.map(([name, path]) => `export ${name}="$HERE/${path}"`).join('\n')}
export CUSTOM_HARNESS_MANIFEST="$HERE/manifest.json"
if [ $# -eq 0 ]; then
  exec "$ELECTRON" "$HERE/app/node_modules/@custom-harness/shell/dist/index.js"
fi
ELECTRON_RUN_AS_NODE=1 exec "$ELECTRON" "$HERE/app/node_modules/@custom-harness/cli/dist/index.js" "$@"
`,
    { mode: 0o755 },
  );
}

// ── licenses/ — NOTICE + 전체 원문 동봉 (WBS 3.3.1, FR-4.5·NFR-4) ─────────
// 하네스 원문은 licenses-src/ 반입본(PROVENANCE.md 에 출처·해시), Electron·의존성은
// 로컬 node_modules 에서 직접 수집. 타깃에 실제 동봉된 하네스만 고지한다.
const HARNESS_LICENSES = {
  pi: { license: 'MIT', src: 'pi-LICENSE.txt' },
  omp: { license: 'MIT', src: 'omp-LICENSE.txt' },
  grok: { license: 'Apache-2.0', src: 'grok-LICENSE.txt' },
};
const licensesDir = join(staging, 'licenses');
const noticeRows = [];

for (const h of manifestHarnesses) {
  const entry = HARNESS_LICENSES[h.name];
  if (!entry) throw new Error(`라이선스 미등록 하네스: ${h.name} — HARNESS_LICENSES 에 추가 필요`);
  await mkdir(join(licensesDir, h.name), { recursive: true });
  await cp(join(bundleDir, 'licenses-src', entry.src), join(licensesDir, h.name, 'LICENSE'));
  noticeRows.push([h.name, h.version, entry.license, `licenses/${h.name}/LICENSE`]);
}

// Electron — 자체 MIT + Chromium/Node 서드파티 고지(dist 동봉 원문)
await mkdir(join(licensesDir, 'electron'), { recursive: true });
await cp(join(repoRoot, 'node_modules/electron/LICENSE'), join(licensesDir, 'electron', 'LICENSE'));
await cp(
  join(repoRoot, 'node_modules/electron/dist/LICENSES.chromium.html'),
  join(licensesDir, 'electron', 'LICENSES.chromium.html'),
);
noticeRows.push([
  'Electron',
  electronPackage.version,
  'MIT (+ Chromium/Node 고지)',
  'licenses/electron/LICENSE · licenses/electron/LICENSES.chromium.html',
]);

// 런타임 의존성 — app/node_modules 로 동봉되는 패키지의 원문·라이선스명 수집
for (const dep of RUNTIME_DEPS) {
  const depPackage = JSON.parse(
    await readFile(join(repoRoot, 'node_modules', dep, 'package.json'), 'utf8'),
  );
  await mkdir(join(licensesDir, 'deps', dep), { recursive: true });
  await cp(join(repoRoot, 'node_modules', dep, 'LICENSE'), join(licensesDir, 'deps', dep, 'LICENSE'));
  noticeRows.push([dep, depPackage.version, depPackage.license, `licenses/deps/${dep}/LICENSE`]);
}

await cp(join(bundleDir, 'licenses-src', 'PROVENANCE.md'), join(licensesDir, 'PROVENANCE.md'));
await writeFile(
  join(licensesDir, 'NOTICE.md'),
  `# NOTICE — custom-harness ${bundleVersion} (${targetInfo.os}-${targetInfo.arch})

custom-harness 는 사내 배포용 오케스트레이션 도구이며, 아래 오픈소스 소프트웨어를 동봉한다.
각 원문은 표의 경로에, 반입 출처·해시는 PROVENANCE.md 에 있다.

| 동봉물 | 버전 | 라이선스 | 원문 |
|---|---|---|---|
${noticeRows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} |`).join('\n')}

- pi 하네스는 npm 패키지에 자체 의존성(node_modules)을 동봉한 형태 그대로 재배포한다 — 개별 고지는 패키지 내 각 LICENSE 파일 참조.
${
  manifestHarnesses.some((h) => h.name === 'grok')
    ? '- grok build upstream(xai-org/grok-build)에는 NOTICE 파일이 없음(2026-08-25 확인) — Apache-2.0 §4(d) 승계 대상 없음, 원문 LICENSE 동봉으로 충족.\n'
    : ''
}- 본 도구는 paseo(AGPL-3.0)의 코드를 포함하지 않는다 (패턴 참고만, NFR-4 clean-room).
`,
);

// ── manifest.json (FR-4.2 — lib/manifest.mjs 스키마) ──────────────────────
console.log('[bundle] 체크섬 계산 중…');
const manifest = await buildManifest(staging, {
  bundleVersion,
  os: targetInfo.os,
  arch: targetInfo.arch,
  harnesses: manifestHarnesses,
  configTemplates,
  electronVersion: electronPackage.version,
  verifiedAt: new Date().toISOString().slice(0, 10),
});
await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));

// ── INSTALL.md — 스크립트 안내 (수동 절차는 폴백) ─────────────────────────
await writeFile(
  join(staging, 'INSTALL.md'),
  `# 설치 절차 (M2 — 설치 스크립트, FR-4.3)

폐쇄망 반입 후 관리자 권한 없이 사용자 홈에 설치한다.

1. 반입 절차의 아카이브 sha256 대조 후 해제.
2. 설치 스크립트 실행:
   - macOS/Linux: \`./install.sh\`
   - Windows: \`powershell -ExecutionPolicy Bypass -File .\\install.ps1\`
   스크립트가 체크섬 검증 → 버전 디렉토리 배치 → 오프라인 프리셋 → current 전환(원자) →
   실행 진입점 생성을 수행한다. 실패 시 기존 설치는 변경되지 않는다.
3. 실행: \`~/.custom-harness/bin/custom-harness\` (GUI) / \`… daemon status\` (CLI)
4. 최초 실행(zero-config): 앱 온보딩에서 게이트웨이 주소·API 키 입력 → 연결 확인 → 완료.

수동 설치(폴백): 해제본을 \`~/.custom-harness/versions/${bundleName}\` 로 옮기고
\`ln -sfn\` (Windows: junction) 으로 \`current\` 전환 후 \`bin/custom-harness\` 실행.

## 제거 (FR-4.3.4)

- macOS/Linux: \`./uninstall.sh\` / Windows: \`powershell -ExecutionPolicy Bypass -File .\\uninstall.ps1\`
- 기본은 프로그램만 제거하고 사용자 데이터(\`~/.custom-harness/data\`·\`logs\` — 세션 이력·크리덴셜)는 보존한다.
- 데이터까지 삭제: \`--purge\` (Windows: \`-Purge\`) — 대화식 확인 후 삭제, 비대화 환경은 \`--yes\`(\`-Yes\`) 병행.

## 라이선스 고지 (FR-4.5)

동봉 오픈소스 목록·원문은 \`licenses/NOTICE.md\` 와 \`licenses/\` 하위 원문 파일 참조.
`,
);

// ── 아카이브 (darwin/linux: tar.gz, win: zip) ─────────────────────────────
if (!args.includes('--skip-archive')) {
  console.log('[bundle] 아카이브 생성 중…');
  const archiveName = isWindows ? `${bundleName}.zip` : `${bundleName}.tar.gz`;
  if (isWindows) {
    execFileSync('zip', ['-qry', archiveName, bundleName], { cwd: outDir });
  } else {
    execFileSync('tar', ['-czf', archiveName, bundleName], { cwd: outDir });
  }
  const archive = join(outDir, archiveName);
  const size = (await stat(archive)).size;
  const sha = sha256Of(await readFile(archive));
  await writeFile(`${archive}.sha256`, `${sha}  ${archiveName}\n`);
  console.log(`[bundle] 완료: ${archive} (${(size / 1024 / 1024).toFixed(1)}MB, sha256=${sha})`);
}

// ── 검증 모드: manifest 재검증 + (호스트 타깃) 데몬 기동 스모크 ────────────
if (args.includes('--verify')) {
  console.log('[bundle] 검증: manifest 대조…');
  const result = await verifyBundle(staging);
  if (!result.ok) {
    for (const m of result.mismatches) console.error(`[bundle] 불일치: ${m.target}`);
    throw new Error('manifest 검증 실패');
  }
  if (target === hostTarget && isDarwin) {
    console.log('[bundle] 검증: 번들 데몬 기동 스모크…');
    const home = await mkdtemp(join(tmpdir(), 'ch-bundle-verify-'));
    const electronBin = join(appDir, 'Electron.app/Contents/MacOS/Electron');
    const cliEntry = join(scopeDir, 'cli/dist/index.js');
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      CUSTOM_HARNESS_HOME: home,
      CUSTOM_HARNESS_DAEMON_ENTRY: join(scopeDir, 'daemon/dist/main.js'),
      CUSTOM_HARNESS_PI_ENTRY: join(staging, 'harnesses/pi/dist/cli.js'),
      CUSTOM_HARNESS_OMP_PATH: join(staging, 'harnesses/omp/omp'),
      CUSTOM_HARNESS_GROK_PATH: join(staging, 'harnesses/grok/grok'),
      CUSTOM_HARNESS_MANIFEST: join(staging, 'manifest.json'),
    };
    const run = (cmdArgs) =>
      execFileSync(electronBin, cmdArgs, { env, encoding: 'utf8', timeout: 30_000 });
    console.log(run([cliEntry, 'daemon', 'start']).trim());
    console.log(run([cliEntry, 'daemon', 'status']).trim());
    console.log(run([cliEntry, 'daemon', 'stop']).trim());
    await rm(home, { recursive: true, force: true });
    console.log('[bundle] 검증 통과 — manifest 일치 + 번들 데몬 기동/제어/종료 정상');
  } else {
    console.log(`[bundle] 검증 통과 — manifest 일치 (실행 스모크는 ${target} 실기기에서, NFR-9)`);
  }
}
