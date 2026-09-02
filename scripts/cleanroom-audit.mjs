#!/usr/bin/env node
// clean-room · 고지 검수 (WBS 3.3.2, NFR-4·FR-4.5) — 릴리스 전 라이선스 준수를 기계로 확인한다.
//
// NFR-4 는 두 갈래다. ① paseo(AGPL-3.0) 코드 미사용 — 참고는 저장소의 분석 문서를 매개로만
// (dev-standards §3 clean-room). ② 동봉물의 고지 의무 이행 (FR-4.5).
//
// 검수를 산문 체크리스트로 두지 않은 이유: 두 갈래 모두 **나중에 조용히 깨진다**. 의존성 한
// 줄을 추가하면 고지가 빠지고, 파일 하나를 옮겨 붙이면 clean-room 이 깨진다 — 사람이 릴리스
// 직전에 눈으로 볼 대상이 아니라 명령이어야 한다.
//
// 검사 넷:
//   ① paseo 참조 경계   — 코드 트리에 paseo 언급이 없다 (문서는 참고 매개라 허용)
//   ② copyleft 의존성   — 동봉되는 런타임 의존성에 AGPL/GPL/SSPL 계열이 없다
//   ③ 고지 완전성       — 번들에 실제로 들어간 것이 전부 NOTICE 에 있고, 원문 파일이 실재한다
//   ④ 고지 정합성       — NOTICE.md · notices.json · manifest 의 버전이 어긋나지 않는다
//
// 사용: node scripts/cleanroom-audit.mjs [--bundle <경로>]
import { readFile, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const note = (text) => console.log(`  ····      ${text}`);

// ── ① paseo 참조 경계 (NFR-4 ①) ───────────────────────────────────────────
//
// 코드에서는 한 줄도 나와서는 안 된다. 문서는 **허용이 아니라 전제**다 — clean-room 은
// "참고하지 않는다"가 아니라 "분석 문서를 매개로만 참고한다"이므로, 문서에 남은 언급이
// 오히려 경로가 문서를 거쳤다는 증거다.
const CODE_GLOBS = [
  'packages/*/src/**/*.ts',
  'packages/*/src/**/*.tsx',
  'packages/*/src/**/*.css',
  'scripts/**/*.mjs',
  'bundle/*.mjs',
  'bundle/lib/**/*.mjs',
  'bundle/tools/**/*.mjs',
  'bundle/*.sh',
  'bundle/*.ps1',
];
// 유일한 예외 — 번들 NOTICE 에 찍는 "포함하지 않는다" 고지 문구 자체
const ALLOWED_CODE_MENTION = '본 도구는 paseo(AGPL-3.0)의 코드를 포함하지 않는다';

console.log('① paseo 참조 경계 (NFR-4 ①, dev-standards §3)');
{
  const hits = [];
  const { stdout } = await run(
    'git',
    ['grep', '-n', '-i', '-I', 'paseo', '--', ...CODE_GLOBS],
    { cwd: repoRoot },
  ).catch((error) => (error.code === 1 ? { stdout: '' } : Promise.reject(error)));
  for (const line of stdout.split('\n').filter(Boolean)) {
    if (line.includes(ALLOWED_CODE_MENTION)) continue;
    hits.push(line);
  }
  check('코드 트리에 paseo 언급 없음', hits.length === 0, hits.slice(0, 5).join(' / '));

  // 참고 매개가 실재하는지 — 분석 문서가 사라지면 clean-room 의 근거도 사라진다
  for (const doc of ['docs/reference/paseo-analysis.md', 'docs/reference/paseo-service-inventory.md']) {
    check(`분석 문서 존재: ${doc}`, existsSync(join(repoRoot, doc)));
  }

  // 저장소에 paseo 소스가 반입돼 있지 않은지 (열람·복사 금지)
  const { stdout: tracked } = await run('git', ['ls-files'], { cwd: repoRoot });
  const suspicious = tracked
    .split('\n')
    .filter((p) => /paseo/i.test(p) && !p.startsWith('docs/'));
  check('저장소에 paseo 경로 산출물 없음', suspicious.length === 0, suspicious.join(' / '));
}

// ── ② copyleft 의존성 (NFR-4 ①·FR-4.5) ────────────────────────────────────
const COPYLEFT = /\b(AGPL|GPL-|GPLv|LGPL|SSPL|CC-BY-SA|EUPL)/i;
// MIT·Apache-2.0·ISC·BSD 는 고지 의무만 있고, 그 이행은 ③ 이 본다
console.log('\n② 동봉 런타임 의존성의 라이선스 (NFR-4)');
{
  const workspaceDeps = new Set();
  for (const pkg of await readdir(join(repoRoot, 'packages'))) {
    const manifestPath = join(repoRoot, 'packages', pkg, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (!name.startsWith('@custom-harness/')) workspaceDeps.add(name);
    }
  }
  const offenders = [];
  for (const name of [...workspaceDeps].sort()) {
    const depManifest = join(repoRoot, 'node_modules', name, 'package.json');
    if (!existsSync(depManifest)) {
      note(`${name}: node_modules 미설치 — 건너뜀`);
      continue;
    }
    const { license } = JSON.parse(await readFile(depManifest, 'utf8'));
    const label = typeof license === 'string' ? license : (license?.type ?? '(미기재)');
    if (COPYLEFT.test(label)) offenders.push(`${name}=${label}`);
  }
  check(
    `런타임 의존성 ${workspaceDeps.size}종에 copyleft 없음`,
    offenders.length === 0,
    offenders.join(' / '),
  );
}

// ── ③·④ 번들 고지 (FR-4.5) ────────────────────────────────────────────────
const bundleArg = process.argv.indexOf('--bundle');
const outDir = join(repoRoot, 'bundle', 'out');
const bundles =
  bundleArg >= 0
    ? [process.argv[bundleArg + 1]]
    : (existsSync(outDir) ? await readdir(outDir) : [])
        .filter((name) => name.startsWith('custom-harness-'))
        .map((name) => join(outDir, name))
        .filter((path) => existsSync(join(path, 'manifest.json')));

if (bundles.length === 0) {
  console.log('\n③④ 번들 고지 — SKIP: bundle/out/ 에 번들 없음 (`node bundle/build-bundle.mjs` 후 재실행)');
} else {
  for (const bundle of bundles) {
    const target = bundle.split('/').pop();
    console.log(`\n③ 고지 완전성 — ${target} (FR-4.5)`);
    const licensesDir = join(bundle, 'licenses');
    const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'));

    if (!existsSync(join(licensesDir, 'NOTICE.md'))) {
      check('licenses/NOTICE.md 존재', false);
      continue;
    }
    const notice = await readFile(join(licensesDir, 'NOTICE.md'), 'utf8');
    const noticesJsonPath = join(licensesDir, 'notices.json');
    const hasIndex = existsSync(noticesJsonPath);
    check('licenses/notices.json 존재 (앱 정보 화면의 표)', hasIndex);
    const components = hasIndex
      ? (JSON.parse(await readFile(noticesJsonPath, 'utf8')).components ?? [])
      : [];
    const byName = new Map(components.map((c) => [c.name, c]));

    // 실제로 동봉된 것 = 고지 대상. 하네스는 manifest 가, 의존성은 app/node_modules 가 정본이다.
    const shipped = [];
    for (const harness of manifest.harnesses ?? []) {
      shipped.push({ name: harness.name, version: harness.version, kind: '하네스' });
    }
    shipped.push({ name: 'Electron', version: manifest.electronVersion, kind: '런타임' });
    const modulesDir = join(bundle, 'app', 'node_modules');
    for (const entry of existsSync(modulesDir) ? await readdir(modulesDir) : []) {
      if (entry === '@custom-harness') continue; // 자기 코드는 고지 대상이 아니다
      if (entry.startsWith('@')) {
        for (const scoped of await readdir(join(modulesDir, entry))) {
          const pkg = JSON.parse(
            await readFile(join(modulesDir, entry, scoped, 'package.json'), 'utf8'),
          );
          shipped.push({ name: `${entry}/${scoped}`, version: pkg.version, kind: '의존성' });
        }
        continue;
      }
      const pkg = JSON.parse(await readFile(join(modulesDir, entry, 'package.json'), 'utf8'));
      shipped.push({ name: entry, version: pkg.version, kind: '의존성' });
    }

    const missing = shipped.filter((item) => !notice.includes(item.name));
    check(
      `동봉물 ${shipped.length}종이 NOTICE.md 에 전부 있음`,
      missing.length === 0,
      missing.map((m) => `${m.kind}:${m.name}`).join(' / '),
    );

    // 표가 가리키는 원문이 실재하고 비어 있지 않은지 — 경로만 적힌 고지는 고지가 아니다
    const brokenPaths = [];
    for (const component of components) {
      for (const relative of component.paths ?? []) {
        const path = join(licensesDir, relative);
        const size = existsSync(path) ? (await stat(path)).size : -1;
        if (size <= 0) brokenPaths.push(`${component.name}→${relative}`);
      }
    }
    check('고지 표의 원문 파일이 전부 실재하고 비어 있지 않음', brokenPaths.length === 0, brokenPaths.join(' / '));
    check('반입 출처 기록 존재 (PROVENANCE.md)', existsSync(join(licensesDir, 'PROVENANCE.md')));

    console.log(`④ 고지 정합성 — ${target}`);
    const drift = [];
    for (const item of shipped) {
      const component = byName.get(item.name);
      if (component === undefined) {
        drift.push(`${item.name}: notices.json 누락`);
        continue;
      }
      if (item.version !== undefined && component.version !== item.version) {
        drift.push(`${item.name}: 동봉 ${item.version} ≠ 고지 ${component.version}`);
      }
    }
    check('동봉 버전과 고지 버전이 일치', drift.length === 0, drift.join(' / '));
    // 한계 — 여기서 대조하는 것은 manifest 와 고지, 즉 **빌드가 적어 둔 두 값**이다.
    // 조달된 실물 바이너리가 그 버전인지는 조달 단계(FR-4.7)에서 봐야 하고, 지금 grok darwin 이
    // 어긋나 있다(manifest 1.0.5 vs 실물 1.0.13 — TASK-2026-08-31-main-002). 이 검사의 PASS 를
    // "고지가 실물과 같다"로 읽으면 안 된다.
    note('대조 범위: manifest ↔ 고지. 실물 바이너리 버전 대조는 FR-4.7 조달 단계의 몫');

    // NOTICE.md 표와 notices.json 은 같은 원천에서 생성된다 — 행 수가 다르면 생성기가 갈라진 것
    const rows = notice.split('\n').filter((line) => /^\| /.test(line) && !/^\|\s*-+/.test(line));
    check(
      'NOTICE.md 표와 notices.json 항목 수 일치',
      rows.length - 1 === components.length, // 헤더 한 줄 제외
      `표 ${rows.length - 1}행 vs 색인 ${components.length}항목`,
    );

    // AGPL 계열 원문이 동봉돼 있으면 clean-room 판정 자체가 흔들린다
    const copyleftNotices = components.filter((c) => COPYLEFT.test(c.license ?? ''));
    check(
      '고지된 라이선스에 copyleft 없음',
      copyleftNotices.length === 0,
      copyleftNotices.map((c) => `${c.name}=${c.license}`).join(' / '),
    );
  }
}

console.log(`\n${failures === 0 ? '전부 PASS' : `${failures}건 FAIL`}`);
process.exit(failures === 0 ? 0 : 1);
