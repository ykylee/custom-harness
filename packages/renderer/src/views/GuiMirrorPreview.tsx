// 확인용 전체 GUI 미러 — 실제 renderer 구성요소에 정적 fixture만 주입한다.
import { useState } from 'react';
import type { Project, SessionSummary, Terminal, Workspace } from '@custom-harness/protocol';
import { Conversation } from './Conversation.js';
import type { SessionView } from '../timeline.js';
import { Sidebar, type SidebarActions } from '../components/Sidebar.js';
import { Tabs } from '../components/Tabs.js';
import { WorkQueue } from '../components/WorkQueue.js';
import {
  closeTab,
  emptyLayout,
  openTab,
  setActiveTab,
  setSplit,
  targetOf,
} from '../workbench/tabs.js';

const project: Project = {
  id: 'project-preview',
  root: '/workspace/custom-harness',
  displayName: 'custom-harness',
  kind: 'git',
  defaultBranch: 'main',
  createdAt: '2026-09-02T12:00:00.000Z',
  updatedAt: '2026-09-02T12:00:00.000Z',
};

const workspace: Workspace = {
  id: 'workspace-preview',
  projectId: project.id,
  cwd: project.root,
  checkoutRoot: project.root,
  isolation: 'directory',
  displayName: 'custom-harness',
  labels: { team: 'platform' },
  setupState: 'none',
  createdAt: '2026-09-02T12:00:00.000Z',
  updatedAt: '2026-09-02T12:00:00.000Z',
};

const sessions: SessionSummary[] = [
  {
    sessionId: 'session-approval',
    harness: 'grok',
    cwd: workspace.cwd,
    status: 'running',
    seq: 10,
    workspaceId: workspace.id,
    title: '배포 전 검토',
    requiresAttention: true,
    attentionReason: 'permission',
    attentionTimestamp: '2026-09-02T12:00:00.000Z',
    pendingPermissions: [
      { requestId: 'permission-1', kind: 'shell', summary: 'git push origin main', options: [] },
    ],
  },
  {
    sessionId: 'session-running',
    harness: 'pi',
    cwd: workspace.cwd,
    status: 'running',
    seq: 8,
    workspaceId: workspace.id,
    title: 'API 검증 흐름',
  },
  {
    sessionId: 'session-idle',
    harness: 'omp',
    cwd: workspace.cwd,
    status: 'idle',
    seq: 6,
    workspaceId: workspace.id,
    title: '문서 갱신',
  },
];

const terminals = [{ id: 'terminal-preview', shell: '/bin/zsh' }] as Terminal[];

const approvalView: SessionView = {
  status: 'idle',
  lastSeq: 4,
  totalTokens: 18_420,
  items: [
    { kind: 'user', seq: 1, turnId: 'turn-1', text: '배포 전 변경 사항을 점검해줘.' },
    {
      kind: 'assistant',
      seq: 2,
      turnId: 'turn-1',
      reasoning: '변경 범위와 테스트 결과를 먼저 확인합니다.',
      text: '검증 명령을 실행했고, 배포 전에 확인이 필요한 변경을 찾았습니다.',
      status: 'completed',
    },
    {
      kind: 'tool',
      seq: 3,
      toolCallId: 'tool-1',
      toolKind: 'shell',
      summary: 'npm test',
      status: 'ok',
      rawInput: { command: 'npm test' },
    },
    {
      kind: 'permission',
      seq: 4,
      status: 'pending',
      request: {
        requestId: 'permission-1',
        kind: 'shell',
        summary: 'git push origin main',
        detail: { command: 'git push origin main' },
        options: [
          { optionId: 'allow', label: '허용', kind: 'allow_once' },
          { optionId: 'deny', label: '거부', kind: 'reject_once' },
        ],
      },
    },
  ],
};

export function GuiMirrorPreview(): React.JSX.Element {
  const [layout, setLayout] = useState(emptyLayout);
  const activeTarget = targetOf(layout, layout.active);
  const openSession = (sessionId: string): void =>
    setLayout((current) => openTab(current, { kind: 'session', sessionId }));
  const actions: SidebarActions = {
    open: openSession,
    closeSession: () => undefined,
    newSession: () => openSession('session-running'),
    openSettings: () => undefined,
    selectWorkspace: () => undefined,
    newWorkspace: () => undefined,
    newTerminal: () =>
      setLayout((current) =>
        openTab(current, { kind: 'terminal', terminalId: 'terminal-preview' }),
      ),
    openFiles: () => setLayout((current) => openTab(current, { kind: 'files' })),
    openDiff: () => setLayout((current) => openTab(current, { kind: 'diff', scope: 'working' })),
    archiveWorkspace: () => undefined,
    renameWorkspace: () => undefined,
    setWorkspaceLabels: () => undefined,
    runSetup: () => undefined,
    listScripts: async () => ({ scripts: [], trusted: false }),
    runScript: () => undefined,
  };

  return (
    <div className="app gui-mirror" data-testid="gui-mirror">
      <Sidebar
        projects={[project]}
        workspaces={[workspace]}
        sessions={sessions}
        activeWorkspaceId={workspace.id}
        activeSessionId={activeTarget?.kind === 'session' ? activeTarget.sessionId : null}
        actions={actions}
      />
      <main className="main-pane">
        {layout.tabs.length > 0 && (
          <Tabs
            layout={layout}
            sessions={sessions}
            terminals={terminals}
            actions={{
              activate: (id) => setLayout((current) => setActiveTab(current, id)),
              closeTab: (id) => setLayout((current) => closeTab(current, id)),
              setSplit: (direction) => setLayout((current) => setSplit(current, direction)),
            }}
          />
        )}
        {activeTarget === undefined ? (
          <WorkQueue
            workspaces={[workspace]}
            sessions={sessions}
            activeWorkspaceId={workspace.id}
            onOpenSession={openSession}
            onCreateSession={() => openSession('session-running')}
          />
        ) : activeTarget.kind === 'terminal' ? (
          <section className="terminal-cockpit" aria-label="터미널 상세">
            <header className="terminal-cockpit-header">
              <div className="terminal-context">
                <span className="terminal-eyebrow">LIVE SHELL</span>
                <strong>터미널</strong>
              </div>
              <code className="terminal-id">terminal-preview</code>
            </header>
            <pre className="gui-mirror-terminal">
              {
                '$ git status --short\n M packages/renderer/src/views/GuiMirrorPreview.tsx\n\n$ npm test\n ✓ 708 passed | 2 skipped'
              }
            </pre>
          </section>
        ) : activeTarget.kind === 'session' ? (
          <Conversation
            view={approvalView}
            actions={{
              prompt: () => undefined,
              interrupt: () => undefined,
              respondPermission: () => undefined,
            }}
          />
        ) : (
          <section className="gui-mirror-placeholder">
            <h1>작업 공간</h1>
            <p>이 정적 미러에서는 세션·터미널·큐 상호작용을 확인할 수 있습니다.</p>
          </section>
        )}
      </main>
    </div>
  );
}
