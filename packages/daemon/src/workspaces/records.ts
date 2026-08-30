// 프로젝트·워크스페이스 레코드 (workspace-model §2·§3) — 스키마와 식별자 정책의 단일 지점.
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';

export const PROJECT_ID_PREFIX = 'prj_';
export const WORKSPACE_ID_PREFIX = 'wsp_';

/** 불투명 ID — 경로에서 유도하지 않는다. 경로가 바뀌어도 같은 프로젝트다 */
export function newProjectId(): string {
  return `${PROJECT_ID_PREFIX}${randomBytes(8).toString('hex')}`;
}
export function newWorkspaceId(): string {
  return `${WORKSPACE_ID_PREFIX}${randomBytes(8).toString('hex')}`;
}

/**
 * 경로 정규화 (workspace-model 원칙 3) — lexical 정규화만 한다.
 * `realpath` 를 쓰지 않는 것이 핵심: 심링크로 연결된 두 경로를 하나로 합치면
 * "별도 작업 트리"라는 사용자 의도를 파괴한다.
 */
export function normalizeRoot(input: string): string {
  const resolved = resolve(input);
  // Windows 드라이브 문자만 대문자로 통일 (c:\repo 와 C:\repo 가 다른 프로젝트가 되지 않게)
  return /^[a-z]:/.test(resolved) ? resolved[0]!.toUpperCase() + resolved.slice(1) : resolved;
}

export const ProjectKindSchema = z.enum(['git', 'plain']);
export type ProjectKind = z.infer<typeof ProjectKindSchema>;

export const ProjectRecordSchema = z.looseObject({
  id: z.string(),
  /** 정규화된 절대 경로 — 불변 */
  root: z.string(),
  /** 사용자 편집 가능. 정합화가 덮지 않는다 */
  displayName: z.string(),
  /** 가변 — 정합화가 갱신 */
  kind: ProjectKindSchema,
  defaultBranch: z.string().optional(),
  remoteUrl: z.string().optional(),
  /** 호스트 횡단 그룹핑용 예약 필드 (workspace-model §2) */
  projectKey: z.string().optional(),
  iconRef: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().optional(),
});
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

export const WorkspaceIsolationSchema = z.enum(['directory', 'worktree']);
export type WorkspaceIsolation = z.infer<typeof WorkspaceIsolationSchema>;

export const WorkspaceSetupStateSchema = z.enum(['none', 'pending', 'ok', 'failed']);
export type WorkspaceSetupState = z.infer<typeof WorkspaceSetupStateSchema>;

export const WorkspaceRecordSchema = z.looseObject({
  id: z.string(),
  /** 불변 — 재귀속(rehome) 금지 */
  projectId: z.string(),
  /** 세션이 실행되는 정확한 디렉토리 — 불변 */
  cwd: z.string(),
  /** 백킹 체크아웃 루트. 모노레포 하위 패키지를 가리키면 cwd 와 다르다 */
  checkoutRoot: z.string(),
  isolation: WorkspaceIsolationSchema,
  /** 사용자 편집 가능. 정합화가 덮지 않는다 */
  displayName: z.string(),
  /** worktree 분기 기준 — 불변 */
  baseBranch: z.string().optional(),
  /** 현재 브랜치 — 가변(정합화 갱신) */
  branch: z.string().optional(),
  labels: z.record(z.string(), z.string()),
  /** worktree 복구용 메인 저장소 루트 */
  mainRepoRoot: z.string().optional(),
  setupState: WorkspaceSetupStateSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().optional(),
});
export type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;

/** 정합화가 갱신할 수 있는 프로젝트 필드 (workspace-model §4) */
export type ProjectFacts = Pick<ProjectRecord, 'kind' | 'defaultBranch' | 'remoteUrl'>;
/** 정합화가 갱신할 수 있는 워크스페이스 필드 */
export type WorkspaceFacts = Pick<WorkspaceRecord, 'branch'>;
