// 탭 스트립 + 분할 컨트롤 (WBS 2.4.2, FR-3.3.2/3) — 탭 닫기는 세션 종료가 아니다.
import type { SessionSummary } from '@custom-harness/protocol';
import { HarnessBadge } from './Sidebar.js';
import type { LayoutState } from '../store/app-store.js';

export interface TabsActions {
  activate(sessionId: string): void;
  closeTab(sessionId: string): void;
  setSplit(direction: 'row' | 'column' | null): void;
}

export function Tabs({
  layout,
  sessions,
  actions,
}: {
  layout: LayoutState;
  sessions: SessionSummary[];
  actions: TabsActions;
}): React.JSX.Element {
  const summaryOf = (id: string): SessionSummary | undefined =>
    sessions.find((s) => s.sessionId === id);
  return (
    <div className="tab-strip" data-testid="tab-strip">
      <div className="tabs">
        {layout.tabs.map((sessionId) => {
          const summary = summaryOf(sessionId);
          const label = summary
            ? (summary.cwd.split('/').pop() ?? summary.cwd)
            : sessionId.slice(0, 8);
          return (
            <div
              key={sessionId}
              className={`tab ${sessionId === layout.active ? 'active' : ''} ${
                sessionId === layout.split?.secondary ? 'secondary' : ''
              }`}
              data-testid={`tab-${sessionId}`}
            >
              <button className="tab-label" onClick={() => actions.activate(sessionId)}>
                {summary && <span className={`status-dot status-${summary.status}`} />}
                {summary && <HarnessBadge harness={summary.harness} />}
                {label}
                {summary?.pendingPermissions?.length ? (
                  <span className="pending-badge">!</span>
                ) : null}
              </button>
              <button
                className="tab-close"
                title="탭 닫기 (세션은 유지)"
                onClick={() => actions.closeTab(sessionId)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      {layout.tabs.length >= 2 && (
        <div className="split-controls">
          <button
            className={layout.split?.direction === 'row' ? 'active' : ''}
            title="좌우 분할"
            onClick={() => actions.setSplit(layout.split?.direction === 'row' ? null : 'row')}
          >
            ◫
          </button>
          <button
            className={layout.split?.direction === 'column' ? 'active' : ''}
            title="상하 분할"
            onClick={() => actions.setSplit(layout.split?.direction === 'column' ? null : 'column')}
          >
            ⬓
          </button>
        </div>
      )}
    </div>
  );
}
