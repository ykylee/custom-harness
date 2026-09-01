// AppController 멀티 세션 로직 테스트 (WBS 2.4) — fake 전송으로 탭·분할·자동 승인 검증.
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@custom-harness/protocol';
import { AppController, type DaemonTransport } from './app-store.js';

type EventListener = (event: SessionEvent) => void;

/** vitest jsdom 의 window.localStorage 는 Storage 메서드가 없는 빈 객체 — 인메모리 대체 */
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

function makeFakeTransport(): {
  transport: DaemonTransport;
  calls: { type: string; params?: Record<string, unknown> }[];
  pushEvent(event: SessionEvent): void;
  sessions: Record<string, unknown>[];
  workspaces: Record<string, unknown>[];
} {
  const calls: { type: string; params?: Record<string, unknown> }[] = [];
  const listeners: EventListener[] = [];
  const sessions: Record<string, unknown>[] = [
    {
      sessionId: 's-1',
      harness: 'mock',
      cwd: '/w/one',
      status: 'idle',
      seq: 0,
      workspaceId: 'wsp_1',
    },
    {
      sessionId: 's-2',
      harness: 'pi',
      cwd: '/w/two',
      status: 'closed',
      seq: 0,
      workspaceId: 'wsp_1',
    },
  ];
  const projects: Record<string, unknown>[] = [
    { id: 'prj_1', root: '/w', displayName: 'w', kind: 'plain', createdAt: 'n', updatedAt: 'n' },
  ];
  const workspaces: Record<string, unknown>[] = [
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
  ];
  const transport: DaemonTransport = {
    rpc: (type, params) => {
      calls.push({ type, ...(params !== undefined ? { params } : {}) });
      if (type === 'session.list') return Promise.resolve({ sessions });
      if (type === 'session.timeline') return Promise.resolve({ events: [] });
      if (type === 'config.get') {
        return Promise.resolve({
          values: {
            gateway: { baseUrl: 'http://gw/v1', models: [] },
            keyState: { present: true, fallback: false },
            maxSessions: 8,
          },
        });
      }
      if (type === 'harness.list') return Promise.resolve({ harnesses: [] });
      if (type === 'session.usage') {
        return Promise.resolve({
          own: { totalTokens: 5 },
          subtree: { totalTokens: 9 },
          childCount: 1,
          activeChildCount: 1,
          children: [{ sessionId: 'kid', status: 'idle', harness: 'mock', subtree: {} }],
        });
      }
      if (type === 'project.list') return Promise.resolve({ projects });
      if (type === 'workspace.list') return Promise.resolve({ workspaces });
      if (type === 'session.create') {
        return Promise.resolve({
          session: { sessionId: 's-new', harness: 'mock', cwd: '/w/new', status: 'idle', seq: 0 },
        });
      }
      return Promise.resolve({});
    },
    onEvent: (listener) => {
      listeners.push(listener as EventListener);
      return () => {};
    },
    onState: () => () => {},
    onReconnected: () => () => {},
    start: vi.fn(),
    stop: vi.fn(),
  };
  return {
    transport,
    calls,
    pushEvent: (e) => listeners.forEach((l) => l(e)),
    sessions,
    workspaces,
  };
}

describe('AppController 자식 트랙 (M7 7.3.3)', () => {
  beforeEach(() => installMemoryStorage());

  it('세션 탭을 열면 위임 비용도 함께 적재한다', async () => {
    const { transport, calls } = makeFakeTransport();
    const controller = new AppController(transport);
    await controller.bootstrap();

    await controller.openSession('s-1');
    expect(calls.some((c) => c.type === 'session.usage')).toBe(true);
    expect(controller.store.get().usageTrees['s-1']?.subtree.totalTokens).toBe(9);
  });

  it('목록 갱신이 열린 탭의 트랙도 갱신한다 — 안 하면 탭을 다시 열 때까지 낡는다', async () => {
    const { transport, calls } = makeFakeTransport();
    const controller = new AppController(transport);
    await controller.bootstrap();
    await controller.openSession('s-1');
    const before = calls.filter((c) => c.type === 'session.usage').length;

    await controller.refreshSessions();
    await Promise.resolve(); // refreshUsageTree 는 대기하지 않고 띄운다
    expect(calls.filter((c) => c.type === 'session.usage').length).toBeGreaterThan(before);
  });

  it('비용 조회 실패가 대화 화면을 막지 않는다 — 트랙은 보조 정보다', async () => {
    const { transport } = makeFakeTransport();
    const failing: DaemonTransport = {
      ...transport,
      rpc: (type, params) =>
        type === 'session.usage'
          ? Promise.reject(new Error('데몬 거절'))
          : transport.rpc(type, params),
    };
    const controller = new AppController(failing);
    await controller.bootstrap();

    await expect(controller.openSession('s-1')).resolves.toBeUndefined();
    expect(controller.store.get().usageTrees['s-1']).toBeUndefined();
    expect(controller.store.get().lastError).toBeNull();
  });
});

describe('AppController 탭·분할 (FR-3.3.2/3)', () => {
  beforeEach(() => installMemoryStorage());

  it('opens sessions as tabs, resumes closed ones, and closing a tab keeps the session', async () => {
    const { transport, calls } = makeFakeTransport();
    const controller = new AppController(transport);
    await controller.bootstrap(); // 워크스페이스가 있어야 배치가 성립한다

    await controller.openSession('s-1');
    expect(controller.layout.tabs.map((tab) => tab.id)).toEqual(['session:s-1']);
    expect(controller.layout.active).toBe('session:s-1');
    // closed 세션은 resume 경유 (FR-1.3)
    await controller.openSession('s-2');
    expect(calls.some((c) => c.type === 'session.resume')).toBe(true);
    expect(controller.layout.tabs.map((tab) => tab.id)).toEqual(['session:s-1', 'session:s-2']);

    // 탭 닫기 — session.close RPC 가 나가면 안 된다 (FR-3.3.3)
    const before = calls.length;
    controller.closeTab('session:s-2');
    expect(calls.slice(before).some((c) => c.type === 'session.close')).toBe(false);
    expect(controller.layout.tabs.map((tab) => tab.id)).toEqual(['session:s-1']);
    expect(controller.layout.active).toBe('session:s-1');

    // 명시적 세션 종료는 RPC 호출
    await controller.closeSession('s-1');
    expect(calls.some((c) => c.type === 'session.close')).toBe(true);
    expect(controller.layout.tabs).toEqual([]);
  });

  it('splits with another tab and clears split when that tab closes', async () => {
    const { transport } = makeFakeTransport();
    const controller = new AppController(transport);
    await controller.bootstrap();
    await controller.openSession('s-1');
    await controller.openSession('s-2');

    controller.setSplit('row');
    // active(s-2) 외 첫 탭이 보조 페인
    expect(controller.layout.split).toEqual({ direction: 'row', secondary: 'session:s-1' });
    controller.closeTab('session:s-1');
    expect(controller.layout.split).toBeNull();
  });

  it('persists and restores the layout, dropping dead sessions (배치 복원)', async () => {
    const first = makeFakeTransport();
    const c1 = new AppController(first.transport);
    await c1.bootstrap();
    await c1.openSession('s-1');
    await c1.openSession('s-2');
    c1.setSplit('column');

    // 새 컨트롤러(재시작) — s-2 가 사라진 상황
    const second = makeFakeTransport();
    second.sessions.splice(1, 1);
    const c2 = new AppController(second.transport);
    await c2.bootstrap();
    expect(c2.layout.tabs.map((tab) => tab.id)).toEqual(['session:s-1']);
    expect(c2.layout.active).toBe('session:s-1');
    expect(c2.layout.split).toBeNull(); // 사라진 보조 페인은 정리된다
  });
});

describe('AppController 자동 승인 (FR-3.4.3)', () => {
  beforeEach(() => installMemoryStorage());

  it('auto-responds allow_once for opted-in sessions only', async () => {
    const { transport, calls, pushEvent } = makeFakeTransport();
    const controller = new AppController(transport);
    controller.setNotificationsEnabled(false); // 알림 경로 제외
    controller.setAutoApprove('s-1', true);

    const permissionEvent = (sessionId: string, requestId: string): SessionEvent =>
      ({
        type: 'permission_requested',
        sessionId,
        seq: 1,
        request: {
          requestId,
          kind: 'shell',
          summary: 'x',
          options: [
            { optionId: 'ok', label: '허용', kind: 'allow_once' },
            { optionId: 'no', label: '거부', kind: 'reject_once' },
          ],
        },
      }) as unknown as SessionEvent;

    pushEvent(permissionEvent('s-1', 'p-1'));
    await vi.waitFor(() => {
      expect(
        calls.some(
          (c) =>
            c.type === 'session.permission.respond' &&
            (c.params as { requestId?: string }).requestId === 'p-1' &&
            (c.params as { outcome?: { optionId?: string } }).outcome?.optionId === 'ok',
        ),
      ).toBe(true);
    });

    const before = calls.filter((c) => c.type === 'session.permission.respond').length;
    pushEvent(permissionEvent('s-2', 'p-2')); // opt-in 안 된 세션 — 자동 응답 금지
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls.filter((c) => c.type === 'session.permission.respond').length).toBe(before);
  });
});

describe('AppController 3계층 (WBS 5.6)', () => {
  beforeEach(() => installMemoryStorage());

  it('부트스트랩이 프로젝트·워크스페이스를 적재하고 활성 워크스페이스를 정한다', async () => {
    const { transport } = makeFakeTransport();
    const controller = new AppController(transport);
    await controller.bootstrap();
    const state = controller.store.get();
    expect(state.projects).toHaveLength(1);
    expect(state.workspaces).toHaveLength(1);
    expect(state.activeWorkspaceId).toBe('wsp_1');
  });

  it('세션 생성은 cwd 가 아니라 workspaceId 를 보낸다 (WBS 5.6.4)', async () => {
    const { transport, calls } = makeFakeTransport();
    const controller = new AppController(transport);
    await controller.bootstrap();
    await controller.createSession({ harness: 'mock', workspaceId: 'wsp_1' });

    const create = calls.find((call) => call.type === 'session.create');
    expect(create?.params).toEqual({ harness: 'mock', workspaceId: 'wsp_1' });
    expect(create?.params).not.toHaveProperty('cwd');
  });

  it('레지스트리 이벤트를 받으면 목록을 다시 읽는다 (세션 봉투가 없어도 안전)', async () => {
    const { transport, calls, pushEvent } = makeFakeTransport();
    const controller = new AppController(transport);
    await controller.bootstrap();
    const before = calls.filter((call) => call.type === 'workspace.list').length;

    pushEvent({
      type: 'workspace_changed',
      reason: 'updated',
      workspace: { id: 'wsp_1' },
    } as never);
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.filter((call) => call.type === 'workspace.list').length).toBeGreaterThan(before);
    // 세션 타임라인 상태를 오염시키지 않는다
    expect(Object.keys(controller.store.get().views)).toEqual([]);
  });

  it('setup 실행은 동의 없이는 신뢰를 부여하지 않는다 (FR-7.5)', async () => {
    const { transport, calls } = makeFakeTransport();
    const controller = new AppController(transport);
    await controller.bootstrap();

    // 데몬이 pending 을 돌려주고, 사용자가 거절하는 흐름
    const original = transport.rpc.bind(transport);
    transport.rpc = (type, params) => {
      if (type === 'workspace.setup.run') {
        calls.push({ type, ...(params !== undefined ? { params } : {}) });
        return Promise.resolve({ setupState: 'pending', detail: '동의가 필요함' });
      }
      return original(type, params);
    };

    await controller.confirmAndRunSetup('wsp_1', () => false);
    const setupCalls = calls.filter((call) => call.type === 'workspace.setup.run');
    expect(setupCalls).toHaveLength(1);
    expect(setupCalls[0]?.params).toEqual({ workspaceId: 'wsp_1', trust: false });

    await controller.confirmAndRunSetup('wsp_1', () => true);
    const after = calls.filter((call) => call.type === 'workspace.setup.run');
    expect(after.at(-1)?.params).toEqual({ workspaceId: 'wsp_1', trust: true });
  });

  it('활성 워크스페이스가 사라지면 남은 워크스페이스로 내려앉는다', async () => {
    const fake = makeFakeTransport();
    const controller = new AppController(fake.transport);
    await controller.bootstrap();
    fake.workspaces.splice(0, 1);
    await controller.refreshWorkspaces();
    expect(controller.store.get().activeWorkspaceId).toBeNull();
  });
});
