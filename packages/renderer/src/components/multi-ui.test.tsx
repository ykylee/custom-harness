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

  it('renders buckets, harness badges, pending badge, and usage summary (FR-3.7)', () => {
    render(
      <Sidebar
        sessions={sessions}
        activeSessionId="run-1"
        actions={{
          open: vi.fn(),
          closeSession: vi.fn(),
          newSession: vi.fn(),
          openSettings: vi.fn(),
        }}
      />,
    );
    expect(screen.getByText('승인 대기')).toBeTruthy();
    expect(screen.getByText('실행 중')).toBeTruthy();
    expect(screen.getByText('완료·보관')).toBeTruthy();
    expect(screen.getByText('pi')).toBeTruthy(); // 하네스 배지
    expect(screen.getByTestId('pending-badge').textContent).toContain('승인 1');
    expect(screen.getByText('1,234tk')).toBeTruthy(); // 목록 사용량 요약
    expect(screen.getByText('alpha')).toBeTruthy(); // 디렉토리 표시
  });

  it('separates open vs explicit close actions (FR-3.3.3)', () => {
    const open = vi.fn();
    const closeSession = vi.fn();
    render(
      <Sidebar
        sessions={[sessions[0]!]}
        activeSessionId={null}
        actions={{ open, closeSession, newSession: vi.fn(), openSettings: vi.fn() }}
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
