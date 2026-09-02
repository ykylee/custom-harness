// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TerminalView, type TerminalTransport } from './TerminalView.js';

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    writeln = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    dispose = vi.fn();
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));

class ResizeObserverMock {
  observe = vi.fn();
  disconnect = vi.fn();
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock);

const transport: TerminalTransport = {
  rpc: vi.fn().mockResolvedValue({ slot: 1, scrollback: '', truncated: false }),
  onTerminalData: vi.fn(() => vi.fn()),
  sendTerminalFrame: vi.fn(),
};

describe('TerminalView', () => {
  it('renders a cockpit header around the terminal host', () => {
    const { container } = render(<TerminalView terminalId="term-1" transport={transport} />);

    expect(screen.getByText('터미널')).toBeTruthy();
    expect(screen.getByText('LIVE SHELL')).toBeTruthy();
    expect(container.querySelector('.terminal-cockpit')).toBeTruthy();
    expect(screen.getByTestId('terminal-term-1').className).toContain('terminal-host');
  });
});
