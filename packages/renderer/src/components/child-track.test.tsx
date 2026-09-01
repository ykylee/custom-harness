// @vitest-environment jsdom
// 자식 세션 트랙 (M7 WBS 7.3.3, FR-9.3)
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionUsageTree } from '@custom-harness/protocol';
import { ChildTrack } from './ChildTrack.js';

afterEach(cleanup);

function tree(overrides: Partial<SessionUsageTree> = {}): SessionUsageTree {
  return {
    own: { totalTokens: 100 },
    subtree: { totalTokens: 350 },
    childCount: 2,
    activeChildCount: 1,
    children: [
      {
        sessionId: 'child-a',
        status: 'running',
        harness: 'omp',
        usage: { totalTokens: 200 },
        subtree: { totalTokens: 250 },
      },
      {
        sessionId: 'child-b',
        status: 'closed',
        harness: 'pi',
        subtree: { totalTokens: 0 },
      },
    ],
    ...overrides,
  } as SessionUsageTree;
}

describe('ChildTrack', () => {
  it('자식도 부모도 없으면 아무것도 그리지 않는다 — 빈 줄을 남기지 않는다', () => {
    const { container } = render(
      <ChildTrack
        usage={tree({ children: [], childCount: 0, activeChildCount: 0 })}
        actions={{ open: vi.fn() }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('아직 비용을 못 받았어도 부모 링크는 그린다 — 자식 탭이 맥락을 잃으면 안 된다', () => {
    render(<ChildTrack usage={undefined} parentSessionId="p-1" actions={{ open: vi.fn() }} />);
    expect(screen.getByTestId('child-track')).toBeTruthy();
    expect(screen.queryByTestId('child-track-total')).toBeNull();
  });

  it('자식마다 상태·하네스·자손 합을 보여 준다', () => {
    render(<ChildTrack usage={tree()} actions={{ open: vi.fn() }} />);
    const chip = screen.getByTestId('child-chip-child-a');
    expect(chip.textContent).toContain('omp');
    // 자식 자신(200)이 아니라 그 가지 전체(250)를 보여 준다 — 판단 기준은 가지 비용이다
    expect(chip.textContent).toContain('250tk');
    expect(chip.querySelector('.status-running')).toBeTruthy();
  });

  it('합계와 내 대화를 나눠 표시한다 (FR-9.3 사용량 합산 필수)', () => {
    render(<ChildTrack usage={tree()} actions={{ open: vi.fn() }} />);
    const total = screen.getByTestId('child-track-total').textContent ?? '';
    expect(total).toContain('350tk');
    expect(total).toContain('100tk');
  });

  it('닫힌 자식이 섞이면 진행 수를 함께 알린다', () => {
    render(<ChildTrack usage={tree()} actions={{ open: vi.fn() }} />);
    expect(screen.getByTestId('child-track').textContent).toContain('진행 1');
  });

  it('전부 진행 중이면 진행 수를 덧붙이지 않는다 — 같은 값을 두 번 읽히지 않는다', () => {
    const all = tree({ activeChildCount: 2 });
    render(<ChildTrack usage={all} actions={{ open: vi.fn() }} />);
    expect(screen.getByTestId('child-track').textContent).not.toContain('진행');
  });

  it('자식·부모를 누르면 그 세션을 연다 — 자식도 1급 세션이다', () => {
    const open = vi.fn();
    render(<ChildTrack usage={tree()} parentSessionId="p-1" actions={{ open }} />);
    fireEvent.click(screen.getByTestId('child-chip-child-b'));
    expect(open).toHaveBeenCalledWith('child-b');
    fireEvent.click(screen.getByText('↑ 부모 세션'));
    expect(open).toHaveBeenCalledWith('p-1');
  });

  it('보고되지 않은 토큰은 0 이 아니라 —(모름)으로 둔다', () => {
    const unknown = tree({
      subtree: {},
      own: {},
      children: [{ sessionId: 'c', status: 'idle', harness: 'grok', subtree: {} }],
      childCount: 1,
      activeChildCount: 1,
    });
    render(<ChildTrack usage={unknown} actions={{ open: vi.fn() }} />);
    expect(screen.getByTestId('child-chip-c').textContent).toContain('—tk');
    expect(screen.getByTestId('child-track-total').textContent).toContain('—tk');
  });

  it('큰 값은 천 단위로 줄여 줄이 흔들리지 않게 한다', () => {
    render(
      <ChildTrack usage={tree({ subtree: { totalTokens: 12_400 } })} actions={{ open: vi.fn() }} />,
    );
    expect(screen.getByTestId('child-track-total').textContent).toContain('12.4ktk');
  });
});
