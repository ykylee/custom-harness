// 앱 루트 (WBS 1.5.1·2.4) — 연결 배너 + 라우팅 + 사이드바(버킷) + 탭/분할 페인 + 단축키.
// FR-3.3: 탭 닫기 ≠ 세션 종료, 배치는 localStorage 복원. 단축키(FR-3.3.4):
//   Mod+N 새 세션 뷰 · Mod+W 탭 닫기 · Mod+1~9 탭 선택 · Mod+. 활성 세션 중단
import { useEffect } from 'react';
import type { AppController } from './store/app-store.js';
import type { TabTarget } from './workbench/tabs.js';
import { targetOf } from './workbench/tabs.js';
import { useStore } from './store/store.js';
import { emptySessionView } from './timeline.js';
import { Sidebar } from './components/Sidebar.js';
import { Tabs } from './components/Tabs.js';
import { Conversation } from './views/Conversation.js';
import { Onboarding } from './views/Onboarding.js';
import { SessionCreate } from './views/SessionCreate.js';
import { TerminalView } from './views/TerminalView.js';
import { WorkspaceCreate } from './views/WorkspaceCreate.js';
import { Settings } from './views/Settings.js';

const CONNECTION_LABEL: Record<string, string> = {
  connecting: '데몬 연결 중…',
  reconnecting: '연결 끊김 — 재연결 중…',
  closed: '연결 종료됨',
};

/** 탭 타깃별 페인 — 새 타깃을 추가하면 여기 분기를 늘린다 (컴파일러가 누락을 잡는다) */
function Pane({
  target,
  controller,
}: {
  target: TabTarget;
  controller: AppController;
}): React.JSX.Element {
  const state = useStore(controller.store);
  switch (target.kind) {
    case 'session': {
      const { sessionId } = target;
      return (
        <Conversation
          view={state.views[sessionId] ?? emptySessionView()}
          autoApprove={state.autoApprove[sessionId] === true}
          actions={{
            prompt: (text) => void controller.prompt(sessionId, text),
            interrupt: () => void controller.interrupt(sessionId),
            respondPermission: (requestId, outcome) =>
              void controller.respondPermission(sessionId, requestId, outcome),
            setAutoApprove: (enabled) => controller.setAutoApprove(sessionId, enabled),
          }}
        />
      );
    }
    case 'terminal':
      return (
        <TerminalView
          terminalId={target.terminalId}
          transport={controller.terminalTransport}
          onError={(error) => controller.reportError(error)}
        />
      );
    // 파일·변경사항 뷰는 WBS 6.4·6.5 — 탭 모델은 이미 받아들인다
    case 'files':
    case 'file':
    case 'diff':
      return <div className="pane-placeholder">아직 구현되지 않은 뷰입니다 ({target.kind})</div>;
  }
}

export function App({ controller }: { controller: AppController }): React.JSX.Element {
  const state = useStore(controller.store);

  // 키보드 내비게이션 (WBS 2.4.3, FR-3.3.4)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const layout = controller.layout;
      if (event.key === 'n') {
        event.preventDefault();
        controller.showNewSessionView();
      } else if (event.key === 'w') {
        if (layout.active !== null) {
          event.preventDefault();
          controller.closeTab(layout.active);
        }
      } else if (event.key === '.') {
        const active = targetOf(layout, layout.active);
        if (active?.kind === 'session') {
          event.preventDefault();
          void controller.interrupt(active.sessionId);
        }
      } else if (/^[1-9]$/.test(event.key)) {
        const target = layout.tabs[Number(event.key) - 1];
        if (target !== undefined) {
          event.preventDefault();
          controller.setActiveTab(target.id);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller]);

  if (!state.bootstrapped) {
    return <div className="app-loading">{CONNECTION_LABEL[state.connection] ?? '준비 중…'}</div>;
  }

  if (state.route === 'onboarding') {
    return (
      <Onboarding
        gateway={state.gateway}
        harnesses={state.harnesses}
        actions={{
          saveGateway: (settings) => controller.saveGateway(settings),
          setKeyAndTest: (apiKey) => controller.setKeyAndTest(apiKey),
          finish: () => controller.navigate('main'),
        }}
      />
    );
  }

  const layout = controller.layout;
  const secondaryTarget = targetOf(layout, layout.split?.secondary);
  const activeTarget = targetOf(layout, layout.active);

  return (
    <div className="app">
      {state.connection !== 'connected' && (
        <div className="connection-banner" data-testid="connection-banner">
          {CONNECTION_LABEL[state.connection] ?? state.connection}
        </div>
      )}
      {state.lastError && (
        <div className="error-banner" onClick={() => controller.clearError()}>
          {state.lastError}
        </div>
      )}
      <Sidebar
        projects={state.projects}
        workspaces={state.workspaces}
        sessions={state.sessions}
        activeWorkspaceId={state.activeWorkspaceId}
        activeSessionId={layout.active}
        actions={{
          open: (sessionId) => void controller.openSession(sessionId),
          closeSession: (sessionId) => void controller.closeSession(sessionId),
          newSession: () => controller.showNewSessionView(),
          openSettings: () => controller.navigate('settings'),
          selectWorkspace: (workspaceId) => controller.selectWorkspace(workspaceId),
          newWorkspace: () => controller.navigate('workspace-create'),
          newTerminal: () => void controller.createTerminal(),
          archiveWorkspace: (workspaceId) => void controller.archiveWorkspace(workspaceId),
          renameWorkspace: (workspaceId, displayName) =>
            void controller.renameWorkspace(workspaceId, displayName),
          setWorkspaceLabels: (workspaceId, labels) =>
            void controller.setWorkspaceLabels(workspaceId, labels),
          runSetup: (workspaceId) => void controller.confirmAndRunSetup(workspaceId),
        }}
      />
      <main className="main-pane">
        {state.route === 'workspace-create' ? (
          <WorkspaceCreate
            projects={state.projects}
            actions={{
              openProject: (root) => controller.openProject(root),
              createWorkspace: (params) => controller.createWorkspace(params),
              cancel: () => controller.navigate('main'),
            }}
          />
        ) : state.route === 'settings' ? (
          <Settings
            gateway={state.gateway}
            keyState={state.keyState}
            harnesses={state.harnesses}
            probes={state.probes}
            maxSessions={state.maxSessions}
            notificationsEnabled={state.notificationsEnabled}
            autoApproveCount={Object.values(state.autoApprove).filter(Boolean).length}
            actions={{
              setKey: (apiKey) => controller.setKeyAndTest(apiKey),
              setDefaultModel: (modelId) => controller.setDefaultModel(modelId),
              probeHarness: (harness) => controller.probeHarness(harness),
              setNotificationsEnabled: (enabled) => controller.setNotificationsEnabled(enabled),
              back: () => controller.navigate('main'),
            }}
          />
        ) : (
          <>
            {layout.tabs.length > 0 && (
              <Tabs
                layout={layout}
                sessions={state.sessions}
                terminals={state.terminals}
                actions={{
                  activate: (sessionId) => controller.setActiveTab(sessionId),
                  closeTab: (sessionId) => controller.closeTab(sessionId),
                  setSplit: (direction) => controller.setSplit(direction),
                }}
              />
            )}
            {activeTarget === undefined ? (
              <SessionCreate
                harnesses={state.harnesses}
                gateway={state.gateway}
                workspace={
                  state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ??
                  null
                }
                onCreate={(params) => controller.createSession(params)}
                onNewWorkspace={() => controller.navigate('workspace-create')}
              />
            ) : (
              <div
                className={`panes ${secondaryTarget !== undefined ? `split-${layout.split!.direction}` : ''}`}
                data-testid="panes"
              >
                <div className="pane">
                  <Pane target={activeTarget} controller={controller} />
                </div>
                {secondaryTarget !== undefined && (
                  <div className="pane pane-secondary">
                    <Pane target={secondaryTarget} controller={controller} />
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
