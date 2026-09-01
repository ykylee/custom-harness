#!/usr/bin/env node
// 업데이트·롤백 스모크 (WBS 3.1.1, FR-4.4) — 버전 판정·보호·정리를 실제로 돌린다.
//
// 두 층으로 나눠 본다:
//   A. **도구 로직** — 합성 루트(디렉토리만)로 판정·보호·정리 규칙을 정밀하게. 번들이
//      없어도 언제나 돌아간다.
//   B. **설치기 배선** — 실제 번들이 `bundle/out/` 에 있으면 격리 루트에 진짜로 설치해
//      단계 순서·종료 코드 전달·정리 시점을 확인한다. 없으면 그 층만 건너뛴다.
//
// 사용: node scripts/update-smoke.mjs [--bundle <경로>]
import { chmod, cp, mkdir, mkdtemp, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tool = join(repoRoot, 'bundle', 'tools', 'versions-tool.mjs');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

/** versions-tool 실행 — 종료 코드도 판정 대상이라 예외로 바꾸지 않는다 */
const tools = (args, env = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [tool, ...args], {
      env: { ...process.env, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });

/** 합성 루트 — versions/ 아래 디렉토리 몇 개와 current 링크만 있으면 된다 */
async function makeRoot(versions, current) {
  const root = await mkdtemp(join(tmpdir(), 'ch-upd-'));
  for (const [index, name] of versions.entries()) {
    const dir = join(root, 'versions', name);
    await mkdir(dir, { recursive: true });
    // mtime 을 벌려 "오래된 것부터" 판정이 결정적이 되게 한다
    await writeFile(join(dir, 'marker'), name);
    const past = new Date(Date.now() - (versions.length - index) * 60_000);
    await run('touch', ['-t', stamp(past), dir]);
  }
  if (current) await run('ln', ['-s', join(root, 'versions', current), join(root, 'current')]);
  return root;
}
const stamp = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}` +
  `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;

const listVersions = async (root) => (await readdir(join(root, 'versions'))).sort();

console.log('── A. 도구 로직 (합성 루트) ──');

// plan — 무엇을 하는 것인가
{
  const fresh = await makeRoot([], undefined);
  let r = await tools(['plan', fresh, 'custom-harness-0.1.0-darwin-arm64', '--json']);
  check('신규 설치를 install 로 판정', JSON.parse(r.out).kind === 'install');

  const root = await makeRoot(['custom-harness-0.1.0-darwin-arm64'], 'custom-harness-0.1.0-darwin-arm64');
  r = await tools(['plan', root, 'custom-harness-0.2.0-darwin-arm64', '--json']);
  check('상위 버전을 upgrade 로 판정', JSON.parse(r.out).kind === 'upgrade');
  r = await tools(['plan', root, 'custom-harness-0.0.9-darwin-arm64', '--json']);
  check('하위 버전을 downgrade 로 판정', JSON.parse(r.out).kind === 'downgrade');
  r = await tools(['plan', root, 'custom-harness-0.1.0-darwin-arm64', '--json']);
  check('같은 이름을 same 으로 판정', JSON.parse(r.out).kind === 'same');
  r = await tools(['plan', root, 'custom-harness-nightly-darwin-arm64', '--json']);
  // 버전 형식이 다르면 방향을 추측하지 않는다
  check('비교 불가는 change 로 남긴다', JSON.parse(r.out).kind === 'change');
  await rm(fresh, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}

// guard — 지금 해도 되는가 (FR-4.4.4)
{
  const root = await makeRoot(['custom-harness-0.1.0-darwin-arm64'], 'custom-harness-0.1.0-darwin-arm64');
  await mkdir(join(root, 'data'), { recursive: true });

  let r = await tools(['guard', root]);
  check('pid 파일이 없으면 통과', r.code === 0);

  // 죽은 프로세스의 잔존 pid — 막을 이유가 없다
  await writeFile(join(root, 'data', 'daemon.pid'), JSON.stringify({ pid: 999999, port: 1 }));
  r = await tools(['guard', root]);
  check('죽은 pid 는 막지 않는다', r.code === 0);

  // 살아 있는 프로세스 = 실행 중
  await writeFile(join(root, 'data', 'daemon.pid'), JSON.stringify({ pid: process.pid, port: 1 }));
  r = await tools(['guard', root]);
  check('실행 중이면 종료 코드 3 으로 중단', r.code === 3, `code=${r.code}`);
  check('무엇을 해야 하는지 알려 준다', r.err.includes('daemon stop') && r.err.includes('--force'));

  r = await tools(['guard', root, '--force']);
  check('--force 가 비대화형 동의를 갈음한다', r.code === 0);
  await rm(root, { recursive: true, force: true });
}

// prune — 이전 버전은 롤백 대상이라 보존한다 (FR-4.4.1)
{
  const names = ['a', 'b', 'c', 'd', 'e'].map((s) => `custom-harness-0.1.${s === 'a' ? 0 : s.charCodeAt(0) - 97}-x`);
  const root = await makeRoot(names, names[0]); // current = 가장 오래된 것
  const target = names.at(-1);
  const r = await tools(['prune', root, target, '--keep', '2']);
  const left = await listVersions(root);
  check('보존 개수를 지킨다', r.code === 0 && left.length <= 3, `남음=${left.join(',')}`);
  check('current 는 오래돼도 지우지 않는다', left.includes(names[0]));
  check('방금 설치한 버전은 지우지 않는다', left.includes(target));
  await rm(root, { recursive: true, force: true });
}

// prune 설정 우선순위
{
  const names = Array.from({ length: 4 }, (_, i) => `custom-harness-0.1.${i}-x`);
  const root = await makeRoot(names, names.at(-1));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({ update: { keepVersions: 1 } }));
  await tools(['prune', root, names.at(-1)]);
  check('settings.json 의 보존 개수를 읽는다', (await listVersions(root)).length === 1);
  await rm(root, { recursive: true, force: true });

  const root2 = await makeRoot(names, names.at(-1));
  await mkdir(join(root2, 'data'), { recursive: true });
  await writeFile(join(root2, 'data', 'settings.json'), JSON.stringify({ update: { keepVersions: 1 } }));
  await tools(['prune', root2, names.at(-1)], { CUSTOM_HARNESS_KEEP_VERSIONS: '3' });
  check('env 가 settings.json 을 이긴다', (await listVersions(root2)).length === 3);
  await rm(root2, { recursive: true, force: true });

  const root3 = await makeRoot(names, names.at(-1));
  await tools(['prune', root3, names.at(-1)]);
  check('기본 보존은 3개', (await listVersions(root3)).length === 3);
  await rm(root3, { recursive: true, force: true });
}

// list · rollback — FR-4.4.2
{
  const names = ['custom-harness-0.1.0-x', 'custom-harness-0.2.0-x', 'custom-harness-0.3.0-x'];
  const root = await makeRoot(names, names[2]);
  let r = await tools(['list', root, '--json']);
  const listed = JSON.parse(r.out);
  check('list 가 현재 버전을 표시한다', listed.current === names[2]);
  check('list 가 최근 설치순이다', listed.versions[0].name === names[2]);

  // 지정이 없으면 직전 버전 — 번호가 아니라 **설치 시각**으로 고른다
  r = await tools(['rollback', root]);
  check('기본은 직전 버전으로 되돌린다', r.code === 0 && (await readlink(join(root, 'current'))).endsWith(names[1]));

  r = await tools(['rollback', root, names[0]]);
  check('버전을 지정할 수 있다', r.code === 0 && (await readlink(join(root, 'current'))).endsWith(names[0]));

  r = await tools(['rollback', root, names[0]]);
  check('같은 버전이면 변경 없이 성공', r.code === 0 && r.out.includes('변경 없음'));

  r = await tools(['rollback', root, 'custom-harness-9.9.9-x']);
  check('없는 버전은 오류로 알린다', r.code === 1 && r.err.includes('그런 버전이 없습니다'));

  await rm(root, { recursive: true, force: true });
}

// rollback 도 실행 중이면 막는다 (설치와 같은 규칙)
{
  const names = ['custom-harness-0.1.0-x', 'custom-harness-0.2.0-x'];
  const root = await makeRoot(names, names[1]);
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'daemon.pid'), JSON.stringify({ pid: process.pid, port: 1 }));
  let r = await tools(['rollback', root]);
  check('실행 중이면 롤백도 막는다', r.code === 3, `code=${r.code}`);
  check('current 는 그대로다', (await readlink(join(root, 'current'))).endsWith(names[1]));
  r = await tools(['rollback', root, '--force']);
  check('--force 로는 되돌린다', r.code === 0 && (await readlink(join(root, 'current'))).endsWith(names[0]));
  await rm(root, { recursive: true, force: true });
}

// 되돌아갈 곳이 없으면 그렇게 말한다
{
  const root = await makeRoot(['custom-harness-0.1.0-x'], 'custom-harness-0.1.0-x');
  const r = await tools(['rollback', root]);
  check('이전 버전이 없으면 오류로 알린다', r.code === 1 && r.err.includes('되돌아갈 이전 버전이 없습니다'));
  await rm(root, { recursive: true, force: true });
}

// ── B. 설치기 배선 (실제 번들) ─────────────────────────────────────────────
console.log('\n── B. 설치기 배선 (실제 번들) ──');
const bundleArg = process.argv.indexOf('--bundle');
const outDir = join(repoRoot, 'bundle', 'out');
const source =
  bundleArg >= 0
    ? process.argv[bundleArg + 1]
    : (existsSync(outDir) ? (await readdir(outDir)) : [])
        .filter((n) => n.startsWith('custom-harness-'))
        .map((n) => join(outDir, n))
        // 해제본만 — 아카이브(.tar.gz/.zip/.sha256)는 install.sh 가 없다.
        // 버전에 점이 있으므로 확장자로 거르지 않는다
        .find((p) => existsSync(join(p, 'install.sh')));

if (source === undefined) {
  console.log('SKIP 실제 번들 없음 (bundle/out/) — `node bundle/build-bundle.mjs` 후 재실행');
} else {
  const root = await mkdtemp(join(tmpdir(), 'ch-upd-root-'));
  const stage = await mkdtemp(join(tmpdir(), 'ch-upd-stage-'));
  console.log(`   번들: ${source}`);

  // 같은 번들을 두 이름으로 둔다 — 전환 로직은 디렉토리 이름(버전)으로 판정한다.
  // versions/ 아래에 두면 설치기가 복사를 생략하므로 605MB 복사가 한 번씩만 일어난다.
  const v1 = join(root, 'versions', 'custom-harness-0.1.0-test');
  const v2 = join(root, 'versions', 'custom-harness-0.2.0-test');
  await mkdir(join(root, 'versions'), { recursive: true });
  await cp(source, v1, { recursive: true, verbatimSymlinks: true });
  await cp(source, v2, { recursive: true, verbatimSymlinks: true });
  // 빌드 스크립트가 도구를 빠뜨리면 그 자체가 결함이다 — **빌드된 번들** 기준으로 본다
  check('번들에 versions-tool 이 동봉된다', existsSync(join(source, 'tools', 'versions-tool.mjs')));

  // 설치기·도구는 **작업 트리 것으로 덧씌운다**. 번들에 구워진 사본을 그대로 돌리면
  // 마지막 빌드 시점의 코드를 검증하게 되어, 방금 고친 설치기가 통과했는지 알 수 없다.
  // manifest 는 harnesses·app/node_modules·configTemplates 만 덮으므로 검증에 영향 없다.
  for (const v of [v1, v2]) {
    await cp(join(repoRoot, 'bundle', 'install.sh'), join(v, 'install.sh'));
    await cp(join(repoRoot, 'bundle', 'tools'), join(v, 'tools'), { recursive: true });
    await chmod(join(v, 'install.sh'), 0o755);
  }

  const install = (dir, args = []) =>
    new Promise((resolve) => {
      const child = spawn('sh', [join(dir, 'install.sh'), ...args], {
        env: { ...process.env, CUSTOM_HARNESS_ROOT: root },
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (code) => resolve({ code, out }));
    });

  let r = await install(v1);
  check('1차 설치 성공', r.code === 0, r.code === 0 ? '' : r.out.slice(-200));
  check('current 가 1차 버전을 가리킨다', (await readlink(join(root, 'current'))).endsWith('0.1.0-test'));

  r = await install(v2);
  check('업그레이드 설치 성공', r.code === 0, r.code === 0 ? '' : r.out.slice(-200));
  check('업그레이드로 판정한다', r.out.includes('업그레이드'));
  check('current 가 2차 버전으로 전환된다', (await readlink(join(root, 'current'))).endsWith('0.2.0-test'));
  check('이전 버전은 보존된다 (롤백 대상)', existsSync(v1));

  // 실행 중 보호 — 살아 있는 pid 를 심어 둔다
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'daemon.pid'), JSON.stringify({ pid: process.pid, port: 1 }));
  r = await install(v1);
  check('실행 중이면 설치가 중단된다 (종료 코드 3)', r.code === 3, `code=${r.code}`);
  check('current 는 그대로다', (await readlink(join(root, 'current'))).endsWith('0.2.0-test'));
  r = await install(v1, ['--force']);
  check('--force 로는 진행된다', r.code === 0);
  await rm(join(root, 'data', 'daemon.pid'), { force: true });

  // ── 롤백 (FR-4.4.2) ────────────────────────────────────────────────────
  await install(v2); // 다시 최신으로 올려 두고 되돌린다
  const rollbackBin = join(root, 'bin', 'custom-harness-rollback');
  check('설치기가 롤백 진입점을 깐다', existsSync(rollbackBin));

  // 세션 데이터는 버전 디렉토리 **밖**이라 롤백에 영향받지 않아야 한다
  const sessionDir = join(root, 'data', 'sessions', 'sess-1');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, 'timeline.jsonl'), '{"seq":0}\n');

  const rollback = (args = []) =>
    new Promise((resolve) => {
      const child = spawn('sh', [rollbackBin, ...args], {
        env: { ...process.env, CUSTOM_HARNESS_ROOT: root },
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (code) => resolve({ code, out }));
    });

  r = await rollback(['--list']);
  check('롤백 진입점이 버전 목록을 낸다', r.code === 0 && r.out.includes('0.1.0-test'), r.out.trim().split('\n')[0]);

  r = await rollback();
  check('단일 조작으로 되돌아간다', r.code === 0, r.out.slice(-160));
  check('current 가 이전 버전을 가리킨다', (await readlink(join(root, 'current'))).endsWith('0.1.0-test'));
  check(
    '세션 데이터는 영향받지 않는다 (FR-4.4.2)',
    existsSync(join(sessionDir, 'timeline.jsonl')),
  );

  // 롤백의 존재 이유 — current 가 깨져도 되돌릴 수 있어야 한다
  await install(v2);
  await rm(join(root, 'versions', 'custom-harness-0.2.0-test', 'app'), {
    recursive: true,
    force: true,
  });
  r = await rollback();
  check('current 가 깨져 있어도 롤백된다', r.code === 0, r.out.slice(-160));
  check('되돌린 뒤 정상 버전을 가리킨다', (await readlink(join(root, 'current'))).endsWith('0.1.0-test'));

  await rm(root, { recursive: true, force: true, maxRetries: 5 });
  await rm(stage, { recursive: true, force: true });
}

console.log(
  failures === 0 ? '\nUPDATE SMOKE PASS' : `\nUPDATE SMOKE FAIL — ${failures}건 실패`,
);
process.exit(failures === 0 ? 0 : 1);
