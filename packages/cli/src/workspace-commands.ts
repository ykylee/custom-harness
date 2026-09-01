// CLI 워크스페이스 명령 (M7 WBS 7.5.2, FR-9.6) — 목록·생성·아카이브.
//
// 세션 명령(7.5.1)과 같은 출력 규약을 따른다: `--json` 은 한 줄짜리 기계 판독 출력,
// 사람이 읽는 출력은 한 줄에 한 워크스페이스.
//
// **스크립트는 디렉토리를 알지 projectId 를 모른다.** 그래서 `--root` 로도 만들 수 있게
// 했다 — 그 경우 `project.open` 으로 프로젝트를 열어 id 를 얻는다(세션 생성이 cwd 로
// 워크스페이스를 유도하는 것과 같은 성격의 편의 경로다, FR-9.6).
import type { Project, SessionSummary, Workspace } from '@custom-harness/protocol';
import type { CliIo } from './io.js';
import type { DaemonConnection } from './connection.js';

export interface WorkspaceCommandContext {
  connection: DaemonConnection;
  io: CliIo;
  json: boolean;
}

/** 실패는 언제나 stderr — `--json` 이면 기계가 읽는 봉투로 (7.5.3 §출력 규약) */
function failOut(context: WorkspaceCommandContext, code: string, message: string): void {
  context.io.err(context.json ? JSON.stringify({ error: { code, message } }) : message);
}

export async function cmdWorkspaceList(
  context: WorkspaceCommandContext,
  options: { projectId?: string | undefined; all: boolean },
): Promise<number> {
  const { workspaces } = await context.connection.rpc<{ workspaces: Workspace[] }>(
    'workspace.list',
    {
      ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
      ...(options.all ? { includeArchived: true } : {}),
    },
  );
  if (context.json) {
    context.io.out(JSON.stringify({ workspaces }));
    return 0;
  }
  if (workspaces.length === 0) {
    context.io.out(options.all ? '워크스페이스 없음' : '활성 워크스페이스 없음 (--all 로 전체)');
    return 0;
  }
  for (const workspace of workspaces) {
    const branch = workspace.branch !== undefined ? `  ${workspace.branch}` : '';
    const archived = workspace.archivedAt !== undefined ? '  (아카이브됨)' : '';
    context.io.out(
      `${workspace.id}  ${workspace.isolation}${branch}  ${workspace.setupState}` +
        `  ${workspace.displayName}  ${workspace.cwd}${archived}`,
    );
  }
  return 0;
}

export async function cmdWorkspaceNew(
  context: WorkspaceCommandContext,
  options: {
    projectId?: string | undefined;
    root?: string | undefined;
    isolation: 'directory' | 'worktree';
    cwd?: string | undefined;
    branch?: string | undefined;
    baseBranch?: string | undefined;
    displayName?: string | undefined;
  },
): Promise<number> {
  let projectId = options.projectId;
  if (projectId === undefined) {
    if (options.root === undefined) {
      failOut(context, 'bad_request', '--project 또는 --root 중 하나가 필요합니다');
      return 2;
    }
    // 멱등 — 이미 열린 프로젝트면 그 레코드를 돌려준다 (project.open 계약)
    const opened = await context.connection.rpc<{ project: Project }>('project.open', {
      root: options.root,
    });
    projectId = opened.project.id;
  }
  // directory 격리는 cwd 가 필수다. `--root` 만 준 경우 그 디렉토리를 가리키는 것이
  // "이 디렉토리로 워크스페이스를 만들어라"의 자연스러운 뜻이므로 기본값으로 채운다.
  // worktree 격리는 데몬이 백킹 체크아웃을 직접 만들므로 비워 둔다.
  const cwd = options.cwd ?? (options.isolation === 'directory' ? options.root : undefined);
  if (options.isolation === 'directory' && cwd === undefined) {
    failOut(
      context,
      'bad_request',
      'directory 격리에는 --cwd 가 필요합니다 (--root 를 주면 그 경로가 기본값)',
    );
    return 2;
  }
  let workspace: Workspace;
  try {
    ({ workspace } = await context.connection.rpc<{ workspace: Workspace }>('workspace.create', {
      projectId,
      isolation: options.isolation,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(options.branch !== undefined ? { branch: options.branch } : {}),
      ...(options.baseBranch !== undefined ? { baseBranch: options.baseBranch } : {}),
      ...(options.displayName !== undefined ? { displayName: options.displayName } : {}),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failOut(context, 'create_failed', message);
    // `--branch` 단독은 **기존** 브랜치 체크아웃이다. 새 브랜치를 파려던 스크립트에는
    // git 의 `invalid reference` 만으로는 무엇을 고쳐야 하는지 보이지 않는다.
    if (
      options.isolation === 'worktree' &&
      options.baseBranch === undefined &&
      /invalid reference|not a valid ref/i.test(message)
    ) {
      context.io.err(
        `'${options.branch ?? ''}' 브랜치가 없습니다 — 새로 만들려면 --base-branch <기준> 을 함께 주세요`,
      );
    }
    return 1;
  }
  if (context.json) context.io.out(JSON.stringify({ workspace }));
  else context.io.out(workspace.id); // 파이프로 바로 넘길 수 있게 id 만
  return 0;
}

export async function cmdWorkspaceArchive(
  context: WorkspaceCommandContext,
  options: { workspaceId: string; removeCheckout: boolean; force: boolean },
): Promise<number> {
  // 아카이브는 그 워크스페이스의 세션을 멈추지 않는다 — 돌고 있는 작업을 모른 채
  // 정리하지 않도록 먼저 본다. 비대화형이므로 확인은 --force 로 갈음한다(daemon stop 과 같은 규약).
  if (!options.force) {
    const { sessions } = await context.connection.rpc<{ sessions: SessionSummary[] }>(
      'session.list',
      { workspaceId: options.workspaceId },
    );
    const active = sessions.filter((s) => s.status !== 'closed');
    if (active.length > 0) {
      failOut(
        context,
        'busy',
        `이 워크스페이스에 활성 세션 ${active.length}개가 있습니다 — 그래도 진행하려면 --force\n` +
          active.map((s) => `  ${s.sessionId}  ${s.harness}  ${s.status}`).join('\n'),
      );
      return 1;
    }
  }
  const { workspace } = await context.connection.rpc<{ workspace: Workspace }>(
    'workspace.archive',
    {
      workspaceId: options.workspaceId,
      // 체크아웃 삭제는 되돌릴 수 없다 — 명시 플래그가 곧 확인이다.
      // 데몬은 여기에 더해 **관리 밖 경로는 거절**한다(사용자 자기 디렉토리를 지우지 않는다).
      ...(options.removeCheckout ? { removeCheckout: true } : {}),
    },
  );
  if (context.json) {
    context.io.out(JSON.stringify({ workspace }));
  } else {
    context.io.out(
      `아카이브: ${workspace.id}` +
        (options.removeCheckout ? ` (체크아웃 제거: ${workspace.checkoutRoot})` : ''),
    );
  }
  return 0;
}
