#!/usr/bin/env node
// NFR-8 설치 무결성·원자성 스모크 (WBS 3.1.3) — **실패를 주입해서** 불변식을 확인한다.
//
// NFR-8 이 요구하는 것: "설치·업데이트 중 **어느 단계에서 실패해도** 기존 설치본과 사용자
// 데이터는 손상되지 않는다 — 심링크 전환 전까지 기존 상태 불변". 검증 방법도 못박혀 있다:
// "단계별 중단 주입(디스크 부족·권한 오류 모사)".
//
// 그래서 성공 경로를 다시 돌리지 않는다(그건 smoke:update 가 한다). 여기서는 **깨뜨린 뒤**
// 매번 같은 불변식 넷을 확인한다:
//   ① `current` 가 이전 버전을 그대로 가리킨다
//   ② 이전 버전 디렉토리가 온전하다
//   ③ 사용자 데이터(data/)가 그대로다
//   ④ 미완성 버전이 **정식 이름으로 노출되지 않는다** (`.partial` 로만 남는다)
//
// 실패 주입은 설치기에 훅을 넣지 않고 **바깥에서** 만든다 — 검증용 분기가 제품 코드에
// 들어가면 그 분기 자체가 검증되지 않은 경로가 된다.
//
// 사용: node scripts/nfr8-smoke.mjs [--bundle <경로>]
import { chmod, cp, mkdir, mkdtemp, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// ── 대상 번들 ──────────────────────────────────────────────────────────────
const bundleArg = process.argv.indexOf('--bundle');
const outDir = join(repoRoot, 'bundle', 'out');
const source =
  bundleArg >= 0
    ? process.argv[bundleArg + 1]
    : (existsSync(outDir) ? await readdir(outDir) : [])
        .filter((n) => n.startsWith('custom-harness-'))
        .map((n) => join(outDir, n))
        .find((p) => existsSync(join(p, 'install.sh')));

if (source === undefined) {
  console.log('SKIP 실제 번들 없음 (bundle/out/) — `node bundle/build-bundle.mjs` 후 재실행');
  process.exit(0);
}
console.log(`번들: ${source}\n`);

/** 작업 트리의 설치기·도구를 덧씌운다 (smoke:update 와 같은 이유 — 빌드 시점 코드를 검증하지 않는다) */
async function stageBundle(dir, name) {
  const target = join(dir, name);
  await cp(source, target, { recursive: true, verbatimSymlinks: true });
  await cp(join(repoRoot, 'bundle', 'install.sh'), join(target, 'install.sh'));
  await cp(join(repoRoot, 'bundle', 'tools'), join(target, 'tools'), { recursive: true });
  await chmod(join(target, 'install.sh'), 0o755);
  return target;
}

const install = (dir, root, args = []) =>
  new Promise((resolve) => {
    const child = spawn('sh', [join(dir, 'install.sh'), ...args], {
      env: { ...process.env, CUSTOM_HARNESS_ROOT: root },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });

/** 기준 설치 하나를 만든다 — "이전 상태"가 있어야 불변식을 볼 수 있다 */
async function baseline() {
  const root = await mkdtemp(join(tmpdir(), 'ch-nfr8-'));
  const v1 = await stageBundle(join(root, 'versions'), 'custom-harness-0.1.0-base');
  const r = await install(v1, root);
  if (r.code !== 0) throw new Error(`기준 설치 실패: ${r.out.slice(-300)}`);
  // 사용자 데이터 — 버전 디렉토리 밖이라 어떤 실패에도 손상되면 안 된다
  const sessionFile = join(root, 'data', 'sessions', 'sess-1', 'timeline.jsonl');
  await mkdir(dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, '{"seq":0}\n');
  return { root, sessionFile };
}

/** 실패 후 불변식 넷 */
async function assertIntact(label, root, sessionFile) {
  let link = '';
  try {
    link = await readlink(join(root, 'current'));
  } catch {
    /* 없으면 빈 문자열 */
  }
  check(`${label}: current 가 이전 버전 그대로`, link.endsWith('custom-harness-0.1.0-base'), link);
  check(
    `${label}: 이전 버전이 온전하다`,
    existsSync(join(root, 'versions', 'custom-harness-0.1.0-base', 'manifest.json')),
  );
  check(`${label}: 사용자 데이터가 남아 있다`, existsSync(sessionFile));
  // 미완성 설치가 정식 이름으로 노출되면 안 된다 — `.partial` 로만 남아야 한다
  const names = await readdir(join(root, 'versions')).catch(() => []);
  const exposed = names.filter(
    (n) => !n.endsWith('.partial') && n !== 'custom-harness-0.1.0-base',
  );
  const incomplete = [];
  for (const n of exposed) {
    if (!existsSync(join(root, 'versions', n, 'manifest.json'))) incomplete.push(n);
  }
  check(`${label}: 미완성 버전이 노출되지 않는다`, incomplete.length === 0, incomplete.join(','));
}

// ── 1. 체크섬 불일치 (FR-4.2.1) ────────────────────────────────────────────
console.log('1. 체크섬 불일치 — 설치를 중단해야 한다 (FR-4.2.1)');
{
  const { root, sessionFile } = await baseline();
  const stage = await mkdtemp(join(tmpdir(), 'ch-nfr8-stage-'));
  const v2 = await stageBundle(stage, 'custom-harness-0.2.0-corrupt');
  // 하네스 파일 하나를 훼손한다 — manifest 체크섬이 어긋난다
  await writeFile(join(v2, 'harnesses', 'omp', 'omp'), 'tampered');
  const r = await install(v2, root);
  check('설치가 실패한다', r.code !== 0, `code=${r.code}`);
  check('불일치를 보고한다', r.out.includes('불일치') || r.out.includes('manifest'));
  await assertIntact('체크섬', root, sessionFile);
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
  await rm(stage, { recursive: true, force: true, maxRetries: 5 });
}

// ── 2. 권한 오류 ───────────────────────────────────────────────────────────
console.log('\n2. 권한 오류 — versions/ 를 읽기 전용으로');
{
  const { root, sessionFile } = await baseline();
  const stage = await mkdtemp(join(tmpdir(), 'ch-nfr8-stage-'));
  const v2 = await stageBundle(stage, 'custom-harness-0.2.0-perm');
  await chmod(join(root, 'versions'), 0o555);
  const r = await install(v2, root);
  await chmod(join(root, 'versions'), 0o755); // 검사 전에 되돌린다
  check('설치가 실패한다', r.code !== 0, `code=${r.code}`);
  await assertIntact('권한', root, sessionFile);
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
  await rm(stage, { recursive: true, force: true, maxRetries: 5 });
}

// ── 3. 디스크 부족 (ENOSPC) ────────────────────────────────────────────────
console.log('\n3. 디스크 부족 — 작은 볼륨에 설치');
if (process.platform !== 'darwin') {
  console.log('  SKIP 램디스크 생성은 현재 darwin 경로만 구현 (linux/win 은 C-5 실기기 항목)');
} else {
  let device;
  try {
    const attached = await run('hdiutil', ['attach', '-nomount', 'ram://40960']); // 20MB
    device = attached.stdout.trim().split(/\s+/)[0];
    await run('diskutil', ['eraseVolume', 'HFS+', 'chnfr8', device]);
    const volume = '/Volumes/chnfr8';

    // 기준 설치도 못 들어가는 크기라, 여기서는 "기존 설치 없음 + 실패" 를 본다
    const root = join(volume, 'root');
    await mkdir(root, { recursive: true });
    const stage = await mkdtemp(join(tmpdir(), 'ch-nfr8-stage-'));
    const v1 = await stageBundle(stage, 'custom-harness-0.1.0-nospace');
    const r = await install(v1, root);
    check('설치가 실패한다', r.code !== 0, `code=${r.code}`);
    check('current 가 만들어지지 않았다', !existsSync(join(root, 'current')));
    const names = await readdir(join(root, 'versions')).catch(() => []);
    const exposed = names.filter((n) => !n.endsWith('.partial'));
    const incomplete = exposed.filter((n) => !existsSync(join(root, 'versions', n, 'manifest.json')));
    check('미완성 버전이 노출되지 않는다', incomplete.length === 0, incomplete.join(','));
    await rm(stage, { recursive: true, force: true, maxRetries: 5 });
  } catch (error) {
    check('램디스크 준비', false, error.message?.slice(0, 120));
  } finally {
    if (device) await run('hdiutil', ['detach', device]).catch(() => {});
  }
}

// ── 4. 단계별 중단 (SIGKILL) ───────────────────────────────────────────────
//
// 시간(300ms·1500ms…)으로 죽이면 셋 다 같은 단계(복사)에 떨어져 "단계별"이 아니다.
// 설치기가 찍는 `[install] N/7` 표시를 보고 그 단계에서 죽인다 — 결정적이고, NFR-8 이
// 요구하는 "단계별 중단 주입"에 실제로 대응한다.
//
// **전환(6/7)이 경계다.** 그 앞에서 죽으면 이전 상태가 그대로여야 하고, 그 뒤에 죽으면
// 새 상태로 이미 완결된 것이다 — NFR-8 의 "심링크 전환 전까지 기존 상태 불변"이 그 뜻이다.
console.log('\n4. 단계별 중단 — `[install] N/7` 표시를 보고 그 단계에서 SIGKILL');
{
  /** 지정한 단계 표시가 나오면 죽인다. `extraDelayMs` 로 그 단계 *안쪽*까지 들어간다 */
  const killAtStep = async (dir, root, step, extraDelayMs = 0) =>
    new Promise((resolve) => {
      const child = spawn('sh', [join(dir, 'install.sh')], {
        env: { ...process.env, CUSTOM_HARNESS_ROOT: root },
      });
      let out = '';
      let armed = false;
      const fire = () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      };
      child.stdout.on('data', (d) => {
        out += d;
        if (!armed && out.includes(`[install] ${step}/7`)) {
          armed = true;
          if (extraDelayMs > 0) setTimeout(fire, extraDelayMs);
          else fire();
        }
      });
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (code, signal) => resolve({ code, signal, armed, out }));
    });

  const cases = [
    { step: 3, label: '체크섬 검증 중', extra: 0 },
    { step: 4, label: '버전 배치 시작', extra: 0 },
    { step: 4, label: '복사 도중', extra: 2500 },
    { step: 5, label: '프리셋 주입 중', extra: 0 },
    { step: 6, label: 'current 전환 중', extra: 0 },
    { step: 7, label: '전환 뒤 (진입점·정리)', extra: 0 },
  ];

  for (const { step, label, extra } of cases) {
    const { root, sessionFile } = await baseline();
    const stage = await mkdtemp(join(tmpdir(), 'ch-nfr8-stage-'));
    const v2 = await stageBundle(stage, 'custom-harness-0.2.0-kill');
    const r = await killAtStep(v2, root, step, extra);
    const name = `중단@${step}/7 ${label}`;
    check(`${name}: 그 단계에 실제로 도달했다`, r.armed);

    let link = '';
    try {
      link = await readlink(join(root, 'current'));
    } catch {
      /* 없으면 빈 문자열 */
    }
    const onBase = link.endsWith('custom-harness-0.1.0-base');
    const onNew = link.endsWith('custom-harness-0.2.0-kill');

    if (step < 6) {
      // 전환 전 — 이전 상태가 그대로여야 한다
      await assertIntact(name, root, sessionFile);
    } else {
      // 전환 시점 이후 — 어느 쪽을 가리키든 **가리키는 것은 온전해야** 한다
      check(`${name}: current 가 온전한 버전을 가리킨다`, onBase || onNew, link);
      const pointed = onNew ? 'custom-harness-0.2.0-kill' : 'custom-harness-0.1.0-base';
      check(
        `${name}: 가리키는 버전이 완전하다`,
        existsSync(join(root, 'versions', pointed, 'manifest.json')),
      );
      check(`${name}: 사용자 데이터가 남아 있다`, existsSync(sessionFile));
      check(
        `${name}: 이전 버전이 보존된다 (롤백 대상)`,
        existsSync(join(root, 'versions', 'custom-harness-0.1.0-base', 'manifest.json')),
      );
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
    await rm(stage, { recursive: true, force: true, maxRetries: 5 });
  }
}

// ── 5. 중단 후 재시도 ──────────────────────────────────────────────────────
//
// 중단은 `versions/<name>.partial` 을 남긴다. 다음 설치가 그 위에 다시 복사하는데,
// `cp -R src dst` 는 dst 가 이미 있으면 그 **안으로** 넣는다 — 재시도가 조용히 깨진
// 설치본을 만들 수 있다. 실패 주입이 잡아야 할 것은 실패 그 자체가 아니라 **실패 뒤의 상태**다.
console.log('\n5. 중단 후 재시도 — 남은 .partial 이 다음 설치를 오염시키면 안 된다');
{
  const { root, sessionFile } = await baseline();
  const stage = await mkdtemp(join(tmpdir(), 'ch-nfr8-stage-'));
  const v2 = await stageBundle(stage, 'custom-harness-0.2.0-retry');

  // 복사 도중 죽인다 → .partial 이 남는다
  const child = spawn('sh', [join(v2, 'install.sh')], {
    env: { ...process.env, CUSTOM_HARNESS_ROOT: root },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let out = '';
  await new Promise((resolve) => {
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('[install] 4/7')) setTimeout(() => child.kill('SIGKILL'), 2500);
    });
    child.on('close', resolve);
  });
  const leftovers = (await readdir(join(root, 'versions')).catch(() => [])).filter((n) =>
    n.endsWith('.partial'),
  );
  check('중단이 .partial 을 남긴다 (전제)', leftovers.length > 0, leftovers.join(','));

  // 같은 번들로 다시 설치 — 이번엔 끝까지
  const r = await install(v2, root);
  check('재시도가 성공한다', r.code === 0, r.out.slice(-200));
  const link = await readlink(join(root, 'current')).catch(() => '');
  check('current 가 새 버전을 가리킨다', link.endsWith('custom-harness-0.2.0-retry'), link);
  // 오염되면 manifest 가 한 겹 안쪽에 들어가 최상위에 없다
  check(
    '설치본이 온전하다 (최상위 manifest)',
    existsSync(join(root, 'versions', 'custom-harness-0.2.0-retry', 'manifest.json')),
  );
  check(
    '중첩되지 않았다',
    !existsSync(
      join(root, 'versions', 'custom-harness-0.2.0-retry', 'custom-harness-0.2.0-retry'),
    ),
  );
  check('사용자 데이터가 남아 있다', existsSync(sessionFile));
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
  await rm(stage, { recursive: true, force: true, maxRetries: 5 });
}

console.log(failures === 0 ? '\nNFR-8 SMOKE PASS' : `\nNFR-8 SMOKE FAIL — ${failures}건 실패`);
process.exit(failures === 0 ? 0 : 1);
