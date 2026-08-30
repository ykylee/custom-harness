// 프로젝트·워크스페이스 레코드 (workspace-model §2·§3) — 식별자 정책과 정규화의 단일 지점.
//
// 스키마 자체는 protocol 패키지가 정본이다. 영속 레코드와 와이어 레코드를 두 벌로 두면
// 필드가 조용히 갈라진다 — 같은 스키마를 저장에도 그대로 쓴다.
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import {
  ProjectSchema,
  WorkspaceSchema,
  type Project,
  type Workspace,
} from '@custom-harness/protocol';

export const ProjectRecordSchema = ProjectSchema;
export const WorkspaceRecordSchema = WorkspaceSchema;
export type ProjectRecord = Project;
export type WorkspaceRecord = Workspace;

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

/** 정합화가 갱신할 수 있는 프로젝트 필드 (workspace-model §4) */
export type ProjectFacts = Pick<ProjectRecord, 'kind' | 'defaultBranch' | 'remoteUrl'>;
/** 정합화가 갱신할 수 있는 워크스페이스 필드 */
export type WorkspaceFacts = Pick<WorkspaceRecord, 'branch'>;
