// 워크스페이스 생성 (WBS 5.6.2, FR-7.4/7.6) — 디렉토리 열기 / 새 브랜치 / 기존 브랜치.
//
// 폐쇄망 데스크톱이라 네이티브 폴더 픽커가 없는 환경도 있다 — 경로 직접 입력을 1급으로 두고,
// 이미 연 프로젝트는 목록에서 고르게 한다.
import { useState } from 'react';
import type { Project } from '@custom-harness/protocol';
import { FormActions, FormSection, FormShell } from '../components/FormLayout.js';

export type WorkspaceCreateMode = 'directory' | 'worktree-new' | 'worktree-existing';

export interface WorkspaceCreateActions {
  openProject(root: string): Promise<void>;
  createWorkspace(params: {
    projectId: string;
    isolation: 'directory' | 'worktree';
    cwd?: string;
    branch?: string;
    baseBranch?: string;
    displayName?: string;
  }): Promise<void>;
  cancel(): void;
}

export function WorkspaceCreate({
  projects,
  actions,
}: {
  projects: Project[];
  actions: WorkspaceCreateActions;
}): React.JSX.Element {
  const [root, setRoot] = useState('');
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [mode, setMode] = useState<WorkspaceCreateMode>('directory');
  const [cwd, setCwd] = useState('');
  const [branch, setBranch] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const project = projects.find((candidate) => candidate.id === projectId);
  const gitOnly = project?.kind === 'git';

  const guard = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (!project) return;
    await guard(async () => {
      if (mode === 'directory') {
        await actions.createWorkspace({
          projectId: project.id,
          isolation: 'directory',
          cwd: cwd.trim() === '' ? project.root : cwd.trim(),
          ...(displayName.trim() !== '' ? { displayName: displayName.trim() } : {}),
        });
        return;
      }
      await actions.createWorkspace({
        projectId: project.id,
        isolation: 'worktree',
        ...(branch.trim() !== '' ? { branch: branch.trim() } : {}),
        // 새 브랜치는 기본 브랜치에서 분기한다. 기존 브랜치 체크아웃이면 baseBranch 를 보내지 않는다
        ...(mode === 'worktree-new' && project.defaultBranch !== undefined
          ? { baseBranch: project.defaultBranch }
          : {}),
        ...(displayName.trim() !== '' ? { displayName: displayName.trim() } : {}),
      });
    });
  };

  return (
    <FormShell className="workspace-create">
      <h2>워크스페이스</h2>

      <FormSection className="workspace-create-open">
        <h3>프로젝트 열기</h3>
        <p className="hint">디렉토리를 열면 기본 워크스페이스가 함께 만들어집니다.</p>
        <label>
          프로젝트 경로
          <input
            value={root}
            placeholder="/path/to/project"
            onChange={(event) => setRoot(event.target.value)}
          />
        </label>
        <FormActions>
          <button
            data-testid="open-project"
            disabled={busy || root.trim() === ''}
            onClick={() => void guard(() => actions.openProject(root.trim()))}
          >
            열기
          </button>
        </FormActions>
      </FormSection>

      {projects.length > 0 && (
        <FormSection className="workspace-create-add">
          <h3>워크스페이스 추가</h3>
          <label>
            프로젝트
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              {projects.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            격리 방식
            <select
              value={mode}
              data-testid="isolation-mode"
              onChange={(event) => setMode(event.target.value as WorkspaceCreateMode)}
            >
              <option value="directory">디렉토리 (체크아웃 공유)</option>
              <option value="worktree-new" disabled={!gitOnly}>
                worktree — 새 브랜치 분기
              </option>
              <option value="worktree-existing" disabled={!gitOnly}>
                worktree — 기존 브랜치 체크아웃
              </option>
            </select>
          </label>
          {!gitOnly && (
            <p className="hint">git 프로젝트가 아니면 디렉토리 격리만 쓸 수 있습니다.</p>
          )}

          {mode === 'directory' ? (
            <label>
              작업 디렉토리 (비우면 프로젝트 루트)
              <input
                value={cwd}
                placeholder={project?.root ?? ''}
                onChange={(event) => setCwd(event.target.value)}
              />
            </label>
          ) : (
            <label>
              브랜치 {mode === 'worktree-new' && '(비우면 자동 생성)'}
              <input
                value={branch}
                placeholder={mode === 'worktree-new' ? 'harness/작업-이름' : 'feature/x'}
                onChange={(event) => setBranch(event.target.value)}
              />
            </label>
          )}
          <label>
            표시 이름 (선택)
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>

          <FormActions>
            <button
              data-testid="create-workspace"
              disabled={busy || !project || (mode === 'worktree-existing' && branch.trim() === '')}
              onClick={() => void submit()}
            >
              {busy ? '만드는 중…' : '워크스페이스 만들기'}
            </button>
          </FormActions>
        </FormSection>
      )}

      {error !== null && (
        <div className="create-error" data-testid="workspace-create-error">
          실패: {error}
        </div>
      )}
      <FormActions>
        <button className="cancel" onClick={() => actions.cancel()}>
          닫기
        </button>
      </FormActions>
    </FormShell>
  );
}
