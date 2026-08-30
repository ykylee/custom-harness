// 사이드바·탭 컴포넌트 테스트 (WBS 2.4.1·2.4.2, FR-3.3)
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@custom-harness/protocol';
import { Sidebar, bucketOf } from './Sidebar.js';
import { Tabs } from './Tabs.js';

afterEach(cleanup);

const summary = (over: Partial<SessionSummary>): SessionSummary =>
  ({
    sessionId: 'x',
    harness: 'mock',
    cwd: '/work/project',
    status: 'idle',
    seq: 0,
    ...over,
  }) as SessionSummary;

/** 3계층 픽스처 — 프로젝트 1개, 워크스페이스 2개 (WBS 5.6.1) */
const project = {
  id: 'prj_1',
  root: '/w',
  displayName: 'w',
  kind: 'git' as const,
  defaultBranch: 'main',
  createdAt: 'now',
  updatedAt: 'now',
};
function workspace(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wsp_1',
    projectId: 'prj_1',
    cwd: '/w/alpha',
    checkoutRoot: '/w/alpha',
    isolation: 'directory' as const,
    displayName: 'alpha',
    labels: {},
    setupState: 'none' as const,
    createdAt: 'now',
    updatedAt: 'now',
    ...overrides,
  };
}
const sidebarActions = () => ({
  open: vi.fn(),
  closeSession: vi.fn(),
  newSession: vi.fn(),
  openSettings: vi.fn(),
  selectWorkspace: vi.fn(),
  newWorkspace: vi.fn(),
  archiveWorkspace: vi.fn(),
  runSetup: vi.fn(),
  renameWorkspace: vi.fn(),
  setWorkspaceLabels: vi.fn(),
});

describe('Sidebar (FR-3.3.1)', () => {
  const sessions: SessionSummary[] = [
    summary({ sessionId: 'run-1', harness: 'pi', cwd: '/w/alpha', status: 'running' }),
    summary({
      sessionId: 'perm-1',
      harness: 'omp',
      cwd: '/w/beta',
      status: 'running',
      pendingPermissions: [
        { requestId: 'p', kind: 'shell', summary: 's', options: [] },
      ] as SessionSummary['pendingPermissions'],
    }),
    summary({ sessionId: 'closed-1', harness: 'grok', cwd: '/w/gamma', status: 'closed' }),
    summary({
      sessionId: 'idle-1',
      cwd: '/w/delta',
      status: 'idle',
      usage: { totalTokens: 1234 },
    }),
  ];

  it('buckets sessions by state — 승인 대기가 최우선', () => {
    expect(bucketOf(sessions[1]!)).toBe('approval');
    expect(bucketOf(sessions[0]!)).toBe('running');
    expect(bucketOf(sessions[2]!)).toBe('closed');
    expect(bucketOf(sessions[3]!)).toBe('idle');
  });

  it('프로젝트 → 워크스페이스 → 세션 3계층으로 그린다 (WBS 5.6.1)', () => {
    const owned = sessions.map((session) => ({ ...session, workspaceId: 'wsp_1' }));
    render(
      <Sidebar
        projects={[project]}
        workspaces={[workspace()]}
        sessions={owned}
        activeWorkspaceId="wsp_1"
        activeSessionId="run-1"
        actions={sidebarActions()}
      />,
    );
    expect(screen.getByTestId('project-prj_1')).toBeTruthy();
    expect(screen.getByTestId('workspace-wsp_1')).toBeTruthy();
    expect(screen.getByText('pi')).toBeTruthy(); // 하네스 배지
    expect(screen.getByTestId('pending-badge').textContent).toContain('승인 1');
    expect(screen.getByText('1,234tk')).toBeTruthy(); // 목록 사용량 요약
  });

  it('상태 버킷은 계층을 대체하지 않고 횡단 필터로 남는다', () => {
    const owned = sessions.map((session) => ({ ...session, workspaceId: 'wsp_1' }));
    render(
      <Sidebar
        projects={[project]}
        workspaces={[workspace()]}
        sessions={owned}
        activeWorkspaceId="wsp_1"
        activeSessionId={null}
        actions={sidebarActions()}
      />,
    );
    expect(screen.getByTestId('session-closed-1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('filter-approval'));
    // 필터를 걸어도 계층(프로젝트·워크스페이스)은 그대로다
    expect(screen.getByTestId('project-prj_1')).toBeTruthy();
    expect(screen.queryByTestId('session-closed-1')).toBeNull();
    expect(screen.getByTestId('session-perm-1')).toBeTruthy();
  });

  it('워크스페이스 소속은 workspaceId 로만 판정한다 — 미지정 세션은 별도로 보인다', () => {
    const mixed = [
      { ...sessions[0]!, workspaceId: 'wsp_1' },
      { ...sessions[3]! }, // workspaceId 없음 (백필 실패 등)
    ];
    render(
      <Sidebar
        projects={[project]}
        workspaces={[workspace()]}
        sessions={mixed}
        activeWorkspaceId="wsp_1"
        activeSessionId={null}
        actions={sidebarActions()}
      />,
    );
    expect(screen.getByTestId('orphan-sessions')).toBeTruthy();
    expect(screen.getByTestId('session-idle-1')).toBeTruthy();
  });

  it('이름·라벨을 인라인으로 편집한다 (WBS 5.6.3)', () => {
    const actions = sidebarActions();
    render(
      <Sidebar
        projects={[project]}
        workspaces={[workspace({ labels: { team: 'platform' } })]}
        sessions={[]}
        activeWorkspaceId="wsp_1"
        activeSessionId={null}
        actions={actions}
      />,
    );
    fireEvent.click(screen.getByTestId('edit-wsp_1'));
    fireEvent.change(screen.getByLabelText('표시 이름'), { target: { value: '  결제 작업  ' } });
    fireEvent.change(screen.getByRole('textbox', { name: /라벨/ }), {
      target: { value: 'team=payments\nenv=dev\n잘못된줄' },
    });
    fireEvent.click(screen.getByTestId('editor-save-wsp_1'));

    expect(actions.renameWorkspace).toHaveBeenCalledWith('wsp_1', '결제 작업');
    // key=value 가 아닌 줄은 버린다
    expect(actions.setWorkspaceLabels).toHaveBeenCalledWith('wsp_1', {
      team: 'payments',
      env: 'dev',
    });
  });

  it('setup 대기 워크스페이스에만 실행 버튼을 노출한다 (FR-7.5 신뢰 경계)', () => {
    const actions = sidebarActions();
    render(
      <Sidebar
        projects={[project]}
        workspaces={[workspace({ setupState: 'pending' })]}
        sessions={[]}
        activeWorkspaceId="wsp_1"
        activeSessionId={null}
        actions={actions}
      />,
    );
    fireEvent.click(screen.getByTestId('setup-wsp_1'));
    expect(actions.runSetup).toHaveBeenCalledWith('wsp_1');
  });

  it('separates open vs explicit close actions (FR-3.3.3)', () => {
    const actions = sidebarActions();
    const { open, closeSession } = actions;
    render(
      <Sidebar
        projects={[project]}
        workspaces={[workspace()]}
        sessions={[{ ...sessions[0]!, workspaceId: 'wsp_1' }]}
        activeWorkspaceId="wsp_1"
        activeSessionId={null}
        actions={actions}
      />,
    );
    fireEvent.click(screen.getByTestId('session-run-1'));
    expect(open).toHaveBeenCalledWith('run-1');
    fireEvent.click(screen.getByTitle('세션 종료 (이력 유지 — 재개 가능)'));
    expect(closeSession).toHaveBeenCalledWith('run-1');
  });
});

describe('Tabs (FR-3.3.2)', () => {
  const sessions = [
    summary({ sessionId: 't-1', cwd: '/w/one', status: 'running' }),
    summary({ sessionId: 't-2', cwd: '/w/two', status: 'idle' }),
  ];

  it('renders tabs with close buttons and split controls for 2+ tabs', () => {
    const actions = { activate: vi.fn(), closeTab: vi.fn(), setSplit: vi.fn() };
    render(
      <Tabs
        layout={{ tabs: ['t-1', 't-2'], active: 't-1', split: null }}
        sessions={sessions}
        actions={actions}
      />,
    );
    fireEvent.click(screen.getByText('two'));
    expect(actions.activate).toHaveBeenCalledWith('t-2');
    const closeButtons = screen.getAllByTitle('탭 닫기 (세션은 유지)');
    fireEvent.click(closeButtons[0]!);
    expect(actions.closeTab).toHaveBeenCalledWith('t-1');
    fireEvent.click(screen.getByTitle('좌우 분할'));
    expect(actions.setSplit).toHaveBeenCalledWith('row');
  });

  it('hides split controls with a single tab', () => {
    render(
      <Tabs
        layout={{ tabs: ['t-1'], active: 't-1', split: null }}
        sessions={sessions}
        actions={{ activate: vi.fn(), closeTab: vi.fn(), setSplit: vi.fn() }}
      />,
    );
    expect(screen.queryByTitle('좌우 분할')).toBeNull();
  });
});
