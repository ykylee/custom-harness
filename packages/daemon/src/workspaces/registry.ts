// 프로젝트·워크스페이스 레지스트리 (WBS 5.2·5.3, workspace-model §3~§6).
//
// 불변식 2개가 이 파일의 존재 이유다:
//   ① 정합화는 git 파생 메타데이터만 갱신한다 — id·root·cwd·displayName·baseBranch 는 불변.
//   ② 워크스페이스 레코드를 만드는 경로는 프로비저닝 서비스 하나다 — 생성 경로가 셋이면 불변식도 셋이 된다.
import { basename, join } from 'node:path';
import type { DaemonPaths } from '../paths.js';
import { RegistryStore } from './registry-store.js';
import { checkoutRootFor, currentBranch, deriveProjectKey, readProjectFacts } from './git-facts.js';
import {
  ProjectRecordSchema,
  WorkspaceRecordSchema,
  newProjectId,
  newWorkspaceId,
  normalizeRoot,
  type ProjectRecord,
  type WorkspaceIsolation,
  type WorkspaceRecord,
} from './records.js';

const now = (): string => new Date().toISOString();

export class ProjectRegistry {
  private readonly store: RegistryStore<ProjectRecord>;

  constructor(projectsDir: string) {
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
    return this.store.mutate((records) => ({ records: [...records, record], result: record }));
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
    return this.store.mutate((records) => {
      const index = records.findIndex((record) => record.id === id);
      if (index < 0) throw new Error(`프로젝트 없음: ${id}`);
      const next = { ...records[index]!, displayName: trimmed, updatedAt: now() };
      const copy = [...records];
      copy[index] = next;
      return { records: copy, result: next };
    });
  }

  async archive(id: string): Promise<void> {
    await this.store.mutate((records) => {
      const index = records.findIndex((record) => record.id === id);
      if (index < 0) throw new Error(`프로젝트 없음: ${id}`);
      const copy = [...records];
      const timestamp = now();
      copy[index] = { ...records[index]!, archivedAt: timestamp, updatedAt: timestamp };
      return { records: copy, result: undefined };
    });
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
  projectId: string;
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

  constructor(projectsDir: string) {
    this.store = new RegistryStore(join(projectsDir, 'workspaces.json'), WorkspaceRecordSchema);
  }

  /** 생성은 프로비저닝 서비스만 호출한다 (workspace-model §6) */
  async create(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
    const cwd = normalizeRoot(input.cwd);
    const checkoutRoot = normalizeRoot(input.checkoutRoot ?? input.cwd);
    const timestamp = now();
    const record: WorkspaceRecord = {
      id: newWorkspaceId(),
      projectId: input.projectId,
      cwd,
      checkoutRoot,
      isolation: input.isolation,
      displayName: input.displayName?.trim() || basename(cwd) || cwd,
      labels: {},
      setupState: input.setupState ?? 'none',
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
      ...(input.mainRepoRoot !== undefined ? { mainRepoRoot: input.mainRepoRoot } : {}),
    };
    return this.store.mutate((records) => ({ records: [...records, record], result: record }));
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
    return this.store.mutate((records) => {
      const index = records.findIndex((record) => record.id === id);
      if (index < 0) throw new Error(`워크스페이스 없음: ${id}`);
      const previous = records[index]!;
      const displayName = patch.displayName?.trim();
      const next: WorkspaceRecord = {
        ...previous,
        updatedAt: now(),
        ...(displayName !== undefined && displayName !== '' ? { displayName } : {}),
        ...(patch.labels !== undefined ? { labels: patch.labels } : {}),
      };
      const copy = [...records];
      copy[index] = next;
      return { records: copy, result: next };
    });
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
    return this.store.mutate((records) => {
      const index = records.findIndex((record) => record.id === id);
      if (index < 0) throw new Error(`워크스페이스 없음: ${id}`);
      const timestamp = now();
      const next = { ...records[index]!, archivedAt: timestamp, updatedAt: timestamp };
      const copy = [...records];
      copy[index] = next;
      return { records: copy, result: next };
    });
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

  constructor(private readonly paths: DaemonPaths) {
    this.projects = new ProjectRegistry(paths.projectsDir);
    this.workspaces = new WorkspaceRegistry(paths.projectsDir);
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

  /** worktree 백킹 디렉토리 경로 (D-1 확정: 데이터 디렉토리 내부) */
  worktreePath(workspaceId: string): string {
    return join(this.paths.worktreesDir, workspaceId);
  }
}
