// @vitest-environment jsdom
// 운영 큐는 데몬이 준 세션 요약을 다시 해석하지 않고, 상태와 주의 사유를 그대로 보여 준다.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary, Workspace } from '@custom-harness/protocol';
import { WorkQueue } from './WorkQueue.js';

afterEach(cleanup);

const workspace: Workspace = {
  id: 'wsp_1',
  projectId: 'project_1',
  cwd: '/work/custom-harness',
  checkoutRoot: '/work/custom-harness',
  isolation: 'directory',
  displayName: 'custom-harness',
  labels: {},
  setupState: 'none',
  createdAt: '2026-09-02T12:00:00.000Z',
  updatedAt: '2026-09-02T12:00:00.000Z',
};

const sessions: SessionSummary[] = [
  {
    sessionId: 'run_1',
    harness: 'pi',
    cwd: workspace.cwd,
    status: 'running',
    seq: 2,
    workspaceId: workspace.id,
    title: 'API 검증 흐름',
  },
  {
    sessionId: 'approval_1',
    harness: 'grok',
    cwd: workspace.cwd,
    status: 'running',
    seq: 3,
    workspaceId: workspace.id,
    title: '배포 전 검토',
    requiresAttention: true,
    attentionReason: 'permission',
    pendingPermissions: [],
  },
];

describe('WorkQueue', () => {
  it('데몬 세션을 운영 큐로 표시하고 주의 상태를 우선한다', () => {
    render(
      <WorkQueue
        workspaces={[workspace]}
        sessions={sessions}
        activeWorkspaceId={workspace.id}
        onOpenSession={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: '워크 큐' })).toBeTruthy();
    expect(screen.getByText('API 검증 흐름')).toBeTruthy();
    expect(screen.getByText('승인 대기')).toBeTruthy();
    expect(screen.getByText('2개 세션')).toBeTruthy();
  });

  it('큐 행을 선택하면 해당 세션을 기존 대화 화면으로 연다', () => {
    const onOpenSession = vi.fn();
    render(
      <WorkQueue
        workspaces={[workspace]}
        sessions={sessions}
        activeWorkspaceId={workspace.id}
        onOpenSession={onOpenSession}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /배포 전 검토/ }));
    expect(onOpenSession).toHaveBeenCalledWith('approval_1');
  });

  it('주의 세션은 오래 기다린 순으로 일반 세션보다 먼저 표시한다', () => {
    const attentionSessions: SessionSummary[] = [
      sessions[0]!,
      { ...sessions[1]!, title: '최근 승인', attentionTimestamp: '2026-09-02T12:05:00.000Z' },
      {
        ...sessions[1]!,
        sessionId: 'approval_old',
        title: '오래된 승인',
        attentionTimestamp: '2026-09-02T12:00:00.000Z',
      },
    ];
    render(
      <WorkQueue
        workspaces={[workspace]}
        sessions={attentionSessions}
        activeWorkspaceId={workspace.id}
        onOpenSession={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      expect.stringContaining('오래된 승인'),
      expect.stringContaining('최근 승인'),
      expect.stringContaining('API 검증 흐름'),
    ]);
  });
});
