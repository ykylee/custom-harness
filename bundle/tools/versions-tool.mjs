#!/usr/bin/env node
// 버전 상태 판정·정리 (WBS 3.1.1, FR-4.4.1/3/4) — 두 설치기(sh·ps1)가 함께 부른다.
//
// 업데이트는 별도 기능이 아니라 **새 번들로 설치를 재수행하는 것**이다(FR-4.4.1). 그래서
// 업데이트 로직을 따로 만들지 않고 설치기에 판단 두 개를 얹는다:
//
//   ① 지금 무엇을 하는 것인가 — 신규 설치 / 업그레이드 / 동일 버전 / 다운그레이드
//   ② 지금 해도 되는가 — 데몬이 돌고 있으면 `current` 를 그 밑에서 바꾸게 된다
//
// 판단을 셸이 아니라 node 에 둔 이유: sh 와 PowerShell 양쪽에 같은 규칙을 두 번 쓰면
// 반드시 갈라진다. 설치기는 결과를 받아 **출력과 중단만** 한다.
//
// 사용:
//   versions-tool.mjs plan <root> <bundleName> [--json]      상태 판정 (exit 0)
//   versions-tool.mjs guard <root> [--force]                 실행 중 데몬 확인 (exit 3 = 중단)
//   versions-tool.mjs prune <root> <keepName> [--keep N]     오래된 버전 정리
//   versions-tool.mjs switch <root> <targetDir>              current 원자 전환 (POSIX)
//   versions-tool.mjs list <root> [--json]                   설치된 버전 목록
//   versions-tool.mjs rollback <root> [version] [--force]    이전 버전으로 되돌리기
import { readdir, readFile, rename, rm, stat, symlink, unlink } from 'node:fs/promises';
import { readlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';

/** 보존 기본값 — 롤백 대상 1개 + 여유 1개. 늘리면 디스크만 쓰고 줄이면 롤백이 막힌다 */
const DEFAULT_KEEP = 3;
/** 실행 중 데몬 때문에 중단했음을 설치기가 구분할 수 있게 하는 종료 코드 */
const EXIT_BLOCKED = 3;

const [, , command, ...rest] = process.argv;
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const positional = rest.filter((a) => !a.startsWith('--'));
const flagValue = (name) => {
  const at = rest.indexOf(name);
  return at >= 0 ? rest[at + 1] : undefined;
};

const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** `current` 가 가리키는 버전 디렉토리 이름. 없으면 undefined */
async function currentVersion(root) {
  const current = join(root, 'current');
  try {
    // 심링크(POSIX)든 junction(Windows)이든 실제 경로로 푼다
    const resolved = await realpath(current);
    return resolved.split(/[\\/]/).pop();
  } catch {
    try {
      return (await readlink(current)).split(/[\\/]/).pop();
    } catch {
      return undefined;
    }
  }
}

/** 번들 이름에서 버전만 — `custom-harness-<version>-<os>-<arch>` */
function versionOf(bundleName) {
  const match = /^custom-harness-(\d+\.\d+\.\d+[^-]*)-/.exec(bundleName ?? '');
  return match?.[1];
}

/** semver 앞 3자리만 비교. 형식이 다르면 판정을 포기한다(추측하지 않는다) */
function compareVersions(a, b) {
  const parse = (v) => v?.split('.').map((n) => Number.parseInt(n, 10));
  const [x, y] = [parse(a), parse(b)];
  if (!x || !y || x.length < 3 || y.length < 3 || [...x, ...y].some(Number.isNaN)) return undefined;
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

async function readKeepSetting(root) {
  // 우선순위: --keep > env > data/settings.json > 기본값.
  // settings.json 은 데몬과 같은 파일이지만 이 키는 **설치기만** 읽는다 — 데몬이 하지
  // 않는 일(디스크 정리)이라 데몬 설정 레지스트리에 선언하지 않는다.
  const fromFlag = flagValue('--keep');
  if (fromFlag !== undefined) return Number.parseInt(fromFlag, 10);
  const fromEnv = process.env.CUSTOM_HARNESS_KEEP_VERSIONS;
  if (fromEnv !== undefined && fromEnv !== '') return Number.parseInt(fromEnv, 10);
  try {
    const raw = JSON.parse(await readFile(join(root, 'data', 'settings.json'), 'utf8'));
    const value = raw?.update?.keepVersions;
    if (typeof value === 'number') return value;
  } catch {
    // 설정 파일 없음·파손 — 기본값으로 간다 (설치가 설정 때문에 막히면 안 된다)
  }
  return DEFAULT_KEEP;
}

async function listVersions(root) {
  try {
    return (await readdir(join(root, 'versions'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.endsWith('.partial'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

if (command === 'plan') {
  const [root, bundleName] = positional;
  const installed = await listVersions(root);
  const current = await currentVersion(root);
  const order = compareVersions(versionOf(bundleName), versionOf(current));
  const kind =
    current === undefined
      ? 'install'
      : current === bundleName
        ? 'same'
        : order === 1
          ? 'upgrade'
          : order === -1
            ? 'downgrade'
            : 'change'; // 버전 형식이 달라 비교 불가 — 방향을 추측하지 않는다
  const plan = { kind, current: current ?? null, target: bundleName, installed };
  if (flags.has('--json')) {
    console.log(JSON.stringify(plan));
  } else {
    const label = {
      install: '신규 설치',
      upgrade: '업그레이드',
      same: '동일 버전 재설치',
      downgrade: '다운그레이드',
      change: '버전 교체',
    }[kind];
    console.log(`${label}: ${current ?? '(없음)'} → ${bundleName}`);
  }
  process.exit(0);
}

if (command === 'guard') {
  // FR-4.4.4 — 실행 중이면 `current` 를 그 프로세스 밑에서 바꾸게 된다.
  const [root] = positional;
  const info = await daemonAlive(root);
  if (info === undefined) process.exit(0);
  if (flags.has('--force')) {
    console.log(`[install] 경고: 데몬 실행 중(pid=${info.pid}) — --force 로 진행합니다`);
    console.log('[install] 실행 중인 세션은 데몬과 함께 정리됩니다');
    process.exit(0);
  }
  console.error(`[install] 데몬이 실행 중입니다 (pid=${info.pid}, port=${info.port ?? '?'}).`);
  console.error('[install] 업데이트는 실행 중인 세션을 정리합니다 (FR-4.4.4).');
  console.error('[install] 먼저 종료: custom-harness daemon stop');
  console.error('[install] 그래도 진행하려면 설치기에 --force 를 주세요.');
  process.exit(EXIT_BLOCKED);
}

/** `current` 를 원자적으로 교체 — `switch`·`rollback` 이 공유한다 */
async function switchCurrent(root, target) {
  const current = join(root, 'current');
  const staging = join(root, `current.new.${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  await symlink(target, staging);
  try {
    await rename(staging, current);
  } catch (error) {
    await unlink(staging).catch(() => {});
    throw error;
  }
  // 옛 설치기가 남겼을 수 있는 잔존물 정리 — 버그의 흔적이 버전 디렉토리 안에 남는다
  await rm(join(target, 'current.new'), { recursive: true, force: true });
}

/** 살아 있는 데몬 정보. 없거나 죽었으면 undefined */
async function daemonAlive(root) {
  let info;
  try {
    info = JSON.parse(await readFile(join(root, 'data', 'daemon.pid'), 'utf8'));
  } catch {
    return undefined;
  }
  try {
    process.kill(info.pid, 0); // 신호 0 = 존재 확인만
    return info;
  } catch {
    return undefined; // 죽은 프로세스의 잔존 pid 파일
  }
}

if (command === 'switch') {
  // **셸의 `mv` 로는 못 한다** (WBS 3.1.1 실측). `current` 가 디렉토리를 가리키는
  // 심링크일 때 `mv -f new current` 는 목적지를 *따라가서* `new` 를 그 디렉토리 **안으로**
  // 옮기고 성공(0)을 반환한다 — 링크는 그대로 남고 폴백도 안 걸린다. 첫 설치에는
  // `current` 가 없어 드러나지 않았고, 업데이트 경로만 조용히 무력화돼 있었다.
  //
  // `rename(2)` 은 목적지 심링크를 따라가지 않고 **링크 자체를 원자적으로 교체**한다.
  // 설치기에 이미 node 가 있으므로(FR-4.1.3) 여기서 부른다.
  const [root, target] = positional;
  await switchCurrent(root, target);
  console.log(`[install] current → ${target}`);
  process.exit(0);
}

if (command === 'list') {
  const [root] = positional;
  const current = await currentVersion(root);
  const entries = [];
  for (const name of await listVersions(root)) {
    let mtime = 0;
    try {
      mtime = (await stat(join(root, 'versions', name))).mtimeMs;
    } catch {
      continue;
    }
    entries.push({ name, current: name === current, installedAt: new Date(mtime).toISOString() });
  }
  entries.sort((a, b) => (a.installedAt < b.installedAt ? 1 : -1));
  if (flags.has('--json')) {
    console.log(JSON.stringify({ current: current ?? null, versions: entries }));
  } else if (entries.length === 0) {
    console.log('설치된 버전 없음');
  } else {
    for (const entry of entries) {
      console.log(`${entry.current ? '*' : ' '} ${entry.name}  ${entry.installedAt}`);
    }
    console.log('\n(* = 현재 사용 중)  되돌리기: custom-harness-rollback [버전]');
  }
  process.exit(0);
}

if (command === 'rollback') {
  // FR-4.4.2 — 롤백은 `current` 를 이전 버전으로 되돌리는 **단일 조작**이다.
  // 세션 데이터는 `data/` 에 있어 버전 디렉토리 밖이므로 손대지 않는다.
  const [root, requested] = positional;
  const current = await currentVersion(root);
  const names = await listVersions(root);
  if (names.length === 0) {
    console.error('[rollback] 설치된 버전이 없습니다');
    process.exit(1);
  }

  let target = requested;
  if (target === undefined) {
    // 지정이 없으면 **직전 버전** — current 를 뺀 가장 최근 설치본.
    // 버전 번호가 아니라 설치 시각으로 고르는 이유: 다운그레이드 후 롤백이면
    // "이전"은 번호가 큰 쪽이다. 사용자가 방금 떠나온 자리로 돌아가는 것이 맞다.
    const stamped = [];
    for (const name of names) {
      if (name === current) continue;
      try {
        stamped.push({ name, mtime: (await stat(join(root, 'versions', name))).mtimeMs });
      } catch {
        /* 사라진 디렉토리는 후보가 아니다 */
      }
    }
    stamped.sort((a, b) => b.mtime - a.mtime);
    target = stamped[0]?.name;
  }
  if (target === undefined) {
    console.error(`[rollback] 되돌아갈 이전 버전이 없습니다 (현재: ${current ?? '없음'})`);
    console.error('[rollback] 설치된 버전: ' + names.join(', '));
    process.exit(1);
  }
  if (!names.includes(target)) {
    console.error(`[rollback] 그런 버전이 없습니다: ${target}`);
    console.error('[rollback] 설치된 버전: ' + names.join(', '));
    process.exit(1);
  }
  if (target === current) {
    console.log(`[rollback] 이미 ${target} 을(를) 쓰고 있습니다 — 변경 없음`);
    process.exit(0);
  }

  // 실행 중이면 `current` 를 그 프로세스 밑에서 바꾸게 된다 — 설치와 같은 규칙 (FR-4.4.4)
  if (!flags.has('--force') && (await daemonAlive(root)) !== undefined) {
    const info = await daemonAlive(root);
    console.error(`[rollback] 데몬이 실행 중입니다 (pid=${info.pid}).`);
    console.error('[rollback] 먼저 종료: custom-harness daemon stop');
    console.error('[rollback] 그래도 진행하려면 --force 를 주세요.');
    process.exit(EXIT_BLOCKED);
  }

  await switchCurrent(root, join(root, 'versions', target));
  console.log(`[rollback] ${current ?? '(없음)'} → ${target}`);
  console.log('[rollback] 세션 데이터는 버전 디렉토리 밖(data/)이라 영향 없음 (FR-4.4.2)');
  process.exit(0);
}

if (command === 'prune') {
  // FR-4.4.1 — 이전 버전 디렉토리는 보존한다(개수 설정 가능). 롤백 대상이기 때문이다.
  const [root, keepName] = positional;
  const keep = await readKeepSetting(root);
  if (!Number.isInteger(keep) || keep < 1) {
    console.log(`[install] 버전 보존 설정이 유효하지 않아 정리를 건너뜁니다: ${keep}`);
    process.exit(0);
  }
  const current = await currentVersion(root);
  const versions = await listVersions(root);
  const stamped = [];
  for (const name of versions) {
    let mtime = 0;
    try {
      mtime = (await stat(join(root, 'versions', name))).mtimeMs;
    } catch {
      continue;
    }
    stamped.push({ name, mtime });
  }
  // 최근 것부터 남긴다. 방금 설치한 것과 current 는 **절대** 지우지 않는다 —
  // 후자를 지우면 롤백이 아니라 설치 자체가 깨진다.
  stamped.sort((a, b) => b.mtime - a.mtime);
  const protectedNames = new Set([keepName, current].filter(Boolean));
  const survivors = new Set(stamped.slice(0, keep).map((v) => v.name));
  const removed = [];
  for (const { name } of stamped) {
    if (survivors.has(name) || protectedNames.has(name)) continue;
    await rm(join(root, 'versions', name), { recursive: true, force: true });
    removed.push(name);
  }
  console.log(
    removed.length === 0
      ? `[install] 버전 보존 ${keep}개 — 정리할 이전 버전 없음`
      : `[install] 버전 보존 ${keep}개 — 정리: ${removed.join(', ')}`,
  );
  process.exit(0);
}

console.error('사용법: versions-tool.mjs plan|guard|switch|list|rollback|prune ...');
process.exit(2);
