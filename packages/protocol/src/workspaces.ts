// 프로젝트·워크스페이스 와이어 스키마 (workspace-model §3) — 영속 레코드와 같은 형태를 쓴다.
// 두 벌로 나누면 필드가 조용히 갈라진다. 데몬은 이 스키마를 그대로 저장에도 쓴다.
import { z } from 'zod';

export const ProjectKindSchema = z.enum(['git', 'plain']);
export type ProjectKind = z.infer<typeof ProjectKindSchema>;

export const ProjectSchema = z.looseObject({
  id: z.string(),
  /** 정규화된 절대 경로 — 불변 (lexical 정규화만, realpath 금지) */
  root: z.string(),
  /** 사용자 편집 가능. 정합화가 덮지 않는다 */
  displayName: z.string(),
  /** 가변 — 정합화가 갱신 */
  kind: ProjectKindSchema,
  defaultBranch: z.string().optional(),
  remoteUrl: z.string().optional(),
  /** 호스트 횡단 그룹핑용 예약 필드 — 소비자는 live git 에서 재유도하지 않는다 */
  projectKey: z.string().optional(),
  iconRef: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const WorkspaceIsolationSchema = z.enum(['directory', 'worktree']);
export type WorkspaceIsolation = z.infer<typeof WorkspaceIsolationSchema>;

/** 프로젝트 설정 파일(harness.json) setup 실행 상태 — pending 은 신뢰 확인 대기 */
export const WorkspaceSetupStateSchema = z.enum(['none', 'pending', 'ok', 'failed']);
export type WorkspaceSetupState = z.infer<typeof WorkspaceSetupStateSchema>;

export const WorkspaceSchema = z.looseObject({
  id: z.string(),
  /** 불변 — 재귀속(rehome) 금지 */
  projectId: z.string(),
  /** 세션이 실행되는 정확한 디렉토리 — 불변 */
  cwd: z.string(),
  /** 백킹 체크아웃 루트. 모노레포 하위 패키지를 가리키면 cwd 와 다르다 */
  checkoutRoot: z.string(),
  isolation: WorkspaceIsolationSchema,
  displayName: z.string(),
  /** worktree 분기 기준 — 불변 */
  baseBranch: z.string().optional(),
  /** 현재 브랜치 — 가변(정합화 갱신) */
  branch: z.string().optional(),
  labels: z.record(z.string(), z.string()),
  mainRepoRoot: z.string().optional(),
  setupState: WorkspaceSetupStateSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().optional(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

// ── 레지스트리 이벤트 (데몬 → 클라이언트) ──────────────────────────────────
//
// 세션 이벤트와 달리 sessionId·seq 봉투를 쓰지 않는다. 레지스트리는 목록 자체가 작고
// 재연결 시 전체 재조회가 싸므로, 갭 감지 대신 "바뀌었으니 다시 읽어라" 신호로 충분하다.

export const RegistryChangeReasonSchema = z.enum(['created', 'updated', 'archived']);
export type RegistryChangeReason = z.infer<typeof RegistryChangeReasonSchema>;

export const RegistryEventSchema = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('project_changed'),
    reason: RegistryChangeReasonSchema,
    project: ProjectSchema,
  }),
  z.looseObject({
    type: z.literal('workspace_changed'),
    reason: RegistryChangeReasonSchema,
    workspace: WorkspaceSchema,
  }),
  /** 변경사항이 바뀌었다는 신호 — 내용은 diff.get 으로 회수한다 (WBS 6.5) */
  z.looseObject({
    type: z.literal('diff_changed'),
    workspaceId: z.string(),
  }),
]);
export type RegistryEvent = z.infer<typeof RegistryEventSchema>;
