// CLI 워크스페이스 명령 (M7 WBS 7.5.2, FR-9.6) — 실제 데몬 + git 저장소로 왕복시킨다.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAdapter, startDaemon, type DaemonHandle } from '@custom-harness/daemon';
import { runCli } from './commands.js';
import type { CliIo } from './io.js';

const run = promisify(execFile);

interface CapturedIo extends CliIo {
  lines: string[];
  errors: string[];
  chunks: string[];
}

function captureIo(): CapturedIo {
  const lines: string[] = [];
  const errors: string[] = [];
  const chunks: string[] = [];
  return {
    lines,
    errors,
    chunks,
    out: (l) => lines.push(l),
    write: (c) => chunks.push(c),
    err: (l) => errors.push(l),
  };
}

describe('CLI 워크스페이스 명령 (M7 7.5.2, FR-9.6)', () => {
  const savedEnv = { ...process.env };
  let daemon: DaemonHandle;
  let home: string;
  let repo: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ch-cli-ws-'));
    repo = await mkdtemp(join(tmpdir(), 'ch-cli-repo-'));
    await run('git', ['init', '-b', 'main'], { cwd: repo });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    await run('git', ['config', 'user.name', 'test'], { cwd: repo });
    await writeFile(join(repo, 'README.md'), '# repo\n');
    await run('git', ['add', '.'], { cwd: repo });
    await run('git', ['commit', '-m', 'init'], { cwd: repo });

    process.env.CUSTOM_HARNESS_HOME = home;
    daemon = await startDaemon({
      root: home,
      version: '0.1.0',
      managedBy: 'test',
      adapters: [new MockAdapter()],
    });
  });

  afterEach(async () => {
    await daemon.stop();
    process.env = { ...savedEnv };
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  });

  it('--root 로 프로젝트를 열어 만든다 — 스크립트는 디렉토리를 알지 projectId 를 모른다', async () => {
    const io = captureIo();
    expect(await runCli(['workspace', 'new', '--root', repo, '--name', '작업1'], io)).toBe(0);
    const workspaceId = io.lines[0] as string;
    expect(workspaceId).toMatch(/\S/);

    const list = captureIo();
    await runCli(['workspace', 'list', '--json'], list);
    const parsed = JSON.parse(list.lines[0] as string) as {
      workspaces: { id: string; displayName: string }[];
    };
    expect(parsed.workspaces.find((w) => w.id === workspaceId)?.displayName).toBe('작업1');
  });

  it('--project 도 --root 도 없으면 사용법 오류다', async () => {
    const io = captureIo();
    expect(await runCli(['workspace', 'new'], io)).toBe(2);
    expect(io.errors.join('\n')).toContain('--project 또는 --root');
  });

  it('--isolation 값을 검증한다', async () => {
    const io = captureIo();
    expect(await runCli(['workspace', 'new', '--root', repo, '--isolation', 'bogus'], io)).toBe(2);
    expect(io.errors.join('\n')).toContain('directory 또는 worktree');
  });

  it('worktree 격리 워크스페이스를 만든다 — 새 브랜치는 --base-branch 로 분기한다', async () => {
    const io = captureIo();
    expect(
      await runCli(
        [
          'workspace',
          'new',
          '--root',
          repo,
          '--isolation',
          'worktree',
          '--branch',
          'feat/cli',
          '--base-branch',
          'main',
        ],
        io,
      ),
    ).toBe(0);
    const list = captureIo();
    await runCli(['workspace', 'list', '--json'], list);
    const parsed = JSON.parse(list.lines[0] as string) as {
      workspaces: { id: string; isolation: string; branch?: string }[];
    };
    const created = parsed.workspaces.find((w) => w.id === io.lines[0]);
    expect(created?.isolation).toBe('worktree');
    expect(created?.branch).toBe('feat/cli');
  });

  it('목록은 기본적으로 아카이브된 것을 숨긴다', async () => {
    const io = captureIo();
    await runCli(['workspace', 'new', '--root', repo], io);
    const workspaceId = io.lines[0] as string;
    expect(await runCli(['workspace', 'archive', workspaceId], captureIo())).toBe(0);

    const hidden = captureIo();
    await runCli(['workspace', 'list'], hidden);
    expect(hidden.lines.join('\n')).not.toContain(workspaceId);

    const shown = captureIo();
    await runCli(['workspace', 'list', '--all'], shown);
    expect(shown.lines.join('\n')).toContain(workspaceId);
  });

  it('활성 세션이 있으면 아카이브를 막는다', async () => {
    const created = captureIo();
    await runCli(['workspace', 'new', '--root', repo], created);
    const workspaceId = created.lines[0] as string;

    const sessionIo = captureIo();
    await runCli(
      ['session', 'new', '--harness', 'mock', '--cwd', repo, '--workspace', workspaceId],
      sessionIo,
    );

    const blocked = captureIo();
    // 돌고 있는 작업을 모른 채 정리하지 않는다
    expect(await runCli(['workspace', 'archive', workspaceId], blocked)).toBe(1);
    expect(blocked.errors.join('\n')).toContain('--force');
    expect(blocked.errors.join('\n')).toContain(sessionIo.lines[0] as string);

    // --force 가 비대화형 확인을 갈음한다 (daemon stop 과 같은 규약)
    expect(await runCli(['workspace', 'archive', workspaceId, '--force'], captureIo())).toBe(0);
  });

  it('닫힌 세션만 있으면 그냥 아카이브된다', async () => {
    const created = captureIo();
    await runCli(['workspace', 'new', '--root', repo], created);
    const workspaceId = created.lines[0] as string;
    const sessionIo = captureIo();
    await runCli(
      ['session', 'new', '--harness', 'mock', '--cwd', repo, '--workspace', workspaceId],
      sessionIo,
    );
    await runCli(['session', 'close', sessionIo.lines[0] as string], captureIo());

    expect(await runCli(['workspace', 'archive', workspaceId], captureIo())).toBe(0);
  });

  it('관리 밖 체크아웃은 --remove-checkout 으로도 지우지 않는다', async () => {
    // 데몬 쪽 방어 — 사용자 자기 디렉토리를 CLI 한 줄로 날릴 수 없어야 한다
    const created = captureIo();
    await runCli(['workspace', 'new', '--root', repo, '--isolation', 'directory'], created);
    const io = captureIo();
    expect(
      await runCli(['workspace', 'archive', created.lines[0] as string, '--remove-checkout'], io),
    ).toBe(1);
    expect(io.errors.join('\n')).toContain('관리 밖 체크아웃');
  });

  it('없는 브랜치를 --base-branch 없이 주면 무엇을 고칠지 알려 준다', async () => {
    // git 의 `invalid reference` 만으로는 스크립트 작성자가 원인을 못 짚는다
    const io = captureIo();
    expect(
      await runCli(
        ['workspace', 'new', '--root', repo, '--isolation', 'worktree', '--branch', 'feat/none'],
        io,
      ),
    ).toBe(1);
    expect(io.errors.join('\n')).toContain('--base-branch');
  });

  it('알 수 없는 하위명령은 사용법과 종료 코드 2', async () => {
    const io = captureIo();
    expect(await runCli(['workspace', 'bogus'], io)).toBe(2);
    expect(io.errors.join('\n')).toContain('워크스페이스 (FR-9.6)');
  });
});
