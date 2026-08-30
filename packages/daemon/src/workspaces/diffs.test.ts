// 변경사항 (WBS 6.5) — 실제 git 저장소로 검증한다.
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { DiffWatcher, commitDiff, workingDiff } from './diffs.js';

const run = promisify(execFile);
const watchers: DiffWatcher[] = [];
afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.stop();
});

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ch-diff-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await run('git', ['config', 'user.name', 'test'], { cwd: dir });
  await writeFile(join(dir, 'a.txt'), 'one\n');
  await run('git', ['add', '.'], { cwd: dir });
  await run('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('working diff', () => {
  it('미커밋 변경을 통합 diff 로 준다 (스테이지 여부를 가르지 않는다)', async () => {
    const cwd = await makeRepo();
    await writeFile(join(cwd, 'a.txt'), 'two\n');
    await run('git', ['add', 'a.txt'], { cwd }); // 스테이지해도 보여야 한다

    const diff = await workingDiff(cwd);
    expect(diff.patch).toContain('-one');
    expect(diff.patch).toContain('+two');
    expect(diff.unavailable).toBeUndefined();
  });

  it('미추적 파일을 별도로 알린다 — diff 에는 안 나오지만 사용자에겐 변경이다', async () => {
    const cwd = await makeRepo();
    await writeFile(join(cwd, 'new.txt'), 'fresh\n');

    const diff = await workingDiff(cwd);
    expect(diff.untracked).toEqual(['new.txt']);
  });

  it('변경이 없으면 빈 diff 다', async () => {
    const diff = await workingDiff(await makeRepo());
    expect(diff.patch).toBe('');
    expect(diff.untracked).toEqual([]);
  });

  it('git 이 아닌 디렉토리는 사유를 담아 돌려준다 (예외 대신)', async () => {
    const diff = await workingDiff(await mkdtemp(join(tmpdir(), 'ch-plain-')));
    expect(diff.unavailable).toBeDefined();
    expect(diff.patch).toBe('');
  });
});

describe('commit diff', () => {
  it('커밋 하나의 변경을 준다', async () => {
    const cwd = await makeRepo();
    await writeFile(join(cwd, 'a.txt'), 'two\n');
    await run('git', ['commit', '-q', '-am', 'change'], { cwd });
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd });

    const diff = await commitDiff(cwd, stdout.trim());
    expect(diff.patch).toContain('+two');
  });

  it('옵션처럼 보이는 입력은 거절한다 (인자 주입 방지)', async () => {
    const cwd = await makeRepo();
    const diff = await commitDiff(cwd, '--upload-pack=touch /tmp/pwned');
    expect(diff.unavailable).toContain('올바르지 않은');
    expect(diff.patch).toBe('');
  });

  it('없는 커밋은 사유를 담아 돌려준다', async () => {
    const diff = await commitDiff(await makeRepo(), 'deadbeef');
    expect(diff.unavailable).toBeDefined();
  });
});

describe('DiffWatcher', () => {
  it('변경이 생기면 알린다', async () => {
    const cwd = await makeRepo();
    let changes = 0;
    const watcher = new DiffWatcher(cwd, () => (changes += 1), 50);
    watchers.push(watcher);
    await watcher.start();

    await writeFile(join(cwd, 'a.txt'), 'changed\n');
    for (let i = 0; i < 40 && changes === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(changes).toBeGreaterThan(0);
  });

  it('변경이 없으면 알리지 않는다', async () => {
    const cwd = await makeRepo();
    let changes = 0;
    const watcher = new DiffWatcher(cwd, () => (changes += 1), 30);
    watchers.push(watcher);
    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(changes).toBe(0);
  });
});
