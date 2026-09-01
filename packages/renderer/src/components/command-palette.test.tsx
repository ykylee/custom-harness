// 커맨드 팔레트 UI (M7 WBS 7.4.2, FR-9.4) — 키보드 조작과 목록 표시.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CommandPalette } from './CommandPalette.js';
import type { PaletteItem } from '../palette/items.js';

const items: PaletteItem[] = [
  {
    id: 'command:new-session',
    group: 'command',
    label: '새 세션',
    action: { kind: 'command', id: 'new-session' },
  },
  {
    id: 'session:s-1',
    group: 'session',
    label: '전략 세션',
    detail: 'mock · idle',
    action: { kind: 'open-session', sessionId: 's-1' },
  },
  {
    id: 'file:src/index.ts',
    group: 'file',
    label: 'index.ts',
    detail: 'src/index.ts',
    action: { kind: 'open-file', path: 'src/index.ts' },
  },
];

const renderPalette = (
  overrides: Partial<React.ComponentProps<typeof CommandPalette>> = {},
): {
  run: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} => {
  const run = vi.fn();
  const search = vi.fn();
  const close = vi.fn();
  render(
    <CommandPalette
      query=""
      items={items}
      loading={false}
      actions={{ run, search, close }}
      {...overrides}
    />,
  );
  return { run, search, close };
};

const input = (): HTMLElement => screen.getByLabelText('커맨드 팔레트');

// globals 를 켜지 않은 설정이라 자동 정리가 안 붙는다 — 명시 해제 (repo 관례)
afterEach(cleanup);

describe('CommandPalette', () => {
  it('그룹 머리글과 함께 항목을 그린다', () => {
    renderPalette();
    expect(screen.getByText('명령')).toBeTruthy();
    expect(screen.getByText('세션')).toBeTruthy();
    expect(screen.getByText('파일')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('첫 항목이 선택된 채로 열린다 — Enter 가 바로 통해야 한다', () => {
    const { run } = renderPalette();
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(run).toHaveBeenCalledWith({ kind: 'command', id: 'new-session' });
  });

  it('화살표로 옮기고 Enter 로 실행한다', () => {
    const { run } = renderPalette();
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(run).toHaveBeenCalledWith({ kind: 'open-file', path: 'src/index.ts' });
  });

  it('목록 끝에서 아래로 가면 처음으로 돈다', () => {
    // 아무 일도 안 일어나면 멈춘 것처럼 보인다
    const { run } = renderPalette();
    for (let i = 0; i < items.length; i += 1) fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(run).toHaveBeenCalledWith({ kind: 'command', id: 'new-session' });
  });

  it('위로 가면 끝에서 이어진다', () => {
    const { run } = renderPalette();
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(run).toHaveBeenCalledWith({ kind: 'open-file', path: 'src/index.ts' });
  });

  it('Esc 로 닫는다', () => {
    const { close } = renderPalette();
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(close).toHaveBeenCalled();
  });

  it('바깥을 누르면 닫히고, 안쪽은 닫지 않는다', () => {
    const { close } = renderPalette();
    fireEvent.mouseDown(screen.getByTestId('command-palette'));
    expect(close).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByTestId('command-palette').parentElement!);
    expect(close).toHaveBeenCalled();
  });

  it('입력은 그대로 위로 넘긴다 — 필터링은 여기서 하지 않는다', () => {
    const { search } = renderPalette();
    fireEvent.change(input(), { target: { value: '전략' } });
    expect(search).toHaveBeenCalledWith('전략');
    // 화면이 스스로 거르면 순위 규칙이 컨트롤러와 갈라진다
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('클릭으로도 실행된다', () => {
    const { run } = renderPalette();
    fireEvent.mouseDown(screen.getByText('전략 세션'));
    expect(run).toHaveBeenCalledWith({ kind: 'open-session', sessionId: 's-1' });
  });

  it('결과가 없으면 그렇게 말한다', () => {
    renderPalette({ items: [], loading: false });
    expect(screen.getByText('결과 없음')).toBeTruthy();
  });

  it('원격 조회 중에도 이미 있는 목록을 가리지 않는다', () => {
    // 팔레트가 잠깐이라도 빈 화면이 되면 사용자는 그냥 닫는다
    renderPalette({ loading: true });
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.getByTestId('palette-loading')).toBeTruthy();
  });

  it('결과가 없고 조회 중이면 검색 중이라고 알린다', () => {
    renderPalette({ items: [], loading: true });
    expect(screen.getByText('검색 중…')).toBeTruthy();
  });

  it('같은 그룹이 떨어져 나오면 머리글을 다시 붙인다', () => {
    // 순위가 점수 우선이라 그룹은 섞여 나올 수 있다 — 머리글이 한 번뿐이면 오도한다
    renderPalette({
      items: [
        items[0]!,
        items[1]!,
        { ...items[0]!, id: 'command:open-settings', label: '설정 열기' },
      ],
    });
    expect(screen.getAllByText('명령')).toHaveLength(2);
  });
});
