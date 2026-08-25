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
} {
  const calls: { type: string; params?: Record<string, unknown> }[] = [];
  const listeners: EventListener[] = [];
  const sessions: Record<string, unknown>[] = [
    { sessionId: 's-1', harness: 'mock', cwd: '/w/one', status: 'idle', seq: 0 },
    { sessionId: 's-2', harness: 'pi', cwd: '/w/two', status: 'closed', seq: 0 },
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
  return { transport, calls, pushEvent: (e) => listeners.forEach((l) => l(e)), sessions };
}

describe('AppController 탭·분할 (FR-3.3.2/3)', () => {
  beforeEach(() => installMemoryStorage());

  it('opens sessions as tabs, resumes closed ones, and closing a tab keeps the session', async () => {
    const { transport, calls } = makeFakeTransport();
    const controller = new AppController(transport);
    await controller.refreshSessions();

    await controller.openSession('s-1');
    expect(controller.store.get().layout).toMatchObject({ tabs: ['s-1'], active: 's-1' });
    // closed 세션은 resume 경유 (FR-1.3)
    await controller.openSession('s-2');
    expect(calls.some((c) => c.type === 'session.resume')).toBe(true);
    expect(controller.store.get().layout.tabs).toEqual(['s-1', 's-2']);

    // 탭 닫기 — session.close RPC 가 나가면 안 된다 (FR-3.3.3)
    const before = calls.length;
    controller.closeTab('s-2');
    expect(calls.slice(before).some((c) => c.type === 'session.close')).toBe(false);
    expect(controller.store.get().layout).toMatchObject({ tabs: ['s-1'], active: 's-1' });

    // 명시적 세션 종료는 RPC 호출
    await controller.closeSession('s-1');
    expect(calls.some((c) => c.type === 'session.close')).toBe(true);
    expect(controller.store.get().layout.tabs).toEqual([]);
  });

  it('splits with another tab and clears split when that tab closes', async () => {
    const { transport } = makeFakeTransport();
    const controller = new AppController(transport);
    await controller.refreshSessions();
    await controller.openSession('s-1');
    await controller.openSession('s-2');

    controller.setSplit('row');
    // active(s-2) 외 첫 탭이 보조 페인
    expect(controller.store.get().layout.split).toEqual({ direction: 'row', secondary: 's-1' });
    controller.closeTab('s-1');
    expect(controller.store.get().layout.split).toBeNull();
  });

  it('persists and restores the layout, dropping dead sessions (배치 복원)', async () => {
    const first = makeFakeTransport();
    const c1 = new AppController(first.transport);
    await c1.refreshSessions();
    await c1.openSession('s-1');
    await c1.openSession('s-2');
    c1.setSplit('column');

    // 새 컨트롤러(재시작) — s-2 가 사라진 상황
    const second = makeFakeTransport();
    second.sessions.splice(1, 1);
    const c2 = new AppController(second.transport);
    await c2.bootstrap();
    expect(c2.store.get().layout).toMatchObject({ tabs: ['s-1'], active: 's-1', split: null });
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
