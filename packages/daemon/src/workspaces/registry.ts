// 프로젝트·워크스페이스 레지스트리 (WBS 5.2·5.3, workspace-model §3~§6).
//
// 불변식 2개가 이 파일의 존재 이유다:
//   ① 정합화는 git 파생 메타데이터만 갱신한다 — id·root·cwd·displayName·baseBranch 는 불변.
//   ② 워크스페이스 레코드를 만드는 경로는 프로비저닝 서비스 하나다 — 생성 경로가 셋이면 불변식도 셋이 된다.
import { mkdir, rm, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import type { DaemonPaths } from '../paths.js';
import { LabelCatalog, labelId } from './labels.js';
import {
  TrustStore,
  loadProjectConfig,
  runCommands,
  setupCommands,
  teardownCommands,
} from './project-config.js';
import { addWorktree, generateBranchName, removeWorktree, restoreWorktree } from './worktree.js';
import { RegistryStore } from './registry-store.js';
import { checkoutRootFor, currentBranch, deriveProjectKey, readProjectFacts } from './git-facts.js';
import type { RegistryEvent, WorkspaceIsolation } from '@custom-harness/protocol';
import {
  ProjectRecordSchema,
  WorkspaceRecordSchema,
  newProjectId,
  newWorkspaceId,
  normalizeRoot,
  type ProjectRecord,
  type WorkspaceRecord,
} from './records.js';

/** 레지스트리 변경 알림 — 데몬 서버가 연결된 클라이언트에 브로드캐스트한다 */
export type RegistryEmitter = (event: RegistryEvent) => void;

const now = (): string => new Date().toISOString();

export class ProjectRegistry {
  private readonly store: RegistryStore<ProjectRecord>;

  constructor(
    projectsDir: string,
    private readonly emit: RegistryEmitter = () => undefined,
  ) {
    this.store = new RegistryStore(join(projectsDir, 'projects.json'), ProjectRecordSchema);
  }

  /**
   * 정확한 루트에 대해 멱등하게 프로젝트를 연다.
   * 아카이브된 프로젝트는 **부활하지 않는다** — 새 ID 를 받는다 (workspace-model §2).
   */
  async open(rootInput: string): Promise<ProjectRecord> {
    const root = normalizeRoot(rootInput);
    const existing = (await this.store.readAll()).find(
      (record) => record.root === root && record.archivedAt === undefined,
    );
    if (existing) return existing;

    const facts = await readProjectFacts(root);
    const projectKey = deriveProjectKey(facts.remoteUrl);
    const timestamp = now();
    const record: ProjectRecord = {
      id: newProjectId(),
      root,
      displayName: basename(root) || root,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...facts,
      ...(projectKey !== undefined ? { projectKey } : {}),
    };
    const created = await this.store.mutate((records) => ({
      records: [...records, record],
      result: record,
    }));
    this.emit({ type: 'project_changed', reason: 'created', project: created });
    return created;
  }

  async list(options: { includeArchived?: boolean } = {}): Promise<ProjectRecord[]> {
    const records = await this.store.readAll();
    return options.includeArchived === true
      ? records
      : records.filter((record) => record.archivedAt === undefined);
  }

  async find(id: string): Promise<ProjectRecord | undefined> {
    return this.store.find(id);
  }

  /** 사용자 편집 — displayName 만. 식별자·루트는 여기서도 바뀌지 않는다 */
  async rename(id: string, displayName: string): Promise<ProjectRecord> {
    const trimmed = displayName.trim();
    if (trimmed === '') throw new Error('표시 이름은 비울 수 없음');
    const next = await this.store.mutate((records) => {
      const index = records.findIndex((record) => record.id === id);
      if (index < 0) throw new Error(`프로젝트 없음: ${id}`);
      const updated = { ...records[index]!, displayName: trimmed, updatedAt: now() };
      const copy = [...records];
      copy[index] = updated;
      return { records: copy, result: updated };
    });
    this.emit({ type: 'project_changed', reason: 'updated', project: next });
    return next;
  }

  async archive(id: string): Promise<void> {
    const archived = await this.store.mutate((records) => {
      const index = records.findIndex((record) => record.id === id);
      if (index < 0) throw new Error(`프로젝트 없음: ${id}`);
      const copy = [...records];
      const timestamp = now();
      copy[index] = { ...records[index]!, archivedAt: timestamp, updatedAt: timestamp };
      return { records: copy, result: copy[index]! };
    });
    this.emit({ type: 'project_changed', reason: 'archived', project: archived });
  }

  /**
   * 정합화 (WBS 5.2.2) — git 파생 사실만 갱신한다.
   * 갱신 가능: kind·defaultBranch·remoteUrl. 불변: id·root·displayName·projectKey.
   */
  async reconcile(id: string): Promise<ProjectRecord | undefined> {
    const record = await this.store.find(id);
    if (!record || record.archivedAt !== undefined) return undefined;
    const facts = await readProjectFacts(record.root);
    const changed =
      facts.kind !== record.kind ||
      facts.defaultBranch !== record.defaultBranch ||
      facts.remoteUrl !== record.remoteUrl;
    if (!changed) return record;

    return this.store.mutate((records) => {
      const index = records.findIndex((entry) => entry.id === id);
      if (index < 0) return { records, result: undefined };
      const previous = records[index]!;
      const next: ProjectRecord = {
        ...previous,
        kind: facts.kind,
        updatedAt: now(),
        ...(facts.defaultBranch !== undefined
          ? { defaultBranch: facts.defaultBranch }
          : { defaultBranch: undefined }),
        ...(facts.remoteUrl !== undefined
          ? { remoteUrl: facts.remoteUrl }
          : { remoteUrl: undefined }),
      };
      const copy = [...records];
      copy[index] = next;
      return { records: copy, result: next };
    });
  }
}

export interface CreateWorkspaceInput {
  /** 미리 발급한 id — 백킹 경로가 id 기반이라 프로비저닝이 먼저 확보한다 */
  id?: string;
  projectId: string;
  branch?: string;
  cwd: string;
  checkoutRoot?: string;
  isolation: WorkspaceIsolation;
  displayName?: string;
  baseBranch?: string;
  mainRepoRoot?: string;
  setupState?: WorkspaceRecord['setupState'];
}

export class WorkspaceRegistry {
  private readonly store: RegistryStore<WorkspaceRecord>;

  constructor(
    projectsDir: string,
    private readonly emit: RegistryEmitter = () => undefined,
  ) {
    this.store = new RegistryStore(join(projectsDir, 'workspaces.json'), WorkspaceRecordSchema);
  }

  /** 생성은 프로비저닝 서비스만 호출한다 (workspace-model §6) */
  async create(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
    const cwd = normalizeRoot(input.cwd);
    const checkoutRoot = normalizeRoot(input.checkoutRoot ?? input.cwd);
    const timestamp = now();
    const record: WorkspaceRecord = {
      id: input.id ?? newWorkspaceId(),
      projectId: input.projectId,
      cwd,
      checkoutRoot,
      isolation: input.isolation,
      displayName: input.displayName?.trim() || basename(cwd) || cwd,
      labels: {},
      setupState: input.setupState ?? 'none',
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
      ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
      ...(input.mainRepoRoot !== undefined ? { mainRepoRoot: input.mainRepoRoot } : {}),
    };
    const created = await this.store.mutate((records) => ({
      records: [...records, record],
      result: record,
    }));
    this.emit({ type: 'workspace_changed', reason: 'created', workspace: created });
    return created;
  }

  async list(
    options: { projectId?: string; includeArchived?: boolean } = {},
  ): Promise<WorkspaceRecord[]> {
    let records = await this.store.readAll();
    if (options.projectId !== undefined) {
      records = records.filter((record) => record.projectId === options.projectId);
    }
    return options.includeArchived === true
      ? records
      : records.filter((record) => record.archivedAt === undefined);
  }

  async find(id: string): Promise<WorkspaceRecord | undefined> {
    return this.store.find(id);
  }

  /** 사용자 편집 — 표시 이름·라벨만 */
  async update(
    id: string,
    patch: { displayName?: string; labels?: Record<string, string> },
  ): Promise<WorkspaceRecord> {
    const next = await this.store.mutate((records) => {
      const index = records.findIndex((record) => record.id === id);
      if (index < 0) throw new Error(`워크스페이스 없음: ${id}`);
      const previous = records[index]!;
      const displayName = patch.displayName?.trim();
      const updated: WorkspaceRecord = {
        ...previous,
        updatedAt: now(),
        ...(displayName !== undefined && displayName !== '' ? { displayName } : {}),
        ...(patch.labels !== undefined ? { labels: patch.labels } : {}),
      };
      const copy = [...records];
      copy[index] = updated;
      return { records: copy, result: updated };
    });
    this.emit({ type: 'workspace_changed', reason: 'updated', workspace: next });
    return next;
  }

  async setSetupState(id: string, setupState: WorkspaceRecord['setupState']): Promise<void> {
    await this.store.mutate((records) => {
      const index = records.findIndex((record) => record.id === id);
      if (index < 0) return { records, result: undefined };
      const copy = [...records];
      copy[index] = { ...records[index]!, setupState, updatedAt: now() };
      return { records: copy, result: undefined };
    });
  }

  /** 소프트 삭제. 백킹 디렉토리 제거는 프로비저닝 서비스가 별도로 판단한다 */
  async archive(id: string): Promise<WorkspaceRecord> {
    const archived = await this.store.mutate((records) => {
      const index = records.findIndex((record) => record.id === id);
      if (index < 0) throw new Error(`워크스페이스 없음: ${id}`);
      const timestamp = now();
      const next = { ...records[index]!, archivedAt: timestamp, updatedAt: timestamp };
      const copy = [...records];
      copy[index] = next;
      return { records: copy, result: next };
    });
    this.emit({ type: 'workspace_changed', reason: 'archived', workspace: archived });
    return archived;
  }

  /**
   * 정합화 — 워크스페이스는 **자기 cwd 로부터 독립적으로** 갱신된다.
   * 프로젝트 루트의 브랜치가 워크스페이스(worktree)의 브랜치를 함의하지 않는다.
   */
  async reconcile(id: string): Promise<WorkspaceRecord | undefined> {
    const record = await this.store.find(id);
    if (!record || record.archivedAt !== undefined) return undefined;
    const branch = await currentBranch(record.cwd);
    if (branch === record.branch) return record;
    return this.store.mutate((records) => {
      const index = records.findIndex((entry) => entry.id === id);
      if (index < 0) return { records, result: undefined };
      const copy = [...records];
      copy[index] = {
        ...records[index]!,
        updatedAt: now(),
        ...(branch !== undefined ? { branch } : { branch: undefined }),
      };
      return { records: copy, result: copy[index] };
    });
  }
}

/**
 * 워크스페이스 레코드를 만드는 **단일 창구** (workspace-model §6).
 * 디렉토리 열기·worktree 생성·세션 백필이 전부 여기를 통과한다.
 */
export class WorkspaceProvisioning {
  readonly projects: ProjectRegistry;
  readonly workspaces: WorkspaceRegistry;
  readonly labels: LabelCatalog;
  readonly trust: TrustStore;
  private readonly listeners = new Set<RegistryEmitter>();

  constructor(private readonly paths: DaemonPaths) {
    const emit: RegistryEmitter = (event) => {
      for (const listener of this.listeners) listener(event);
    };
    this.projects = new ProjectRegistry(paths.projectsDir, emit);
    this.workspaces = new WorkspaceRegistry(paths.projectsDir, emit);
    this.labels = new LabelCatalog(paths.projectsDir);
    this.trust = new TrustStore(paths.projectsDir);
  }

  /**
   * 라벨 할당 (WBS 5.3.4) — 카탈로그를 먼저 쓰고 할당을 쓴다.
   * 뒤 단계가 실패해도 남는 것은 쓰이지 않는 카탈로그 항목 하나뿐이라 복구 절차가 필요 없다.
   */
  async setWorkspaceLabels(
    workspaceId: string,
    labels: Record<string, string>,
  ): Promise<WorkspaceRecord> {
    await this.labels.remember(labels);
    return this.workspaces.update(workspaceId, { labels });
  }

  /** 어떤 워크스페이스도 쓰지 않는 카탈로그 항목 정리 */
  async pruneLabels(): Promise<number> {
    const assigned = new Set<string>();
    for (const workspace of await this.workspaces.list({ includeArchived: true })) {
      for (const [key, value] of Object.entries(workspace.labels)) {
        assigned.add(labelId(key, value));
      }
    }
    return this.labels.prune(assigned);
  }

  /** 레지스트리 변경 구독 — 서버가 연결된 클라이언트에 브로드캐스트한다 */
  onChange(listener: RegistryEmitter): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 프로젝트를 열고 기본 워크스페이스를 보장한다 (D-2: 열기 즉시 생성).
   * 이미 열려 있으면 기존 레코드를 그대로 돌려준다 — 멱등.
   */
  async openProject(
    rootInput: string,
  ): Promise<{ project: ProjectRecord; workspace: WorkspaceRecord }> {
    const project = await this.projects.open(rootInput);
    const existing = await this.workspaces.list({ projectId: project.id });
    const defaultWorkspace = existing.find((workspace) => workspace.cwd === project.root);
    if (defaultWorkspace) return { project, workspace: defaultWorkspace };

    const workspace = await this.workspaces.create({
      projectId: project.id,
      cwd: project.root,
      isolation: 'directory',
      displayName: project.displayName,
    });
    return { project, workspace };
  }

  /** 기존 체크아웃(또는 하위 디렉토리)을 워크스페이스로 편입한다 */
  async addDirectoryWorkspace(input: {
    projectId: string;
    cwd: string;
    displayName?: string;
  }): Promise<WorkspaceRecord> {
    const project = await this.projects.find(input.projectId);
    if (!project) throw new Error(`프로젝트 없음: ${input.projectId}`);
    const cwd = normalizeRoot(input.cwd);
    const checkoutRoot = (await checkoutRootFor(cwd)) ?? cwd;
    return this.workspaces.create({
      projectId: project.id,
      cwd,
      checkoutRoot,
      isolation: 'directory',
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    });
  }

  /**
   * worktree 백킹 워크스페이스 생성 (WBS 5.5.1).
   *
   * 순서가 중요하다: 레코드를 **먼저** 만들어 id 를 확보하고(백킹 경로가 id 기반이라),
   * 체크아웃 생성이 실패하면 그 레코드를 아카이브해 유령 워크스페이스를 남기지 않는다.
   */
  async createWorktreeWorkspace(input: {
    projectId: string;
    /** 새 브랜치를 분기할 기준. 미지정이면 `branch` 를 기존 브랜치로 체크아웃한다 */
    baseBranch?: string;
    branch?: string;
    displayName?: string;
  }): Promise<WorkspaceRecord> {
    const project = await this.projects.find(input.projectId);
    if (!project) throw new Error(`프로젝트 없음: ${input.projectId}`);
    if (project.kind !== 'git') {
      throw new Error('git 프로젝트가 아니면 worktree 격리를 쓸 수 없음');
    }
    const baseBranch = input.baseBranch ?? project.defaultBranch;
    const branch =
      input.branch ?? (await generateBranchName(project.root, input.displayName ?? 'work'));

    // id 를 먼저 발급한다 — 백킹 경로가 id 기반이고, cwd 는 레코드 생성 후 바뀌지 않아야 한다
    const workspaceId = newWorkspaceId();
    const path = this.worktreePath(workspaceId);
    await mkdir(this.paths.worktreesDir, { recursive: true });
    await addWorktree({
      repoRoot: project.root,
      path,
      branch,
      // 기존 브랜치 체크아웃이면 -b 를 쓰지 않는다
      ...(input.branch !== undefined && input.baseBranch === undefined
        ? {}
        : { baseBranch: baseBranch ?? 'HEAD' }),
    });

    try {
      return await this.workspaces.create({
        id: workspaceId,
        projectId: project.id,
        cwd: path,
        checkoutRoot: path,
        isolation: 'worktree',
        branch,
        mainRepoRoot: project.root,
        setupState: 'pending',
        displayName: input.displayName ?? branch,
        ...(baseBranch !== undefined ? { baseBranch } : {}),
      });
    } catch (error) {
      // 레코드가 안 생겼는데 체크아웃만 남으면 고아가 된다 — 되돌린다
      await removeWorktree(project.root, path);
      await rm(path, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * 백킹 체크아웃 복구 (WBS 5.5.2) — 외부에서 지워진 worktree 를 메인 저장소에서 재생성하고
   * checkoutRoot → cwd 상대 경로를 되살린다(모노레포 하위 패키지를 가리키던 경우).
   */
  async restoreWorkspaceCheckout(workspaceId: string): Promise<WorkspaceRecord> {
    const workspace = await this.workspaces.find(workspaceId);
    if (!workspace) throw new Error(`워크스페이스 없음: ${workspaceId}`);
    if (workspace.isolation !== 'worktree') {
      throw new Error('worktree 워크스페이스만 복구할 수 있음');
    }
    const { mainRepoRoot, branch } = workspace;
    if (mainRepoRoot === undefined || branch === undefined) {
      throw new Error('복구에 필요한 메인 저장소·브랜치 정보가 없음');
    }
    try {
      await stat(workspace.checkoutRoot);
      return workspace; // 멀쩡하면 아무것도 하지 않는다
    } catch {
      // 사라짐 — 재생성
    }
    await restoreWorktree({ repoRoot: mainRepoRoot, path: workspace.checkoutRoot, branch });
    // 경로는 그대로 되살아난다 — cwd 는 불변이므로 레코드는 손대지 않는다.
    // checkoutRoot 아래의 상대 경로(모노레포 하위 패키지)는 체크아웃 복구로 함께 돌아온다.
    const relativeCwd = relative(workspace.checkoutRoot, workspace.cwd);
    if (relativeCwd !== '') {
      try {
        await stat(workspace.cwd);
      } catch {
        console.warn(
          `[daemon] 복구된 체크아웃에 하위 경로가 없음: ${relativeCwd} (${workspace.id})`,
        );
      }
    }
    return workspace;
  }

  /**
   * 프로젝트 설정 파일의 setup 실행 (WBS 5.5.3).
   * 신뢰가 없으면 실행하지 않고 `pending` 을 유지한다 — 호출자가 내용을 보여주고 동의를 받아야 한다.
   */
  async runWorkspaceSetup(
    workspaceId: string,
    options: { trust?: boolean } = {},
  ): Promise<{ setupState: WorkspaceRecord['setupState']; detail?: string }> {
    const workspace = await this.workspaces.find(workspaceId);
    if (!workspace) throw new Error(`워크스페이스 없음: ${workspaceId}`);
    const project = await this.projects.find(workspace.projectId);
    if (!project) throw new Error(`프로젝트 없음: ${workspace.projectId}`);

    const ref = workspace.baseBranch ?? project.defaultBranch ?? 'HEAD';
    const loaded = await loadProjectConfig(project.root, ref);
    if (!loaded) {
      await this.workspaces.setSetupState(workspaceId, 'none');
      return { setupState: 'none' }; // 설정 파일은 선택 — 없으면 할 일이 없다
    }
    // 신뢰는 **설정 파일 전체**(내용 해시)에 묶인다 — setup 명령 유무와 무관하게 먼저 부여한다.
    // 그렇지 않으면 `scripts` 만 있는 프로젝트는 영원히 신뢰를 얻을 수 없다 (WBS 6.6).
    if (options.trust === true) await this.trust.grant(project.id, loaded.contentHash);
    const commands = setupCommands(loaded.config);
    if (commands.length === 0) {
      await this.workspaces.setSetupState(workspaceId, 'none');
      return { setupState: 'none' };
    }
    if (!(await this.trust.isTrusted(project.id, loaded.contentHash))) {
      await this.workspaces.setSetupState(workspaceId, 'pending');
      return { setupState: 'pending', detail: '설정 파일 실행 동의가 필요함' };
    }

    const outcome = await runCommands(commands, {
      cwd: workspace.cwd,
      env: {
        ...process.env,
        CUSTOM_HARNESS_SOURCE_CHECKOUT: project.root,
        CUSTOM_HARNESS_WORKSPACE_ID: workspace.id,
      },
    });
    const setupState = outcome.ok ? 'ok' : 'failed';
    await this.workspaces.setSetupState(workspaceId, setupState);
    return {
      setupState,
      ...(outcome.failed !== undefined
        ? { detail: `실패: ${outcome.failed.command} (exit ${String(outcome.failed.exitCode)})` }
        : {}),
    };
  }

  /**
   * 워크스페이스 스크립트 목록 (WBS 6.6) — 설정 파일에 선언된 이름 붙은 명령.
   * 신뢰 여부를 함께 알려 UI 가 "실행 전 동의가 필요합니다"를 표시할 수 있게 한다.
   */
  async listWorkspaceScripts(
    workspaceId: string,
  ): Promise<{ scripts: { name: string; command: string }[]; trusted: boolean }> {
    const workspace = await this.workspaces.find(workspaceId);
    if (!workspace) throw new Error(`워크스페이스 없음: ${workspaceId}`);
    const project = await this.projects.find(workspace.projectId);
    if (!project || project.kind !== 'git') return { scripts: [], trusted: false };

    const ref = workspace.baseBranch ?? project.defaultBranch ?? 'HEAD';
    const loaded = await loadProjectConfig(project.root, ref);
    if (!loaded) return { scripts: [], trusted: false };
    const scripts = Object.entries(loaded.config.scripts ?? {}).map(([name, entry]) => ({
      name,
      command: entry.command,
    }));
    return { scripts, trusted: await this.trust.isTrusted(project.id, loaded.contentHash) };
  }

  /**
   * 스크립트 1개의 명령을 돌려준다 — 신뢰가 없으면 거절한다.
   * 실제 실행은 감독 터미널이 맡으므로(6.6) 여기서는 명령과 실행 위치만 확정한다.
   */
  async resolveWorkspaceScript(
    workspaceId: string,
    name: string,
  ): Promise<{ command: string; cwd: string; env: NodeJS.ProcessEnv }> {
    const workspace = await this.workspaces.find(workspaceId);
    if (!workspace) throw new Error(`워크스페이스 없음: ${workspaceId}`);
    const project = await this.projects.find(workspace.projectId);
    if (!project) throw new Error(`프로젝트 없음: ${workspace.projectId}`);
    const ref = workspace.baseBranch ?? project.defaultBranch ?? 'HEAD';
    const loaded = await loadProjectConfig(project.root, ref);
    const script = loaded?.config.scripts?.[name];
    if (!loaded || !script) throw new Error(`스크립트 없음: ${name}`);
    if (!(await this.trust.isTrusted(project.id, loaded.contentHash))) {
      throw new Error('설정 파일 실행 동의가 필요함');
    }
    return {
      command: script.command,
      cwd: workspace.cwd,
      env: {
        ...process.env,
        CUSTOM_HARNESS_SOURCE_CHECKOUT: project.root,
        CUSTOM_HARNESS_WORKSPACE_ID: workspace.id,
      },
    };
  }

  /**
   * 아카이브 단일 창구 (WBS 5.3.3). 레코드는 소프트 삭제로 남고, 백킹 디렉토리 제거는
   * **우리가 만든 worktree 에 한정**한다 — 사용자가 고른 체크아웃은 어떤 경우에도 지우지 않는다.
   *
   * 프로젝트 설정 파일(harness.json)의 teardown 실행은 5.5.3 에서 이 경로에 들어온다.
   */
  async archiveWorkspace(
    workspaceId: string,
    options: { removeCheckout?: boolean } = {},
  ): Promise<WorkspaceRecord> {
    const existing = await this.workspaces.find(workspaceId);
    if (!existing) throw new Error(`워크스페이스 없음: ${workspaceId}`);

    // teardown 은 아카이브 *전에*, 아직 디렉토리가 있을 때 돈다 (WBS 5.5.3)
    await this.runTeardown(existing);

    const archived = await this.workspaces.archive(workspaceId);
    if (options.removeCheckout !== true) return archived;

    const managedRoot = normalizeRoot(this.paths.worktreesDir);
    const target = normalizeRoot(archived.checkoutRoot);
    const isManaged = archived.isolation === 'worktree' && target.startsWith(managedRoot + sep);
    if (!isManaged) {
      throw new Error(`관리 밖 체크아웃은 제거하지 않음: ${target}`);
    }
    // git 원장까지 정리해야 같은 경로를 다시 쓸 수 있다
    if (archived.mainRepoRoot !== undefined) {
      await removeWorktree(archived.mainRepoRoot, target);
    }
    await rm(target, { recursive: true, force: true });
    return archived;
  }

  /** 아카이브 직전 teardown — 신뢰된 설정에서만 실행하고, 실패해도 아카이브를 막지 않는다 */
  private async runTeardown(workspace: WorkspaceRecord): Promise<void> {
    const project = await this.projects.find(workspace.projectId);
    if (!project || project.kind !== 'git') return;
    const ref = workspace.baseBranch ?? project.defaultBranch ?? 'HEAD';
    const loaded = await loadProjectConfig(project.root, ref);
    if (!loaded) return;
    const commands = teardownCommands(loaded.config);
    if (commands.length === 0) return;
    if (!(await this.trust.isTrusted(project.id, loaded.contentHash))) return;
    try {
      await stat(workspace.cwd);
    } catch {
      return; // 디렉토리가 이미 없으면 돌릴 것이 없다
    }
    const outcome = await runCommands(commands, {
      cwd: workspace.cwd,
      env: {
        ...process.env,
        CUSTOM_HARNESS_SOURCE_CHECKOUT: project.root,
        CUSTOM_HARNESS_WORKSPACE_ID: workspace.id,
      },
    });
    if (!outcome.ok) {
      console.warn(`[daemon] teardown 실패 (${workspace.id}) — 아카이브는 계속한다`);
    }
  }

  /** worktree 백킹 디렉토리 경로 (D-1 확정: 데이터 디렉토리 내부) */
  worktreePath(workspaceId: string): string {
    return join(this.paths.worktreesDir, workspaceId);
  }
}
