// 탭 스트립 + 분할 컨트롤 (WBS 2.4.2 → 6.2, FR-8.1) — 탭 닫기는 대상 종료가 아니다.
import type { SessionSummary, Terminal } from '@custom-harness/protocol';
import { HarnessBadge } from './Sidebar.js';
import type { LayoutState, Tab, TabTarget } from '../workbench/tabs.js';

export interface TabsActions {
  activate(tabId: string): void;
  closeTab(tabId: string): void;
  setSplit(direction: 'row' | 'column' | null): void;
}

/** 타깃별 표시 — 세션은 상태·하네스까지, 나머지는 아이콘 + 이름 */
function TabLabel({
  target,
  sessions,
  terminals,
}: {
  target: TabTarget;
  sessions: SessionSummary[];
  terminals: Terminal[];
}): React.JSX.Element {
  switch (target.kind) {
    case 'session': {
      const summary = sessions.find((session) => session.sessionId === target.sessionId);
      const label = summary
        ? (summary.title ?? summary.cwd.split('/').pop() ?? summary.cwd)
        : target.sessionId.slice(0, 8);
      return (
        <>
          {summary && <span className={`status-dot status-${summary.status}`} />}
          {summary && <HarnessBadge harness={summary.harness} />}
          {label}
          {summary?.pendingPermissions?.length ? <span className="pending-badge">!</span> : null}
        </>
      );
    }
    case 'terminal': {
      const terminal = terminals.find((entry) => entry.id === target.terminalId);
      const name = terminal?.shell.split(/[\\/]/).pop() ?? 'terminal';
      return (
        <>
          <span className="tab-icon">▸</span>
          {name}
          {terminal?.exitedAt !== undefined && <span className="tab-exited">종료됨</span>}
        </>
      );
    }
    case 'files':
      return (
        <>
          <span className="tab-icon">▤</span>파일
        </>
      );
    case 'file':
      return (
        <>
          <span className="tab-icon">◧</span>
          {target.path.split('/').pop() ?? target.path}
        </>
      );
    case 'diff':
      return (
        <>
          <span className="tab-icon">±</span>
          {target.scope === 'working' ? '변경사항' : target.sha.slice(0, 8)}
        </>
      );
  }
}

export function Tabs({
  layout,
  sessions,
  terminals,
  actions,
}: {
  layout: LayoutState;
  sessions: SessionSummary[];
  terminals: Terminal[];
  actions: TabsActions;
}): React.JSX.Element {
  return (
    <div className="tab-strip" data-testid="tab-strip">
      <div className="tabs">
        {layout.tabs.map((tab: Tab) => (
          <div
            key={tab.id}
            className={`tab ${tab.id === layout.active ? 'active' : ''} ${
              tab.id === layout.split?.secondary ? 'secondary' : ''
            }`}
            data-testid={`tab-${tab.id}`}
          >
            <button className="tab-label" onClick={() => actions.activate(tab.id)}>
              <TabLabel target={tab.target} sessions={sessions} terminals={terminals} />
            </button>
            <button
              className="tab-close"
              title="탭 닫기 (대상은 유지)"
              onClick={() => actions.closeTab(tab.id)}
            >
              ×
            </button>
          </div>
        ))}
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
