// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Composer } from './Composer.js';

afterEach(cleanup);

const commands = [
  {
    id: 'harness:omp:compact',
    name: '/compact',
    title: '대화 압축',
    description: '현재 대화를 압축합니다.',
    source: 'harness' as const,
    executionMode: 'raw-prompt' as const,
  },
];

describe('Composer slash command completion', () => {
  it('Tab only completes a suggestion; it never sends the command', () => {
    const submit = vi.fn();
    render(<Composer disabled={false} commands={commands} onSubmit={submit} />);
    const input = screen.getByPlaceholderText('메시지 입력 (Enter 전송 · ⌘/Ctrl+Enter 줄바꿈)');
    fireEvent.change(input, { target: { value: '/co' } });
    expect(screen.getByRole('option').textContent).toContain('/compact');
    fireEvent.keyDown(input, { key: 'Tab' });
    expect((input as HTMLTextAreaElement).value).toBe('/compact ');
    expect(submit).not.toHaveBeenCalled();
  });

  it('keeps unknown slash input as a normal raw prompt', () => {
    const submit = vi.fn();
    render(<Composer disabled={false} commands={commands} onSubmit={submit} />);
    const input = screen.getByPlaceholderText('메시지 입력 (Enter 전송 · ⌘/Ctrl+Enter 줄바꿈)');
    fireEvent.change(input, { target: { value: '/native-unknown' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(submit).toHaveBeenCalledWith('/native-unknown');
  });

  it('keeps the composer enabled and explains queueing while a turn runs', () => {
    render(<Composer disabled={false} queueing queuedCount={2} onSubmit={vi.fn()} />);
    expect(
      screen.getByPlaceholderText('다음 메시지를 대기열에 추가 (Enter 전송 · ⌘/Ctrl+Enter 줄바꿈)'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: '대기열 추가' })).toBeTruthy();
    expect(screen.getByText('대기 2')).toBeTruthy();
  });

  it('leaves Cmd/Ctrl+Enter for a textarea line break', () => {
    const submit = vi.fn();
    render(<Composer disabled={false} onSubmit={submit} />);
    const input = screen.getByPlaceholderText('메시지 입력 (Enter 전송 · ⌘/Ctrl+Enter 줄바꿈)');
    const event = fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(event).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });
});
