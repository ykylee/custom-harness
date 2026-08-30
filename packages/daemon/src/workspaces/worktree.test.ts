// worktree 격리 워크스페이스 (WBS 5.5) — 생성·복구·setup/teardown 신뢰 경계.
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { resolvePaths, type DaemonPaths } from '../paths.js';
import { WorkspaceProvisioning } from './registry.js';
import { generateBranchName } from './worktree.js';

const run = promisify(execFile);

async function makePaths(): Promise<DaemonPaths> {
  return resolvePaths(await mkdtemp(join(tmpdir(), 'ch-wt-')));
}

async function makeRepo(config?: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ch-repo-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await run('git', ['config', 'user.name', 'test'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), '# test\n');
  if (config) await writeFile(join(dir, 'harness.json'), JSON.stringify(config, null, 2));
  await run('git', ['add', '.'], { cwd: dir });
  await run('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('worktree 생성 (WBS 5.5.1)', () => {
  it('데이터 디렉토리 안에 체크아웃을 만들고 새 브랜치를 분기한다', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    const repo = await makeRepo();
    const { project } = await provisioning.openProject(repo);

    const workspace = await provisioning.createWorktreeWorkspace({
      projectId: project.id,
      branch: 'feature/x',
      baseBranch: 'main',
      displayName: '기능 작업',
    });

    expect(workspace.isolation).toBe('worktree');
    expect(workspace.cwd).toBe(join(paths.worktreesDir, workspace.id));
    expect(workspace.checkoutRoot).toBe(workspace.cwd);
    expect(workspace.mainRepoRoot).toBe(project.root);
    expect(workspace.setupState).toBe('pending');
    await access(join(workspace.cwd, 'README.md'));

    const { stdout } = await run('git', ['branch', '--show-current'], { cwd: workspace.cwd });
    expect(stdout.trim()).toBe('feature/x');
  });

  it('브랜치 이름을 자동 생성하고 충돌을 피한다', async () => {
    const repo = await makeRepo();
    const first = await generateBranchName(repo, '기능 A');
    await run('git', ['branch', first], { cwd: repo });
    const second = await generateBranchName(repo, '기능 A');
    expect(second).not.toBe(first);
    expect(second.startsWith(first)).toBe(true);
  });

  it('git 프로젝트가 아니면 거절한다', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    const { project } = await provisioning.openProject(await mkdtemp(join(tmpdir(), 'ch-plain-')));
    await expect(provisioning.createWorktreeWorkspace({ projectId: project.id })).rejects.toThrow(
      'worktree',
    );
  });

  it('체크아웃 생성이 실패하면 워크스페이스 레코드를 남기지 않는다', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    const repo = await makeRepo();
    const { project } = await provisioning.openProject(repo);

    // 이미 존재하는 브랜치를 -b 로 만들려 하면 git 이 거절한다
    await expect(
      provisioning.createWorktreeWorkspace({
        projectId: project.id,
        branch: 'main',
        baseBranch: 'main',
      }),
    ).rejects.toThrow();

    const workspaces = await provisioning.workspaces.list({
      projectId: project.id,
      includeArchived: true,
    });
    expect(workspaces.filter((workspace) => workspace.isolation === 'worktree')).toEqual([]);
  });
});

describe('worktree 복구 (WBS 5.5.2)', () => {
  it('외부에서 지워진 체크아웃을 되살린다', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    const repo = await makeRepo();
    const { project } = await provisioning.openProject(repo);
    const workspace = await provisioning.createWorktreeWorkspace({
      projectId: project.id,
      branch: 'feature/y',
      baseBranch: 'main',
    });

    await rm(workspace.cwd, { recursive: true, force: true });
    const restored = await provisioning.restoreWorkspaceCheckout(workspace.id);

    expect(restored.cwd).toBe(workspace.cwd); // 경로는 불변
    await access(join(workspace.cwd, 'README.md'));
    const { stdout } = await run('git', ['branch', '--show-current'], { cwd: workspace.cwd });
    expect(stdout.trim()).toBe('feature/y');
  });

  it('멀쩡한 체크아웃은 건드리지 않는다', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    const repo = await makeRepo();
    const { project } = await provisioning.openProject(repo);
    const workspace = await provisioning.createWorktreeWorkspace({
      projectId: project.id,
      branch: 'feature/z',
      baseBranch: 'main',
    });
    await writeFile(join(workspace.cwd, 'scratch.txt'), 'keep me');

    await provisioning.restoreWorkspaceCheckout(workspace.id);
    expect(await readFile(join(workspace.cwd, 'scratch.txt'), 'utf8')).toBe('keep me');
  });
});

describe('프로젝트 설정 파일 실행 (WBS 5.5.3)', () => {
  it('신뢰 전에는 실행하지 않고 pending 을 유지한다', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    const repo = await makeRepo({ workspace: { setup: 'echo hi > setup-ran.txt' } });
    const { project } = await provisioning.openProject(repo);
    const workspace = await provisioning.createWorktreeWorkspace({
      projectId: project.id,
      branch: 'feature/s',
      baseBranch: 'main',
    });

    const outcome = await provisioning.runWorkspaceSetup(workspace.id);
    expect(outcome.setupState).toBe('pending');
    expect(outcome.detail).toContain('동의');
    await expect(access(join(workspace.cwd, 'setup-ran.txt'))).rejects.toThrow();
  });

  it('동의하면 실행하고, 같은 내용은 다시 묻지 않는다', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    const repo = await makeRepo({ workspace: { setup: ['echo hi > setup-ran.txt'] } });
    const { project } = await provisioning.openProject(repo);
    const first = await provisioning.createWorktreeWorkspace({
      projectId: project.id,
      branch: 'feature/s1',
      baseBranch: 'main',
    });

    expect((await provisioning.runWorkspaceSetup(first.id, { trust: true })).setupState).toBe('ok');
    await access(join(first.cwd, 'setup-ran.txt'));

    // 같은 프로젝트·같은 내용 → 신뢰가 이미 있으므로 동의 없이 실행된다
    const second = await provisioning.createWorktreeWorkspace({
      projectId: project.id,
      branch: 'feature/s2',
      baseBranch: 'main',
    });
    expect((await provisioning.runWorkspaceSetup(second.id)).setupState).toBe('ok');
    await access(join(second.cwd, 'setup-ran.txt'));
  });

  it('설정 내용이 바뀌면 신뢰가 무효화된다', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    const repo = await makeRepo({ workspace: { setup: 'echo one > setup-ran.txt' } });
    const { project } = await provisioning.openProject(repo);
    const first = await provisioning.createWorktreeWorkspace({
      projectId: project.id,
      branch: 'feature/t1',
      baseBranch: 'main',
    });
    await provisioning.runWorkspaceSetup(first.id, { trust: true });

    // 베이스 브랜치의 커밋본이 바뀐다
    await writeFile(
      join(repo, 'harness.json'),
      JSON.stringify({ workspace: { setup: 'echo two > setup-ran.txt' } }),
    );
    await run('git', ['commit', '-q', '-am', 'change config'], { cwd: repo });

    const second = await provisioning.createWorktreeWorkspace({
      projectId: project.id,
      branch: 'feature/t2',
      baseBranch: 'main',
    });
    expect((await provisioning.runWorkspaceSetup(second.id)).setupState).toBe('pending');
  });

  it('작업 브랜치의 미커밋 변경은 실행 경로에 새 나가지 않는다', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    const repo = await makeRepo({ workspace: { setup: 'echo safe > setup-ran.txt' } });
    const { project } = await provisioning.openProject(repo);
    // 워킹 트리만 오염시킨다 (커밋하지 않음)
    await writeFile(
      join(repo, 'harness.json'),
      JSON.stringify({ workspace: { setup: 'echo pwned > pwned.txt' } }),
    );

    const workspace = await provisioning.createWorktreeWorkspace({
      projectId: project.id,
      branch: 'feature/u',
      baseBranch: 'main',
    });
    await provisioning.runWorkspaceSetup(workspace.id, { trust: true });

    await access(join(workspace.cwd, 'setup-ran.txt'));
    await expect(access(join(workspace.cwd, 'pwned.txt'))).rejects.toThrow();
  });

  it('setup 실패는 failed 로 남고 어디서 멈췄는지 보고한다', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    const repo = await makeRepo({
      workspace: { setup: ['echo ok > first.txt', 'exit 3', 'echo never > second.txt'] },
    });
    const { project } = await provisioning.openProject(repo);
    const workspace = await provisioning.createWorktreeWorkspace({
      projectId: project.id,
      branch: 'feature/f',
      baseBranch: 'main',
    });

    const outcome = await provisioning.runWorkspaceSetup(workspace.id, { trust: true });
    expect(outcome.setupState).toBe('failed');
    expect(outcome.detail).toContain('exit 3');
    await access(join(workspace.cwd, 'first.txt'));
    await expect(access(join(workspace.cwd, 'second.txt'))).rejects.toThrow(); // 뒤 명령은 돌지 않는다
  });

  it('설정 파일이 없으면 할 일이 없다', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    const repo = await makeRepo();
    const { project } = await provisioning.openProject(repo);
    const workspace = await provisioning.createWorktreeWorkspace({
      projectId: project.id,
      branch: 'feature/n',
      baseBranch: 'main',
    });
    expect((await provisioning.runWorkspaceSetup(workspace.id)).setupState).toBe('none');
  });
});

describe('아카이브 수명주기 (WBS 5.3.3 + 5.5.3)', () => {
  it('teardown 을 돌리고 백킹 체크아웃과 git 원장을 정리한다', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    const repo = await makeRepo({
      workspace: {
        setup: 'echo up > up.txt',
        teardown: `echo down > "$CUSTOM_HARNESS_SOURCE_CHECKOUT/down.txt"`,
      },
    });
    const { project } = await provisioning.openProject(repo);
    const workspace = await provisioning.createWorktreeWorkspace({
      projectId: project.id,
      branch: 'feature/a',
      baseBranch: 'main',
    });
    await provisioning.runWorkspaceSetup(workspace.id, { trust: true });

    await provisioning.archiveWorkspace(workspace.id, { removeCheckout: true });

    // teardown 이 원본 체크아웃 경로 환경 변수를 받아 실행됐다
    await access(join(repo, 'down.txt'));
    await expect(access(workspace.cwd)).rejects.toThrow();
    const { stdout } = await run('git', ['worktree', 'list'], { cwd: repo });
    expect(stdout).not.toContain(workspace.id);
  });

  it('신뢰 없는 설정의 teardown 은 돌리지 않는다', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    const repo = await makeRepo({
      workspace: { teardown: `echo down > "$CUSTOM_HARNESS_SOURCE_CHECKOUT/down.txt"` },
    });
    const { project } = await provisioning.openProject(repo);
    const workspace = await provisioning.createWorktreeWorkspace({
      projectId: project.id,
      branch: 'feature/b',
      baseBranch: 'main',
    });

    await provisioning.archiveWorkspace(workspace.id, { removeCheckout: true });
    await expect(access(join(repo, 'down.txt'))).rejects.toThrow();
  });
});

describe('worktree 미사용 모드 동등 지원 (WBS 5.5.4)', () => {
  it('비 git 프로젝트도 워크스페이스·아카이브가 온전히 동작한다', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    const dir = await mkdtemp(join(tmpdir(), 'ch-plain-'));
    const { project, workspace } = await provisioning.openProject(dir);

    expect(project.kind).toBe('plain');
    expect(workspace.isolation).toBe('directory');
    expect(workspace.setupState).toBe('none');

    // 아카이브는 teardown 없이 성립하고, 사용자 디렉토리는 남는다
    const archived = await provisioning.archiveWorkspace(workspace.id);
    expect(archived.archivedAt).toBeDefined();
    await access(dir);
  });

  it('git 프로젝트라도 디렉토리 격리 워크스페이스를 그대로 쓸 수 있다', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    const repo = await makeRepo();
    const { project } = await provisioning.openProject(repo);

    const workspace = await provisioning.addDirectoryWorkspace({
      projectId: project.id,
      cwd: repo,
      displayName: '메인 체크아웃 사본',
    });
    expect(workspace.isolation).toBe('directory');
    expect(workspace.mainRepoRoot).toBeUndefined();

    // removeCheckout 를 요청해도 사용자 체크아웃은 지우지 않는다
    await expect(
      provisioning.archiveWorkspace(workspace.id, { removeCheckout: true }),
    ).rejects.toThrow('관리 밖');
    await access(join(repo, 'README.md'));
  });
});

describe('워크스페이스 스크립트 (WBS 6.6)', () => {
  it('설정 파일의 스크립트를 신뢰 여부와 함께 목록으로 준다', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    const repo = await makeRepo({
      scripts: { test: { command: 'npm test' }, lint: { command: 'npm run lint' } },
    });
    const { project, workspace } = await provisioning.openProject(repo);

    const before = await provisioning.listWorkspaceScripts(workspace.id);
    expect(before.scripts.map((s) => s.name).sort()).toEqual(['lint', 'test']);
    expect(before.trusted).toBe(false); // 아직 동의 전

    // setup 동의는 같은 설정 파일 전체에 대한 신뢰다
    await provisioning.runWorkspaceSetup(workspace.id, { trust: true });
    expect((await provisioning.listWorkspaceScripts(workspace.id)).trusted).toBe(true);
    expect(project.kind).toBe('git');
  });

  it('신뢰 없이 실행하려 하면 거절한다', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    const repo = await makeRepo({ scripts: { test: { command: 'echo hi' } } });
    const { workspace } = await provisioning.openProject(repo);

    await expect(provisioning.resolveWorkspaceScript(workspace.id, 'test')).rejects.toThrow('동의');
  });

  it('신뢰 후에는 명령·실행 위치·환경 변수를 확정해 준다', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    const repo = await makeRepo({
      workspace: { setup: 'true' },
      scripts: { test: { command: 'echo SCRIPT_OK' } },
    });
    const { project, workspace } = await provisioning.openProject(repo);
    await provisioning.runWorkspaceSetup(workspace.id, { trust: true });

    const resolved = await provisioning.resolveWorkspaceScript(workspace.id, 'test');
    expect(resolved.command).toBe('echo SCRIPT_OK');
    expect(resolved.cwd).toBe(workspace.cwd);
    expect(resolved.env.CUSTOM_HARNESS_SOURCE_CHECKOUT).toBe(project.root);
    expect(resolved.env.CUSTOM_HARNESS_WORKSPACE_ID).toBe(workspace.id);
  });

  it('없는 스크립트는 거절한다', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    const repo = await makeRepo({ scripts: {} });
    const { workspace } = await provisioning.openProject(repo);
    await expect(provisioning.resolveWorkspaceScript(workspace.id, 'nope')).rejects.toThrow(
      '스크립트 없음',
    );
  });
});
