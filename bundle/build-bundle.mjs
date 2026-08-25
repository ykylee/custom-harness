#!/usr/bin/env node
// macOS arm64 번들 프로토타입 조립 (WBS 1.7.1, FR-4.1 — 설치 스크립트는 M2, 수동 절차 문서 동봉)
// 사용: node bundle/build-bundle.mjs [--pi-source <pi 패키지 디렉토리>] [--verify] [--skip-archive]
// 전제: `npm run typecheck`(dist)와 renderer `npm run build`(dist-web)가 선행되어 있어야 한다.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const argValue = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const OS = 'darwin';
const ARCH = 'arm64';
if (process.platform !== OS || process.arch !== ARCH) {
  console.warn(`[bundle] 경고: 호스트(${process.platform}/${process.arch})가 대상과 다름 — 프로토타입은 호스트 산출물 복사 방식`);
}

const rootPackage = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
const electronPackage = JSON.parse(
  await readFile(join(repoRoot, 'node_modules/electron/package.json'), 'utf8'),
);
const bundleVersion = rootPackage.version;
const bundleName = `custom-harness-${bundleVersion}-${OS}-${ARCH}`;
const outDir = join(repoRoot, 'bundle', 'out');
const staging = join(outDir, bundleName);

// pi 동봉 소스 — 기본: 로컬 전역 설치본 (사외 빌드 파이프라인은 M2 FR-4.7)
const piSource =
  argValue('--pi-source') ?? '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent';
const piPackage = JSON.parse(await readFile(join(piSource, 'package.json'), 'utf8'));

console.log(`[bundle] ${bundleName} 조립 시작 (pi ${piPackage.version})`);
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });

// ── 결정적 디렉토리 해시 (FR-4.2 checksum) ────────────────────────────────
async function dirHash(dir) {
  const files = [];
  async function walk(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) continue; // Electron.app 프레임워크 심링크 등
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  }
  await walk(dir);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(dir, file));
    hash.update(await readFile(file));
  }
  return `sha256:${hash.digest('hex')}`;
}

// ── app/ — Electron 앱 (셸+데몬+렌더러+CLI, Node 겸용 FR-4.1.3) ───────────
const appDir = join(staging, 'app');
await cp(join(repoRoot, 'node_modules/electron/dist/Electron.app'), join(appDir, 'Electron.app'), {
  recursive: true,
  verbatimSymlinks: true,
});

const scopeDir = join(appDir, 'node_modules', '@custom-harness');
for (const [name, artifacts] of [
  ['protocol', ['dist']],
  ['daemon', ['dist']],
  ['cli', ['dist']],
  ['shell', ['dist']],
  ['renderer', ['dist-web']],
]) {
  const source = join(repoRoot, 'packages', name);
  const target = join(scopeDir, name);
  await mkdir(target, { recursive: true });
  await cp(join(source, 'package.json'), join(target, 'package.json'));
  for (const artifact of artifacts) {
    await cp(join(source, artifact), join(target, artifact), { recursive: true });
  }
}
// 런타임 외부 의존은 zod·ws 뿐 (renderer 는 사전 번들)
for (const dep of ['zod', 'ws']) {
  await cp(join(repoRoot, 'node_modules', dep), join(appDir, 'node_modules', dep), {
    recursive: true,
  });
}

// 실행 래퍼 — GUI(인자 없음) / CLI(인자 있음), Electron 내장 Node 겸용
const binDir = join(staging, 'bin');
await mkdir(binDir, { recursive: true });
await writeFile(
  join(binDir, 'custom-harness'),
  `#!/bin/sh
# custom-harness 실행 래퍼 (프로토타입) — GUI: 인자 없이 / CLI: custom-harness daemon status 등
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON="$HERE/app/Electron.app/Contents/MacOS/Electron"
export CUSTOM_HARNESS_PI_ENTRY="$HERE/harnesses/pi/dist/cli.js"
if [ $# -eq 0 ]; then
  exec "$ELECTRON" "$HERE/app/node_modules/@custom-harness/shell/dist/index.js"
fi
ELECTRON_RUN_AS_NODE=1 exec "$ELECTRON" "$HERE/app/node_modules/@custom-harness/cli/dist/index.js" "$@"
`,
  { mode: 0o755 },
);

// ── harnesses/pi/ — npm 패키지 해제본 동봉 (FR-4.1.2) ─────────────────────
const piTarget = join(staging, 'harnesses', 'pi');
await cp(piSource, piTarget, { recursive: true, verbatimSymlinks: true });

// ── config-templates/ — 주입 템플릿 (FR-2.1.4 버전 관리) ──────────────────
const templatesDir = join(staging, 'config-templates', 'pi');
await mkdir(templatesDir, { recursive: true });
await writeFile(
  join(templatesDir, 'models.json.tmpl'),
  JSON.stringify(
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
);
const templateVersion = 'pi-models-v1';

// ── licenses/ — 프로토타입 최소 NOTICE (전체 고지는 M3 FR-4.5) ────────────
await mkdir(join(staging, 'licenses'), { recursive: true });
await writeFile(
  join(staging, 'licenses', 'NOTICE.md'),
  `# NOTICE (프로토타입 — 전체 라이선스 원문 동봉은 M3 FR-4.5)

- custom-harness ${bundleVersion} (사내 도구)
- pi (@earendil-works/pi-coding-agent) ${piPackage.version} — MIT
- Electron ${electronPackage.version} — MIT (Chromium/Node 고지 포함은 M3)
- zod, ws — MIT
`,
);

// ── manifest.json (FR-4.2) ────────────────────────────────────────────────
console.log('[bundle] 체크섬 계산 중…');
const manifest = {
  bundleVersion,
  os: OS,
  arch: ARCH,
  harnesses: [
    {
      name: 'pi',
      version: piPackage.version,
      checksum: await dirHash(piTarget),
      path: 'harnesses/pi',
      entry: 'harnesses/pi/dist/cli.js',
      verifiedAt: new Date().toISOString().slice(0, 10),
    },
  ],
  app: {
    version: bundleVersion,
    // 프로토타입 범위: 자사 코드+런타임 의존만. Electron.app 은 서명·공증(M3)과 함께 재검토
    checksumScope: 'app/node_modules',
    checksum: await dirHash(join(appDir, 'node_modules')),
  },
  configTemplates: { pi: templateVersion },
  electronVersion: electronPackage.version,
};
await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));

// ── INSTALL.md — 수동 설치 절차 (FR-4.3 스크립트는 M2) ────────────────────
await writeFile(
  join(staging, 'INSTALL.md'),
  `# 수동 설치 절차 (M1 프로토타입 — 설치 스크립트는 M2)

폐쇄망 반입 후 관리자 권한 없이 사용자 홈에 설치한다 (FR-4.3.1 상당의 수동판).

1. **체크섬 검증**: 반입 절차의 아카이브 sha256 을 대조한다.
   \`shasum -a 256 ${bundleName}.tar.gz\`
2. **버전 디렉토리 해제**:
   \`mkdir -p ~/.custom-harness/versions && tar -xzf ${bundleName}.tar.gz -C ~/.custom-harness/versions/\`
3. **current 전환** (원자적 — 마지막 단계):
   \`ln -sfn ~/.custom-harness/versions/${bundleName} ~/.custom-harness/current\`
4. **실행**:
   - GUI: \`~/.custom-harness/current/bin/custom-harness\`
   - CLI: \`~/.custom-harness/current/bin/custom-harness daemon status\`
5. **최초 실행(zero-config)**: 앱 온보딩에서 게이트웨이 주소·API 키 입력 → 연결 확인 → 완료.
   게이트웨이 연결 설정은 데몬이 격리 홈(\`~/.custom-harness/data/pi-home\`)에 자동 주입한다 —
   사용자 \`~/.pi\` 는 건드리지 않는다.

제거: \`rm -rf ~/.custom-harness\` (세션 이력 포함 전체 삭제 — 선택적 보존은 M3 제거 스크립트에서).
`,
);

// ── 아카이브 ──────────────────────────────────────────────────────────────
if (!args.includes('--skip-archive')) {
  console.log('[bundle] 아카이브 생성 중…');
  execFileSync('tar', ['-czf', `${bundleName}.tar.gz`, bundleName], { cwd: outDir });
  const archive = join(outDir, `${bundleName}.tar.gz`);
  const size = (await stat(archive)).size;
  const sha = createHash('sha256').update(await readFile(archive)).digest('hex');
  console.log(`[bundle] 완료: ${archive} (${(size / 1024 / 1024).toFixed(1)}MB, sha256=${sha})`);
}

// ── 검증 모드: 해제 → 체크섬 재검증 → 번들 데몬 기동 스모크 ───────────────
if (args.includes('--verify')) {
  console.log('[bundle] 검증: 체크섬 재계산…');
  const rehash = await dirHash(join(appDir, 'node_modules'));
  if (rehash !== manifest.app.checksum) throw new Error('app 체크섬 불일치');
  const piRehash = await dirHash(piTarget);
  if (piRehash !== manifest.harnesses[0].checksum) throw new Error('pi 체크섬 불일치');

  console.log('[bundle] 검증: 번들 데몬 기동 스모크…');
  const home = await mkdtemp(join(tmpdir(), 'ch-bundle-verify-'));
  const electronBin = join(appDir, 'Electron.app/Contents/MacOS/Electron');
  const daemonEntry = join(scopeDir, 'daemon/dist/main.js');
  const cliEntry = join(scopeDir, 'cli/dist/index.js');
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    CUSTOM_HARNESS_HOME: home,
    CUSTOM_HARNESS_DAEMON_ENTRY: daemonEntry,
    CUSTOM_HARNESS_PI_ENTRY: join(staging, 'harnesses/pi/dist/cli.js'),
  };
  const run = (cmdArgs) =>
    execFileSync(electronBin, cmdArgs, { env, encoding: 'utf8', timeout: 30_000 });
  console.log(run([cliEntry, 'daemon', 'start']).trim());
  console.log(run([cliEntry, 'daemon', 'status']).trim());
  console.log(run([cliEntry, 'daemon', 'stop']).trim());
  await rm(home, { recursive: true, force: true });
  console.log('[bundle] 검증 통과 — 체크섬 일치 + 번들 데몬 기동/제어/종료 정상');
}
