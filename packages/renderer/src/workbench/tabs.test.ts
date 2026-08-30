import { describe, expect, it } from 'vitest';
import {
  closeTab,
  emptyLayout,
  openTab,
  restoreLayout,
  setSplit,
  tabId,
  targetOf,
} from './tabs.js';

const alive = { sessionIds: new Set(['s-1', 's-2']), terminalIds: new Set(['t-1']) };

describe('탭 타깃 (WBS 6.2.1)', () => {
  it('타깃에서 결정적으로 id 를 유도한다', () => {
    expect(tabId({ kind: 'session', sessionId: 's-1' })).toBe('session:s-1');
    expect(tabId({ kind: 'terminal', terminalId: 't-1' })).toBe('terminal:t-1');
    expect(tabId({ kind: 'files' })).toBe('files');
    expect(tabId({ kind: 'file', path: 'src/a.ts' })).toBe('file:src/a.ts');
    expect(tabId({ kind: 'diff', scope: 'working' })).toBe('diff:working');
    expect(tabId({ kind: 'diff', scope: 'commit', sha: 'abc' })).toBe('diff:abc');
  });

  it('같은 대상은 두 번 열리지 않고 포커스만 옮긴다', () => {
    let layout = openTab(emptyLayout(), { kind: 'session', sessionId: 's-1' });
    layout = openTab(layout, { kind: 'terminal', terminalId: 't-1' });
    expect(layout.active).toBe('terminal:t-1');

    layout = openTab(layout, { kind: 'session', sessionId: 's-1' });
    expect(layout.tabs).toHaveLength(2);
    expect(layout.active).toBe('session:s-1');
  });

  it('탭을 닫으면 이웃으로 포커스가 넘어가고 분할이 정리된다', () => {
    let layout = openTab(emptyLayout(), { kind: 'session', sessionId: 's-1' });
    layout = openTab(layout, { kind: 'session', sessionId: 's-2' });
    layout = setSplit(layout, 'row'); // secondary = session:s-1

    expect(layout.split).toEqual({ direction: 'row', secondary: 'session:s-1' });
    layout = closeTab(layout, 'session:s-1');
    expect(layout.split).toBeNull();
    expect(layout.tabs.map((tab) => tab.id)).toEqual(['session:s-2']);
    expect(layout.active).toBe('session:s-2');
  });

  it('타깃을 id 로 되찾는다', () => {
    const layout = openTab(emptyLayout(), { kind: 'file', path: 'a.ts' });
    expect(targetOf(layout, 'file:a.ts')).toEqual({ kind: 'file', path: 'a.ts' });
    expect(targetOf(layout, null)).toBeUndefined();
  });
});

describe('레이아웃 복원 (WBS 6.2.2)', () => {
  it('살아 있지 않은 타깃은 조용히 버린다', () => {
    const restored = restoreLayout(
      {
        tabs: [
          { target: { kind: 'session', sessionId: 's-1' } },
          { target: { kind: 'session', sessionId: 'gone' } },
          { target: { kind: 'terminal', terminalId: 't-1' } },
          { target: { kind: 'terminal', terminalId: 'gone' } },
          { target: { kind: 'files' } },
        ],
        active: 'session:gone',
        split: null,
      },
      alive,
    );
    expect(restored.tabs.map((tab) => tab.id)).toEqual(['session:s-1', 'terminal:t-1', 'files']);
    // 사라진 활성 탭은 첫 탭으로 내려앉는다
    expect(restored.active).toBe('session:s-1');
  });

  it('구형 배치(문자열 세션 ID 배열)를 읽는다 (§1.4 마이그레이션)', () => {
    const restored = restoreLayout({ tabs: ['s-1', 's-2'], active: 's-2', split: null }, alive);
    expect(restored.tabs.map((tab) => tab.target)).toEqual([
      { kind: 'session', sessionId: 's-1' },
      { kind: 'session', sessionId: 's-2' },
    ]);
    // 구형 active 는 새 id 체계와 맞지 않으므로 첫 탭으로 내려앉는다
    expect(restored.active).toBe('session:s-1');
  });

  it('중복·손상 항목을 버리고 나머지를 살린다', () => {
    const restored = restoreLayout(
      {
        tabs: [
          { target: { kind: 'session', sessionId: 's-1' } },
          { target: { kind: 'session', sessionId: 's-1' } },
          { target: { kind: 'diff' } }, // scope 없음 — 손상
          null,
          { target: { kind: '알수없음' } },
        ],
      },
      alive,
    );
    expect(restored.tabs.map((tab) => tab.id)).toEqual(['session:s-1']);
  });

  it('저장된 값이 없거나 깨져도 빈 레이아웃을 준다', () => {
    expect(restoreLayout(undefined, alive)).toEqual(emptyLayout());
    expect(restoreLayout('깨진 값', alive)).toEqual(emptyLayout());
  });

  it('보조 페인이 살아남지 못하면 분할을 해제한다', () => {
    const restored = restoreLayout(
      {
        tabs: [{ target: { kind: 'session', sessionId: 's-1' } }],
        active: 'session:s-1',
        split: { direction: 'row', secondary: 'session:gone' },
      },
      alive,
    );
    expect(restored.split).toBeNull();
  });
});
