import { describe, expect, it } from 'vitest';
import type { SearchHit, SessionSummary, Workspace } from '@custom-harness/protocol';
import { buildItems, scoreMatch, type PaletteSources } from './items.js';

const session = (overrides: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    sessionId: 's-1',
    harness: 'mock',
    cwd: '/repo',
    status: 'idle',
    seq: 0,
    ...overrides,
  }) as SessionSummary;

const workspace = (overrides: Partial<Workspace> = {}): Workspace =>
  ({
    id: 'ws-1',
    projectId: 'p-1',
    cwd: '/repo',
    checkoutRoot: '/repo',
    isolation: 'none',
    displayName: '메인 작업공간',
    labels: {},
    setupState: 'none',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }) as Workspace;

const hit = (overrides: Partial<SearchHit> = {}): SearchHit =>
  ({
    sessionId: 's-9',
    seq: 42,
    kind: 'assistant',
    snippet: '인덱스 전략을 정한다',
    harness: 'mock',
    ...overrides,
  }) as SearchHit;

const sources = (overrides: Partial<PaletteSources> = {}): PaletteSources => ({
  sessions: [],
  workspaces: [],
  filePaths: [],
  hits: [],
  context: { hasActiveTab: true, hasWorkspace: true, isSplit: false },
  ...overrides,
});

describe('scoreMatch', () => {
  it('부분 문자열이 부분 수열을 이긴다', () => {
    // `index` 로 index.ts 를 찾는 것이 i…n…d…e…x 로 흩어져 맞는 것보다 의도에 가깝다
    const direct = scoreMatch('index.ts', 'index');
    const spread = scoreMatch('inbound/dev/ext.ts', 'index');
    expect(direct).toBeDefined();
    expect(spread).toBeDefined();
    expect(direct!).toBeLessThan(spread!);
  });

  it('부분 수열로도 찾는다 — 팔레트의 기본 기대다', () => {
    expect(scoreMatch('packages/daemon/src/index.ts', 'dsi')).toBeDefined();
    expect(scoreMatch('packages/daemon/src/index.ts', 'zzz')).toBeUndefined();
  });

  it('매치가 이를수록 앞이다', () => {
    expect(scoreMatch('abc-target', 'target')!).toBeGreaterThan(
      scoreMatch('target-abc', 'target')!,
    );
  });

  it('대소문자를 가리지 않고, 빈 질의는 전부 통과다', () => {
    expect(scoreMatch('README.md', 'readme')).toBeDefined();
    expect(scoreMatch('무엇이든', '')).toBe(0);
  });
});

describe('buildItems', () => {
  it('빈 질의에도 할 만한 것을 보여 준다', () => {
    // 빈 화면으로 열리면 사용자는 무엇을 칠지도 모른다
    const items = buildItems('', sources({ sessions: [session()] }));
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.group).toBe('command');
  });

  it('다섯 소스를 한 목록에 세운다', () => {
    const items = buildItems(
      '전략',
      sources({
        sessions: [session({ title: '전략 세션' })],
        workspaces: [workspace({ displayName: '전략 작업공간' })],
        filePaths: ['docs/전략.md'],
        hits: [hit()],
      }),
    );
    expect(new Set(items.map((item) => item.group))).toEqual(
      new Set(['session', 'workspace', 'file', 'timeline']),
    );
  });

  it('지금 쓸 수 없는 명령은 아예 안 보인다', () => {
    // 눌러도 아무 일이 없는 항목은 없는 것보다 나쁘다
    const withTab = buildItems('탭 닫기', sources());
    expect(withTab.map((item) => item.action)).toContainEqual({ kind: 'command', id: 'close-tab' });

    const noTab = buildItems(
      '탭 닫기',
      sources({ context: { hasActiveTab: false, hasWorkspace: true, isSplit: false } }),
    );
    expect(noTab).toHaveLength(0);
  });

  it('분할 해제는 분할 중일 때만 나온다', () => {
    expect(buildItems('분할 해제', sources())).toHaveLength(0);
    expect(
      buildItems(
        '분할 해제',
        sources({ context: { hasActiveTab: true, hasWorkspace: true, isSplit: true } }),
      ),
    ).toHaveLength(1);
  });

  it('워크스페이스가 없으면 워크스페이스를 전제하는 명령이 빠진다', () => {
    const items = buildItems(
      '',
      sources({ context: { hasActiveTab: false, hasWorkspace: false, isSplit: false } }),
    );
    const ids = items.map((item) => item.action).filter((a) => a.kind === 'command');
    expect(ids).not.toContainEqual({ kind: 'command', id: 'new-terminal' });
    expect(ids).toContainEqual({ kind: 'command', id: 'new-session' });
  });

  it('대화 내용은 데몬이 준 순서를 지킨다', () => {
    // 조각난 스니펫에 라벨 점수를 다시 매기면 데몬의 최근순을 근거 없이 뒤엎는다
    const items = buildItems(
      '전략',
      sources({
        hits: [
          hit({ sessionId: 's-1', seq: 1, snippet: '나중 것' }),
          hit({ sessionId: 's-2', seq: 2, snippet: '전략 전략 전략' }),
        ],
      }),
    );
    const timeline = items.filter((item) => item.group === 'timeline');
    expect(timeline.map((item) => item.label)).toEqual(['나중 것', '전략 전략 전략']);
  });

  it('스니펫이 질의를 문자로 담지 않아도 결과에서 빠지지 않는다', () => {
    // 데몬은 세그먼트 전체를 보고 골랐고 스니펫은 그 일부다 — 여기서 다시 거르면 사라진다
    const items = buildItems('전략', sources({ hits: [hit({ snippet: '…앞부분만 잘린 본문…' })] }));
    expect(items.filter((item) => item.group === 'timeline')).toHaveLength(1);
  });

  it('세션은 제목이 없으면 id 로 보인다', () => {
    const items = buildItems('s-1', sources({ sessions: [session()] }));
    expect(items[0]).toMatchObject({ label: 's-1', detail: 'mock · idle' });
  });

  it('파일은 이름을 라벨로, 전체 경로를 보조 설명으로 쓴다', () => {
    const items = buildItems('index', sources({ filePaths: ['packages/daemon/src/index.ts'] }));
    expect(items[0]).toMatchObject({
      label: 'index.ts',
      detail: 'packages/daemon/src/index.ts',
      action: { kind: 'open-file', path: 'packages/daemon/src/index.ts' },
    });
  });

  it('경로로도 찾힌다 — 라벨이 안 맞으면 보조 설명을 본다', () => {
    const items = buildItems('daemon/src', sources({ filePaths: ['packages/daemon/src/main.ts'] }));
    expect(items).toHaveLength(1);
  });

  it('항목 id 는 대상마다 안정적이다 — 질의가 바뀌어도 같은 것은 같다', () => {
    const only = (query: string): string | undefined =>
      buildItems(query, sources({ sessions: [session({ title: '전략 세션' })] })).find(
        (item) => item.group === 'session',
      )?.id;
    expect(only('전략')).toBe('session:s-1');
    expect(only('세션')).toBe('session:s-1');
  });
});
