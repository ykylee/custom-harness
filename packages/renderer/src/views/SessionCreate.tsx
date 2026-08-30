// 세션 생성 화면 (WBS 1.5.2 → 5.6.4, FR-3.1·FR-7.3) — 하네스·모델 선택.
//
// 작업 디렉토리 직접 입력은 폐지됐다: 세션은 워크스페이스에 귀속되고 cwd 는 거기서 온다.
// 워크스페이스를 고르는 곳은 사이드바다 — 여기서는 무엇으로 일할지만 정한다.
import { useState } from 'react';
import type { HarnessId, HarnessInfo, Workspace } from '@custom-harness/protocol';
import type { GatewaySettings } from '../store/app-store.js';

export function SessionCreate({
  harnesses,
  gateway,
  workspace,
  onCreate,
  onNewWorkspace,
}: {
  harnesses: HarnessInfo[];
  gateway: GatewaySettings | null;
  /** 세션이 귀속될 워크스페이스. 없으면 먼저 만들어야 한다 */
  workspace: Workspace | null;
  onCreate: (params: {
    harness: HarnessId;
    workspaceId: string;
    modelId?: string;
  }) => Promise<void>;
  onNewWorkspace: () => void;
}): React.JSX.Element {
  const [harness, setHarness] = useState<HarnessId | ''>(harnesses[0]?.id ?? '');
  const [modelId, setModelId] = useState(gateway?.defaultModel ?? '');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  if (workspace === null) {
    return (
      <div className="session-create">
        <h2>새 세션</h2>
        <p className="hint">
          세션은 워크스페이스 안에서 만들어집니다. 먼저 프로젝트를 열어 워크스페이스를 만드세요.
        </p>
        <button onClick={() => onNewWorkspace()}>워크스페이스 만들기</button>
      </div>
    );
  }

  const create = async (): Promise<void> => {
    if (!harness) return;
    setCreating(true);
    setError(null);
    try {
      await onCreate({
        harness,
        workspaceId: workspace.id,
        ...(modelId ? { modelId } : {}),
      });
    } catch (err) {
      // 원인별 안내 (FR-3.1.2) — 데몬 RpcError 메시지 표출
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="session-create">
      <h2>새 세션</h2>
      <div className="session-create-workspace" data-testid="target-workspace">
        <span className={`isolation-badge isolation-${workspace.isolation}`}>
          {workspace.isolation === 'worktree' ? 'wt' : 'dir'}
        </span>
        <strong>{workspace.displayName}</strong>
        {workspace.branch !== undefined && (
          <span className="workspace-branch">{workspace.branch}</span>
        )}
        <code className="workspace-path">{workspace.cwd}</code>
      </div>
      {workspace.setupState === 'pending' && (
        <p className="hint" data-testid="setup-pending-hint">
          이 프로젝트에는 아직 실행하지 않은 설정 파일(setup)이 있습니다. 사이드바에서 내용을
          확인하고 실행할 수 있습니다.
        </p>
      )}
      <label>
        하네스
        <select value={harness} onChange={(event) => setHarness(event.target.value as HarnessId)}>
          {harnesses.map((h) => (
            <option key={h.id} value={h.id}>
              {h.id}
            </option>
          ))}
        </select>
      </label>
      <label>
        모델
        <select value={modelId} onChange={(event) => setModelId(event.target.value)}>
          <option value="">(하네스 기본값)</option>
          {(gateway?.models ?? []).map((model) => (
            <option key={model.id} value={model.id}>
              {model.name ?? model.id}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <div className="create-error" data-testid="create-error">
          세션 생성 실패: {error}
        </div>
      )}
      <button onClick={() => void create()} disabled={creating || !harness}>
        {creating ? '생성 중…' : '세션 생성'}
      </button>
    </div>
  );
}
