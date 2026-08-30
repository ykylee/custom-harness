// 사이드바 (WBS 5.6.1, FR-7.6) — 프로젝트 → 워크스페이스 → 세션 3계층.
//
// 상태 버킷(승인 대기·실행 중·…)은 계층을 대체하지 않고 **횡단 필터**로 남는다.
// 버킷으로만 묶으면 "지금 무엇이 급한가"는 보이지만 "어디서 일하고 있는가"가 사라진다.
import { useState } from 'react';
import type { Project, SessionSummary, Workspace } from '@custom-harness/protocol';

/** 하네스 아이콘 — 폐쇄망 자산 없이 텍스트 배지 (색상은 styles.css harness-*) */
export function HarnessBadge({ harness }: { harness: string }): React.JSX.Element {
  return <span className={`harness-badge harness-${harness}`}>{harness}</span>;
}

type Bucket = 'approval' | 'running' | 'idle' | 'error' | 'closed';

const BUCKET_ORDER: Bucket[] = ['approval', 'running', 'idle', 'error', 'closed'];
const BUCKET_LABEL: Record<Bucket, string> = {
  approval: '승인 대기',
  running: '실행 중',
  idle: '유휴',
  error: '에러',
  closed: '완료·보관',
};

export function bucketOf(session: SessionSummary): Bucket {
  if (session.pendingPermissions?.length) return 'approval';
  if (session.status === 'running') return 'running';
  if (session.status === 'error') return 'error';
  if (session.status === 'closed') return 'closed';
  return 'idle'; // idle · initializing
}

export interface SidebarActions {
  renameWorkspace(workspaceId: string, displayName: string): void;
  setWorkspaceLabels(workspaceId: string, labels: Record<string, string>): void;
  open(sessionId: string): void;
  closeSession(sessionId: string): void;
  newSession(): void;
  openSettings(): void;
  selectWorkspace(workspaceId: string): void;
  newWorkspace(): void;
  archiveWorkspace(workspaceId: string): void;
  runSetup(workspaceId: string): void;
}

/** 워크스페이스 소속 판정은 workspaceId 로만 한다 — cwd 비교로 형제를 섞지 않는다 (FR-7.3) */
function sessionsOf(sessions: SessionSummary[], workspaceId: string): SessionSummary[] {
  return sessions.filter((session) => session.workspaceId === workspaceId);
}

function SessionEntry({
  session,
  activeSessionId,
  actions,
}: {
  session: SessionSummary;
  activeSessionId: string | null;
  actions: SidebarActions;
}): React.JSX.Element {
  return (
    <li className={session.sessionId === activeSessionId ? 'selected' : ''}>
      <button
        className="session-entry"
        data-testid={`session-${session.sessionId}`}
        onClick={() => actions.open(session.sessionId)}
      >
        <span className={`status-dot status-${session.status}`} />
        <HarnessBadge harness={session.harness} />
        <span className="session-cwd" title={session.cwd}>
          {session.title ?? session.cwd.split('/').pop() ?? session.cwd}
        </span>
        {session.pendingPermissions?.length ? (
          <span className="pending-badge" data-testid="pending-badge">
            승인 {session.pendingPermissions.length}
          </span>
        ) : null}
        {session.usage?.totalTokens !== undefined && (
          <span className="session-usage">{session.usage.totalTokens.toLocaleString()}tk</span>
        )}
      </button>
      {session.status !== 'closed' && (
        <button
          className="session-close"
          title="세션 종료 (이력 유지 — 재개 가능)"
          onClick={() => actions.closeSession(session.sessionId)}
        >
          ⏻
        </button>
      )}
    </li>
  );
}

/** 워크스페이스 인라인 편집 (WBS 5.6.3) — 표시 이름·라벨. 저장 전까지 로컬 상태만 만진다 */
function WorkspaceEditor({
  workspace,
  actions,
  onClose,
}: {
  workspace: Workspace;
  actions: SidebarActions;
  onClose: () => void;
}): React.JSX.Element {
  const [name, setName] = useState(workspace.displayName);
  const [labelText, setLabelText] = useState(
    Object.entries(workspace.labels)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  );

  const save = (): void => {
    const trimmed = name.trim();
    if (trimmed !== '' && trimmed !== workspace.displayName) {
      actions.renameWorkspace(workspace.id, trimmed);
    }
    const labels: Record<string, string> = {};
    for (const line of labelText.split('\n')) {
      const [key, ...rest] = line.split('=');
      const trimmedKey = key?.trim() ?? '';
      const value = rest.join('=').trim();
      if (trimmedKey !== '' && value !== '') labels[trimmedKey] = value;
    }
    actions.setWorkspaceLabels(workspace.id, labels);
    onClose();
  };

  return (
    <div className="workspace-editor" data-testid={`editor-${workspace.id}`}>
      <label>
        표시 이름
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        라벨 (한 줄에 <code>key=value</code>)
        <textarea
          rows={3}
          value={labelText}
          onChange={(event) => setLabelText(event.target.value)}
        />
      </label>
      <div className="workspace-editor-actions">
        <button data-testid={`editor-save-${workspace.id}`} onClick={() => save()}>
          저장
        </button>
        <button onClick={() => onClose()}>취소</button>
      </div>
    </div>
  );
}

function WorkspaceGroup({
  workspace,
  sessions,
  activeWorkspaceId,
  activeSessionId,
  actions,
}: {
  workspace: Workspace;
  sessions: SessionSummary[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  actions: SidebarActions;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const owned = sessionsOf(sessions, workspace.id);
  const pending = owned.filter((session) => session.pendingPermissions?.length).length;
  return (
    <li className={`workspace ${workspace.id === activeWorkspaceId ? 'workspace-active' : ''}`}>
      <div className="workspace-head">
        <button
          className="workspace-entry"
          data-testid={`workspace-${workspace.id}`}
          onClick={() => actions.selectWorkspace(workspace.id)}
          title={workspace.cwd}
        >
          <span className={`isolation-badge isolation-${workspace.isolation}`}>
            {workspace.isolation === 'worktree' ? 'wt' : 'dir'}
          </span>
          <span className="workspace-name">{workspace.displayName}</span>
          {workspace.branch !== undefined && (
            <span className="workspace-branch">{workspace.branch}</span>
          )}
          {pending > 0 && <span className="pending-badge">승인 {pending}</span>}
        </button>
        {workspace.setupState === 'pending' && (
          <button
            className="workspace-setup"
            title="프로젝트 설정 파일의 setup 실행 (내용 확인 후 동의 필요)"
            data-testid={`setup-${workspace.id}`}
            onClick={() => actions.runSetup(workspace.id)}
          >
            setup
          </button>
        )}
        <button
          className="workspace-edit"
          title="이름·라벨 편집"
          data-testid={`edit-${workspace.id}`}
          onClick={() => setEditing((previous) => !previous)}
        >
          ✎
        </button>
        <button
          className="workspace-archive"
          title="워크스페이스 보관 (세션 이력은 유지)"
          onClick={() => actions.archiveWorkspace(workspace.id)}
        >
          ▤
        </button>
      </div>
      {editing && (
        <WorkspaceEditor
          workspace={workspace}
          actions={actions}
          onClose={() => setEditing(false)}
        />
      )}
      {Object.keys(workspace.labels).length > 0 && (
        <div className="workspace-labels">
          {Object.entries(workspace.labels).map(([key, value]) => (
            <span key={key} className="workspace-label">
              {key}:{value}
            </span>
          ))}
        </div>
      )}
      <ul className="session-list">
        {owned.map((session) => (
          <SessionEntry
            key={session.sessionId}
            session={session}
            activeSessionId={activeSessionId}
            actions={actions}
          />
        ))}
      </ul>
    </li>
  );
}

export function Sidebar({
  projects,
  workspaces,
  sessions,
  activeWorkspaceId,
  activeSessionId,
  actions,
}: {
  projects: Project[];
  workspaces: Workspace[];
  sessions: SessionSummary[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  actions: SidebarActions;
}): React.JSX.Element {
  const [filter, setFilter] = useState<Bucket | 'all'>('all');

  const counts = new Map<Bucket, number>();
  for (const session of sessions) {
    const bucket = bucketOf(session);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  const visible =
    filter === 'all' ? sessions : sessions.filter((session) => bucketOf(session) === filter);

  // 워크스페이스에 귀속되지 않은 세션(백필 실패 등)도 잃어버리지 않는다
  const orphans = visible.filter(
    (session) =>
      session.workspaceId === undefined ||
      !workspaces.some((workspace) => workspace.id === session.workspaceId),
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-actions">
        <button className="new-session" onClick={() => actions.newSession()}>
          + 새 세션
        </button>
        <button className="new-workspace" onClick={() => actions.newWorkspace()}>
          + 워크스페이스
        </button>
        <button className="settings-link" onClick={() => actions.openSettings()}>
          설정
        </button>
      </div>

      <div className="bucket-filter" data-testid="bucket-filter">
        <button
          className={filter === 'all' ? 'selected' : ''}
          onClick={() => setFilter('all')}
          title="모든 세션"
        >
          전체 <span className="bucket-count">{sessions.length}</span>
        </button>
        {BUCKET_ORDER.filter((bucket) => (counts.get(bucket) ?? 0) > 0).map((bucket) => (
          <button
            key={bucket}
            className={filter === bucket ? 'selected' : ''}
            data-testid={`filter-${bucket}`}
            onClick={() => setFilter(filter === bucket ? 'all' : bucket)}
          >
            {BUCKET_LABEL[bucket]} <span className="bucket-count">{counts.get(bucket)}</span>
          </button>
        ))}
      </div>

      {projects.length === 0 && (
        <p className="sidebar-empty">
          아직 연 프로젝트가 없습니다. <strong>+ 워크스페이스</strong> 로 디렉토리를 여세요.
        </p>
      )}

      {projects.map((project) => {
        const owned = workspaces.filter((workspace) => workspace.projectId === project.id);
        return (
          <section key={project.id} className="project" data-testid={`project-${project.id}`}>
            <h4 className="project-title" title={project.root}>
              {project.displayName}
              {project.kind === 'git' && project.defaultBranch !== undefined && (
                <span className="project-branch">{project.defaultBranch}</span>
              )}
            </h4>
            <ul className="workspace-list">
              {owned.map((workspace) => (
                <WorkspaceGroup
                  key={workspace.id}
                  workspace={workspace}
                  sessions={visible}
                  activeWorkspaceId={activeWorkspaceId}
                  activeSessionId={activeSessionId}
                  actions={actions}
                />
              ))}
            </ul>
          </section>
        );
      })}

      {orphans.length > 0 && (
        <section className="project project-orphan" data-testid="orphan-sessions">
          <h4 className="project-title">워크스페이스 미지정</h4>
          <ul className="session-list">
            {orphans.map((session) => (
              <SessionEntry
                key={session.sessionId}
                session={session}
                activeSessionId={activeSessionId}
                actions={actions}
              />
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
