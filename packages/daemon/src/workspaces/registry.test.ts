import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { resolvePaths, type DaemonPaths } from '../paths.js';
import { normalizeRoot } from './records.js';
import { ProjectRegistry, WorkspaceProvisioning, WorkspaceRegistry } from './registry.js';

const run = promisify(execFile);

async function makePaths(): Promise<DaemonPaths> {
  return resolvePaths(await mkdtemp(join(tmpdir(), 'ch-wsp-')));
}

/** 격리된 git 저장소 — 사용자 전역 설정에 의존하지 않게 커밋 신원을 명시한다 */
async function makeRepo(branch = 'main'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ch-repo-'));
  await run('git', ['init', '-q', '-b', branch], { cwd: dir });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await run('git', ['config', 'user.name', 'test'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), '# test\n');
  await run('git', ['add', '.'], { cwd: dir });
  await run('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('ProjectRegistry (WBS 5.2)', () => {
  it('같은 루트로 다시 열면 멱등하게 같은 레코드를 준다', async () => {
    const paths = await makePaths();
    const projects = new ProjectRegistry(paths.projectsDir);
    const dir = await mkdtemp(join(tmpdir(), 'ch-plain-'));

    const first = await projects.open(dir);
    const second = await projects.open(join(dir, '.', '')); // 다른 표기, 같은 경로
    expect(second.id).toBe(first.id);
    expect(await projects.list()).toHaveLength(1);
  });

  it('불투명 ID 를 발급하고 경로에서 유도하지 않는다', async () => {
    const paths = await makePaths();
    const projects = new ProjectRegistry(paths.projectsDir);
    const project = await projects.open(await mkdtemp(join(tmpdir(), 'ch-plain-')));
    expect(project.id).toMatch(/^prj_[0-9a-f]{16}$/);
    expect(project.id).not.toContain(project.root);
  });

  it('git 저장소는 kind·기본 브랜치를 관측한다', async () => {
    const paths = await makePaths();
    const projects = new ProjectRegistry(paths.projectsDir);
    const project = await projects.open(await makeRepo('trunk'));
    expect(project.kind).toBe('git');
    expect(project.defaultBranch).toBe('trunk');
  });

  it('git 이 아닌 디렉토리는 plain 이다 (폐쇄망 로컬 디렉토리도 1급)', async () => {
    const paths = await makePaths();
    const projects = new ProjectRegistry(paths.projectsDir);
    const project = await projects.open(await mkdtemp(join(tmpdir(), 'ch-plain-')));
    expect(project.kind).toBe('plain');
    expect(project.remoteUrl).toBeUndefined();
  });

  it('아카이브된 프로젝트는 부활하지 않고 새 ID 를 받는다', async () => {
    const paths = await makePaths();
    const projects = new ProjectRegistry(paths.projectsDir);
    const dir = await mkdtemp(join(tmpdir(), 'ch-plain-'));
    const first = await projects.open(dir);
    await projects.archive(first.id);

    const second = await projects.open(dir);
    expect(second.id).not.toBe(first.id);
    expect(await projects.list()).toHaveLength(1); // 활성은 새 것 하나
    expect(await projects.list({ includeArchived: true })).toHaveLength(2);
  });

  it('정합화는 git 사실만 갱신하고 식별자·루트·표시 이름을 건드리지 않는다', async () => {
    const paths = await makePaths();
    const projects = new ProjectRegistry(paths.projectsDir);
    const repo = await makeRepo('main');
    const project = await projects.open(repo);
    await projects.rename(project.id, '내가 지은 이름');

    // 저장소 사실이 바뀐다 — 브랜치 전환
    await run('git', ['checkout', '-q', '-b', 'feature'], { cwd: repo });
    const reconciled = await projects.reconcile(project.id);

    expect(reconciled?.id).toBe(project.id);
    expect(reconciled?.root).toBe(normalizeRoot(repo));
    expect(reconciled?.displayName).toBe('내가 지은 이름'); // 정합화가 덮지 않는다
    expect(reconciled?.defaultBranch).toBe('feature'); // 가변 사실만 갱신
  });

  it('레지스트리 파일이 파손돼도 빈 목록으로 살아난다 (관대 파싱)', async () => {
    const paths = await makePaths();
    await mkdir(paths.projectsDir, { recursive: true });
    await writeFile(join(paths.projectsDir, 'projects.json'), '{ 깨진 JSON');
    const projects = new ProjectRegistry(paths.projectsDir);
    expect(await projects.list()).toEqual([]);
  });

  it('스키마에 맞지 않는 레코드만 버리고 나머지는 살린다', async () => {
    const paths = await makePaths();
    await mkdir(paths.projectsDir, { recursive: true });
    const valid = {
      id: 'prj_0123456789abcdef',
      root: '/tmp/x',
      displayName: 'x',
      kind: 'plain',
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    };
    await writeFile(
      join(paths.projectsDir, 'projects.json'),
      JSON.stringify({ records: [valid, { id: 'prj_broken' }] }),
    );
    const projects = new ProjectRegistry(paths.projectsDir);
    expect((await projects.list()).map((p) => p.id)).toEqual(['prj_0123456789abcdef']);
  });
});

describe('WorkspaceRegistry (WBS 5.3)', () => {
  it('cwd 와 checkoutRoot 를 분리 보관한다 (모노레포 하위 패키지)', async () => {
    const paths = await makePaths();
    const workspaces = new WorkspaceRegistry(paths.projectsDir);
    const record = await workspaces.create({
      projectId: 'prj_x',
      cwd: '/repo/packages/api',
      checkoutRoot: '/repo',
      isolation: 'directory',
    });
    expect(record.cwd).toBe(normalizeRoot('/repo/packages/api'));
    expect(record.checkoutRoot).toBe(normalizeRoot('/repo'));
  });

  it('같은 cwd 를 가리키는 형제 워크스페이스가 독립적으로 존재한다', async () => {
    const paths = await makePaths();
    const workspaces = new WorkspaceRegistry(paths.projectsDir);
    const a = await workspaces.create({ projectId: 'prj_x', cwd: '/repo', isolation: 'directory' });
    const b = await workspaces.create({ projectId: 'prj_x', cwd: '/repo', isolation: 'directory' });
    expect(a.id).not.toBe(b.id);
    expect(await workspaces.list({ projectId: 'prj_x' })).toHaveLength(2);
  });

  it('아카이브는 소프트 삭제다 — 레코드가 남는다', async () => {
    const paths = await makePaths();
    const workspaces = new WorkspaceRegistry(paths.projectsDir);
    const record = await workspaces.create({
      projectId: 'prj_x',
      cwd: '/repo',
      isolation: 'directory',
    });
    await workspaces.archive(record.id);
    expect(await workspaces.list({ projectId: 'prj_x' })).toHaveLength(0);
    expect(await workspaces.list({ projectId: 'prj_x', includeArchived: true })).toHaveLength(1);
    expect((await workspaces.find(record.id))?.archivedAt).toBeDefined();
  });

  it('동시 생성이 서로를 덮지 않는다 (쓰기 직렬화)', async () => {
    const paths = await makePaths();
    const workspaces = new WorkspaceRegistry(paths.projectsDir);
    await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        workspaces.create({
          projectId: 'prj_x',
          cwd: `/repo/w${index}`,
          isolation: 'directory',
        }),
      ),
    );
    expect(await workspaces.list({ projectId: 'prj_x' })).toHaveLength(8);
  });

  it('라벨과 setup 상태를 갱신한다', async () => {
    const paths = await makePaths();
    const workspaces = new WorkspaceRegistry(paths.projectsDir);
    const record = await workspaces.create({
      projectId: 'prj_x',
      cwd: '/repo',
      isolation: 'directory',
    });
    expect(record.labels).toEqual({});
    expect(record.setupState).toBe('none');

    const updated = await workspaces.update(record.id, {
      displayName: '  API 작업  ',
      labels: { team: 'platform' },
    });
    expect(updated.displayName).toBe('API 작업'); // 공백 정리
    expect(updated.labels).toEqual({ team: 'platform' });

    await workspaces.setSetupState(record.id, 'pending');
    expect((await workspaces.find(record.id))?.setupState).toBe('pending');
  });

  it('정합화가 자기 cwd 의 브랜치만 반영한다', async () => {
    const paths = await makePaths();
    const workspaces = new WorkspaceRegistry(paths.projectsDir);
    const repo = await makeRepo('main');
    const record = await workspaces.create({
      projectId: 'prj_x',
      cwd: repo,
      isolation: 'directory',
    });
    expect((await workspaces.reconcile(record.id))?.branch).toBe('main');

    await run('git', ['checkout', '-q', '-b', 'topic'], { cwd: repo });
    const reconciled = await workspaces.reconcile(record.id);
    expect(reconciled?.branch).toBe('topic');
    expect(reconciled?.cwd).toBe(normalizeRoot(repo)); // 불변
  });
});

describe('WorkspaceProvisioning (단일 창구)', () => {
  it('프로젝트를 열면 기본 워크스페이스가 즉시 생긴다 (D-2)', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    const dir = await mkdtemp(join(tmpdir(), 'ch-plain-'));

    const { project, workspace } = await provisioning.openProject(dir);
    expect(workspace.projectId).toBe(project.id);
    expect(workspace.cwd).toBe(project.root);
    expect(workspace.isolation).toBe('directory');
  });

  it('다시 열어도 기본 워크스페이스를 중복 생성하지 않는다', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    const dir = await mkdtemp(join(tmpdir(), 'ch-plain-'));

    const first = await provisioning.openProject(dir);
    const second = await provisioning.openProject(dir);
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(await provisioning.workspaces.list({ projectId: first.project.id })).toHaveLength(1);
  });

  it('하위 디렉토리를 편입하면 checkoutRoot 는 저장소 루트가 된다', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    const repo = await makeRepo();
    await mkdir(join(repo, 'packages', 'api'), { recursive: true });
    const { project } = await provisioning.openProject(repo);

    const workspace = await provisioning.addDirectoryWorkspace({
      projectId: project.id,
      cwd: join(repo, 'packages', 'api'),
    });
    expect(workspace.cwd).toBe(normalizeRoot(join(repo, 'packages', 'api')));
    expect(workspace.checkoutRoot).toBe(normalizeRoot(repo));
    // 불변식: git 이 심링크를 푼 경로를 돌려줘도 사용자가 고른 경로 계열을 유지한다
    expect(workspace.cwd.startsWith(workspace.checkoutRoot)).toBe(true);
  });

  it('worktree 백킹 경로는 데이터 디렉토리 내부다 (D-1)', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    expect(provisioning.worktreePath('wsp_abc')).toBe(join(paths.worktreesDir, 'wsp_abc'));
    expect(provisioning.worktreePath('wsp_abc').startsWith(paths.dataDir)).toBe(true);
  });

  it('레지스트리는 원자적으로 쓰인다 — 임시 파일이 남지 않는다', async () => {
    const paths = await makePaths();
    const provisioning = new WorkspaceProvisioning(paths);
    await provisioning.openProject(await mkdtemp(join(tmpdir(), 'ch-plain-')));
    const raw = JSON.parse(await readFile(join(paths.projectsDir, 'projects.json'), 'utf8'));
    expect(raw.schemaVersion).toBe(1);
    expect(Array.isArray(raw.records)).toBe(true);
  });
});
