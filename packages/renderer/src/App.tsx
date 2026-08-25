// 앱 루트 (WBS 1.5.1·2.4) — 연결 배너 + 라우팅 + 사이드바(버킷) + 탭/분할 페인 + 단축키.
// FR-3.3: 탭 닫기 ≠ 세션 종료, 배치는 localStorage 복원. 단축키(FR-3.3.4):
//   Mod+N 새 세션 뷰 · Mod+W 탭 닫기 · Mod+1~9 탭 선택 · Mod+. 활성 세션 중단
import { useEffect } from 'react';
import type { AppController } from './store/app-store.js';
import { useStore } from './store/store.js';
import { emptySessionView } from './timeline.js';
import { Sidebar } from './components/Sidebar.js';
import { Tabs } from './components/Tabs.js';
import { Conversation } from './views/Conversation.js';
import { Onboarding } from './views/Onboarding.js';
import { SessionCreate } from './views/SessionCreate.js';
import { Settings } from './views/Settings.js';

const CONNECTION_LABEL: Record<string, string> = {
  connecting: '데몬 연결 중…',
  reconnecting: '연결 끊김 — 재연결 중…',
  closed: '연결 종료됨',
};

function Pane({
  sessionId,
  controller,
}: {
  sessionId: string;
  controller: AppController;
}): React.JSX.Element {
  const state = useStore(controller.store);
  const view = state.views[sessionId] ?? emptySessionView();
  return (
    <Conversation
      view={view}
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

export function App({ controller }: { controller: AppController }): React.JSX.Element {
  const state = useStore(controller.store);

  // 키보드 내비게이션 (WBS 2.4.3, FR-3.3.4)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const { layout } = controller.store.get();
      if (event.key === 'n') {
        event.preventDefault();
        controller.showNewSessionView();
      } else if (event.key === 'w') {
        if (layout.active !== null) {
          event.preventDefault();
          controller.closeTab(layout.active);
        }
      } else if (event.key === '.') {
        if (layout.active !== null) {
          event.preventDefault();
          void controller.interrupt(layout.active);
        }
      } else if (/^[1-9]$/.test(event.key)) {
        const target = layout.tabs[Number(event.key) - 1];
        if (target !== undefined) {
          event.preventDefault();
          controller.setActiveTab(target);
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

  const { layout } = state;
  const secondary = layout.split?.secondary;

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
        sessions={state.sessions}
        activeSessionId={layout.active}
        actions={{
          open: (sessionId) => void controller.openSession(sessionId),
          closeSession: (sessionId) => void controller.closeSession(sessionId),
          newSession: () => controller.showNewSessionView(),
          openSettings: () => controller.navigate('settings'),
        }}
      />
      <main className="main-pane">
        {state.route === 'settings' ? (
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
                actions={{
                  activate: (sessionId) => controller.setActiveTab(sessionId),
                  closeTab: (sessionId) => controller.closeTab(sessionId),
                  setSplit: (direction) => controller.setSplit(direction),
                }}
              />
            )}
            {layout.active === null || layout.active === '' ? (
              <SessionCreate
                harnesses={state.harnesses}
                gateway={state.gateway}
                onCreate={(params) => controller.createSession(params)}
              />
            ) : (
              <div
                className={`panes ${secondary !== undefined ? `split-${layout.split!.direction}` : ''}`}
                data-testid="panes"
              >
                <div className="pane">
                  <Pane sessionId={layout.active} controller={controller} />
                </div>
                {secondary !== undefined && (
                  <div className="pane pane-secondary">
                    <Pane sessionId={secondary} controller={controller} />
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
