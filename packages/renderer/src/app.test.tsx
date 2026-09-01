// @vitest-environment jsdom
// App 배선 — 컴포넌트를 따로 검증해도 **연결이 틀리면 화면에는 아무것도 안 나온다**.
// 여기서는 세션 탭이 자식 트랙에 올바른 값을 넘기는지만 본다 (M7 7.3.3).
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { AppController, type DaemonTransport } from './store/app-store.js';

afterEach(cleanup);

function installMemoryStorage(): void {
  const map = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, String(value)),
      removeItem: (key: string) => void map.delete(key),
      clear: () => map.clear(),
    },
  });
}

const SESSIONS = [
  {
    sessionId: 'parent-1',
    harness: 'mock',
    cwd: '/w/one',
    status: 'idle',
    seq: 0,
    workspaceId: 'wsp_1',
  },
  {
    sessionId: 'kid-1',
    harness: 'pi',
    cwd: '/w/one',
    status: 'running',
    seq: 0,
    workspaceId: 'wsp_1',
    labels: { 'ch.parentSessionId': 'parent-1', 'ch.toolDepth': '1' },
  },
];

function transportFor(): DaemonTransport {
  return {
    rpc: (type, params) => {
      if (type === 'session.list') return Promise.resolve({ sessions: SESSIONS });
      if (type === 'session.timeline') return Promise.resolve({ events: [] });
      if (type === 'harness.list') return Promise.resolve({ harnesses: [] });
      if (type === 'project.list') {
        return Promise.resolve({
          projects: [
            {
              id: 'prj_1',
              root: '/w',
              displayName: 'w',
              kind: 'plain',
              createdAt: 'n',
              updatedAt: 'n',
            },
          ],
        });
      }
      if (type === 'workspace.list') {
        return Promise.resolve({
          workspaces: [
            {
              id: 'wsp_1',
              projectId: 'prj_1',
              cwd: '/w/one',
              checkoutRoot: '/w/one',
              isolation: 'directory',
              displayName: 'one',
              labels: {},
              setupState: 'none',
              createdAt: 'n',
              updatedAt: 'n',
            },
          ],
        });
      }
      if (type === 'config.get') {
        return Promise.resolve({
          values: {
            gateway: { baseUrl: 'http://gw/v1', models: [] },
            keyState: { present: true, fallback: false },
            maxSessions: 8,
          },
        });
      }
      if (type === 'session.usage') {
        const sessionId = (params as { sessionId: string }).sessionId;
        return Promise.resolve(
          sessionId === 'parent-1'
            ? {
                own: { totalTokens: 40 },
                subtree: { totalTokens: 140 },
                childCount: 1,
                activeChildCount: 1,
                children: [
                  {
                    sessionId: 'kid-1',
                    status: 'running',
                    harness: 'pi',
                    usage: { totalTokens: 100 },
                    subtree: { totalTokens: 100 },
                  },
                ],
              }
            : { own: {}, subtree: {}, childCount: 0, activeChildCount: 0, children: [] },
        );
      }
      return Promise.resolve({});
    },
    onEvent: () => () => {},
    onState: () => () => {},
    onReconnected: () => () => {},
    start: vi.fn(),
    stop: vi.fn(),
  };
}

describe('App — 자식 트랙 배선 (M7 7.3.3)', () => {
  beforeEach(() => installMemoryStorage());

  it('부모 세션 탭에 자식 칩과 합산이 뜬다', async () => {
    const controller = new AppController(transportFor());
    await controller.bootstrap();
    await controller.openSession('parent-1');

    render(<App controller={controller} />);
    expect(screen.getByTestId('child-chip-kid-1')).toBeTruthy();
    expect(screen.getByTestId('child-track-total').textContent).toContain('140tk');
  });

  it('자식 세션 탭에는 부모로 돌아갈 길이 뜬다 — 라벨 키가 어긋나면 여기서 드러난다', async () => {
    const controller = new AppController(transportFor());
    await controller.bootstrap();
    await controller.openSession('kid-1');

    render(<App controller={controller} />);
    expect(screen.getByText('↑ 부모 세션')).toBeTruthy();
    // 자식은 자식이 없으므로 칩도 합계도 없다
    expect(screen.queryByTestId('child-track-total')).toBeNull();
  });

  it('위임을 안 쓴 세션에는 트랙 자체가 없다', async () => {
    const controller = new AppController(transportFor());
    await controller.bootstrap();
    // 자식도 부모도 없는 상태를 만든다 — usage 는 비었고 라벨도 없다
    controller.store.set({
      usageTrees: {
        'parent-1': { own: {}, subtree: {}, childCount: 0, activeChildCount: 0, children: [] },
      },
    });
    await controller.openSession('parent-1');
    controller.store.set({
      sessions: controller.store.get().sessions.map((s) => ({ ...s, labels: undefined })),
      usageTrees: {
        'parent-1': { own: {}, subtree: {}, childCount: 0, activeChildCount: 0, children: [] },
      },
    });

    render(<App controller={controller} />);
    expect(screen.queryByTestId('child-track')).toBeNull();
  });
});
