// 앱 루트 (WBS 1.5.1) — 연결 배너 + 라우팅(온보딩/메인/설정) + 세션 목록 사이드바.
// 멀티 세션 탭·분할(FR-3.3)은 M2 — 1차는 목록 + 단일 대화 뷰.
import type { AppController } from './store/app-store.js';
import { useStore } from './store/store.js';
import { emptySessionView } from './timeline.js';
import { Conversation } from './views/Conversation.js';
import { Onboarding } from './views/Onboarding.js';
import { SessionCreate } from './views/SessionCreate.js';
import { Settings } from './views/Settings.js';

const CONNECTION_LABEL: Record<string, string> = {
  connecting: '데몬 연결 중…',
  reconnecting: '연결 끊김 — 재연결 중…',
  closed: '연결 종료됨',
};

export function App({ controller }: { controller: AppController }): React.JSX.Element {
  const state = useStore(controller.store);

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

  const currentView = state.currentSessionId
    ? (state.views[state.currentSessionId] ?? emptySessionView())
    : null;

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
      <aside className="sidebar">
        <button className="settings-link" onClick={() => controller.navigate('settings')}>
          설정
        </button>
        <ul className="session-list">
          {state.sessions.map((session) => (
            <li
              key={session.sessionId}
              className={session.sessionId === state.currentSessionId ? 'selected' : ''}
            >
              <button
                onClick={() =>
                  session.status === 'closed'
                    ? void controller.resumeSession(session.sessionId)
                    : void controller.selectSession(session.sessionId)
                }
              >
                <span className={`status-dot status-${session.status}`} />
                {session.harness} · {session.cwd.split('/').pop() ?? session.cwd}
                {session.pendingPermissions?.length ? (
                  <span className="pending-badge">승인 대기</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main className="main-pane">
        {state.route === 'settings' ? (
          <Settings
            gateway={state.gateway}
            keyState={state.keyState}
            onSetKey={(apiKey) => controller.setKeyAndTest(apiKey)}
            onBack={() => controller.navigate('main')}
          />
        ) : currentView && state.currentSessionId ? (
          <Conversation
            view={currentView}
            actions={{
              prompt: (text) => void controller.prompt(state.currentSessionId!, text),
              interrupt: () => void controller.interrupt(state.currentSessionId!),
              respondPermission: (requestId, outcome) =>
                void controller.respondPermission(state.currentSessionId!, requestId, outcome),
            }}
          />
        ) : (
          <SessionCreate
            harnesses={state.harnesses}
            gateway={state.gateway}
            onCreate={(params) => controller.createSession(params)}
          />
        )}
      </main>
    </div>
  );
}
