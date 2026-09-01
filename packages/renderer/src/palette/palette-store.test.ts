// 커맨드 팔레트 컨트롤러 (M7 WBS 7.4.2, FR-9.4) — 원격 조회의 경합·수명이 핵심이다.
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController, type DaemonTransport } from '../store/app-store.js';

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

interface Deferred {
  resolve(value: unknown): void;
  params: Record<string, unknown> | undefined;
}

function makeTransport(): {
  transport: DaemonTransport;
  calls: { type: string; params?: Record<string, unknown> }[];
  /** 보류시킬 RPC — 응답 시점을 테스트가 정한다 */
  pending: Record<string, Deferred[]>;
  settleAll(): void;
} {
  const calls: { type: string; params?: Record<string, unknown> }[] = [];
  const pending: Record<string, Deferred[]> = { 'file.search': [], 'session.search': [] };
  const transport: DaemonTransport = {
    rpc: (type, params) => {
      calls.push({ type, ...(params !== undefined ? { params } : {}) });
      if (type === 'session.list')
        return Promise.resolve({
          sessions: [
            {
              sessionId: 's-1',
              harness: 'mock',
              cwd: '/w',
              status: 'idle',
              seq: 0,
              workspaceId: 'wsp_1',
            },
          ],
        });
      if (type === 'project.list')
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
      if (type === 'workspace.list')
        return Promise.resolve({
          workspaces: [
            {
              id: 'wsp_1',
              projectId: 'prj_1',
              cwd: '/w',
              checkoutRoot: '/w',
              isolation: 'directory',
              displayName: '작업공간 하나',
              labels: {},
              setupState: 'none',
              createdAt: 'n',
              updatedAt: 'n',
            },
          ],
        });
      if (type === 'config.get')
        return Promise.resolve({
          // keyState 가 없으면 부트스트랩이 온보딩으로 간다 — 팔레트가 안 열리는 화면이다
          values: {
            gateway: { baseUrl: 'http://gw/v1', models: [] },
            keyState: { present: true, fallback: false },
            maxSessions: 8,
          },
        });
      if (type === 'harness.list') return Promise.resolve({ harnesses: [] });
      if (type === 'session.timeline') return Promise.resolve({ events: [] });
      if (type === 'file.search' || type === 'session.search') {
        return new Promise((resolve) => {
          pending[type]!.push({ resolve, params });
        });
      }
      return Promise.resolve({});
    },
    onEvent: () => () => {},
    onState: () => () => {},
    onReconnected: () => () => {},
    start: vi.fn(),
    stop: vi.fn(),
  };
  const settleAll = (): void => {
    for (const key of Object.keys(pending)) {
      for (const deferred of pending[key]!.splice(0)) {
        deferred.resolve(key === 'file.search' ? { paths: [] } : { hits: [] });
      }
    }
  };
  return { transport, calls, pending, settleAll };
}

async function booted(): Promise<{
  controller: AppController;
  calls: { type: string; params?: Record<string, unknown> }[];
  pending: Record<string, Deferred[]>;
  settleAll(): void;
}> {
  const { transport, calls, pending, settleAll } = makeTransport();
  const controller = new AppController(transport);
  await controller.bootstrap();
  return { controller, calls, pending, settleAll };
}

describe('AppController 커맨드 팔레트 (M7 7.4.2)', () => {
  beforeEach(() => installMemoryStorage());

  it('열면 질의 없이도 항목이 선다', async () => {
    const { controller } = await booted();
    controller.openPalette();
    expect(controller.store.get().palette.open).toBe(true);
    expect(controller.paletteItems().length).toBeGreaterThan(0);
  });

  it('빈 질의로는 원격 조회를 하지 않는다', async () => {
    const { controller, calls } = await booted();
    controller.openPalette();
    await controller.searchPalette('   ');
    expect(calls.filter((c) => c.type === 'file.search' || c.type === 'session.search')).toEqual(
      [],
    );
  });

  it('로컬 소스는 원격 응답을 기다리지 않는다', async () => {
    const { controller } = await booted();
    controller.openPalette();
    void controller.searchPalette('작업공간');
    // 응답 전에도 워크스페이스는 이미 보인다 — 여기서 비면 팔레트가 한 박자 늦게 뜬다
    expect(controller.paletteItems().some((item) => item.group === 'workspace')).toBe(true);
  });

  it('늦게 온 옛 응답이 새 결과를 덮지 않는다', async () => {
    const { controller, pending } = await booted();
    controller.openPalette();
    const first = controller.searchPalette('첫질의');
    const second = controller.searchPalette('둘째질의');

    // 순서를 뒤집어 응답한다 — 실제로 흔한 순서다
    pending['session.search']![1]!.resolve({ hits: [] });
    pending['file.search']![1]!.resolve({ paths: ['새/결과.ts'] });
    await second;
    pending['session.search']![0]!.resolve({ hits: [] });
    pending['file.search']![0]!.resolve({ paths: ['옛/결과.ts'] });
    await first;

    expect(controller.store.get().palette.filePaths).toEqual(['새/결과.ts']);
  });

  it('같은 글자를 다시 쳐도 앞 요청의 답을 쓰지 않는다', async () => {
    // 질의 문자열로 경합을 막으면 이 경우가 통과해 버린다 — 세는 것은 요청 순번이다
    const { controller, pending } = await booted();
    controller.openPalette();
    const first = controller.searchPalette('같은질의');
    const second = controller.searchPalette('같은질의');

    pending['file.search']![1]!.resolve({ paths: ['나중.ts'] });
    pending['session.search']![1]!.resolve({ hits: [] });
    await second;
    pending['file.search']![0]!.resolve({ paths: ['먼저.ts'] });
    pending['session.search']![0]!.resolve({ hits: [] });
    await first;

    expect(controller.store.get().palette.filePaths).toEqual(['나중.ts']);
  });

  it('질의가 바뀌는 사이에는 옛 원격 결과를 섞지 않는다', async () => {
    const { controller, pending } = await booted();
    controller.openPalette();
    const first = controller.searchPalette('index');
    pending['file.search']![0]!.resolve({ paths: ['src/index.ts'] });
    pending['session.search']![0]!.resolve({ hits: [] });
    await first;
    expect(controller.paletteItems().some((item) => item.group === 'file')).toBe(true);

    // 아직 응답이 없는 새 질의 — 옛 파일이 남아 보이면 사용자는 그것을 누른다
    void controller.searchPalette('전혀다른것');
    expect(controller.paletteItems().some((item) => item.group === 'file')).toBe(false);
  });

  it('닫으면 도는 중인 응답을 버린다', async () => {
    const { controller, pending } = await booted();
    controller.openPalette();
    const search = controller.searchPalette('무엇이든');
    controller.closePalette();
    pending['file.search']![0]!.resolve({ paths: ['늦게.ts'] });
    pending['session.search']![0]!.resolve({ hits: [] });
    await search;

    expect(controller.store.get().palette).toMatchObject({ open: false, filePaths: [] });
  });

  it('원격 조회가 실패해도 팔레트는 산다', async () => {
    const { transport } = makeTransport();
    const failing: DaemonTransport = {
      ...transport,
      rpc: (type, params) =>
        type === 'file.search' || type === 'session.search'
          ? Promise.reject(new Error('데몬 실패'))
          : transport.rpc(type, params),
    };
    const controller = new AppController(failing);
    await controller.bootstrap();
    controller.openPalette();
    await controller.searchPalette('세션');

    expect(controller.store.get().lastError).toBeNull(); // 배너를 띄울 일이 아니다
    expect(controller.paletteItems().length).toBeGreaterThan(0);
  });

  it('워크스페이스가 없으면 파일 조회를 걸지 않는다', async () => {
    const { controller, calls, settleAll } = await booted();
    controller.selectWorkspace(null as unknown as string);
    controller.store.set({ activeWorkspaceId: null });
    controller.openPalette();
    const search = controller.searchPalette('무엇이든');
    settleAll();
    await search;
    expect(calls.some((c) => c.type === 'file.search')).toBe(false);
    expect(calls.some((c) => c.type === 'session.search')).toBe(true);
  });

  it('항목 실행은 팔레트를 닫고 동작을 넘긴다', async () => {
    const { controller } = await booted();
    controller.openPalette();
    controller.runPaletteAction({ kind: 'select-workspace', workspaceId: 'wsp_1' });
    expect(controller.store.get().palette.open).toBe(false);
    expect(controller.store.get().activeWorkspaceId).toBe('wsp_1');
  });

  it('대화 내용을 고르면 세션을 열고 그 자리를 표시한다', async () => {
    const { controller } = await booted();
    controller.openPalette();
    controller.runPaletteAction({ kind: 'open-timeline', sessionId: 's-1', seq: 42 });
    await vi.waitFor(() => {
      expect(controller.store.get().views['s-1']?.focusSeq).toBe(42);
    });
    expect(controller.layout.active).toBe('session:s-1');
  });

  it('온보딩 중에는 열리지 않는다', async () => {
    const { controller } = await booted();
    controller.navigate('onboarding');
    controller.openPalette();
    // 그 화면은 팔레트를 그리지 않는다 — 상태만 켜지면 단축키가 먹통으로 보인다
    expect(controller.store.get().palette.open).toBe(false);
  });
});
