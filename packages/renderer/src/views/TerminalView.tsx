// 터미널 탭 (WBS 6.3.4, workbench-tabs §2) — xterm 렌더링 + 바이너리 채널 배선.
//
// 데몬이 pty 를 소유하므로 이 컴포넌트는 순수하게 "보는 창"이다. 언마운트는 detach 일 뿐
// 터미널을 죽이지 않는다.
import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import { TERMINAL_OPCODE, encodeTerminalFrame, type TerminalFrame } from '@custom-harness/protocol';
import '@xterm/xterm/css/xterm.css';

export interface TerminalTransport {
  rpc(type: string, params?: Record<string, unknown>): Promise<unknown>;
  onTerminalData(listener: (frame: TerminalFrame) => void): () => void;
  sendTerminalFrame(frame: Uint8Array): void;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

export function TerminalView({
  terminalId,
  transport,
  onError,
}: {
  terminalId: string;
  transport: TerminalTransport;
  onError?: (error: unknown) => void;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const term = new XTerm({
      convertEol: false,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: { background: '#0f1115', foreground: '#d7dae0' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    let slot: number | undefined;
    let disposed = false;
    const decoder = new TextDecoder();

    // 출력: 슬롯이 일치하는 프레임만 이 창의 것이다
    const unsubscribe = transport.onTerminalData((frame) => {
      if (frame.opcode !== TERMINAL_OPCODE.output || frame.slot !== slot) return;
      term.write(decoder.decode(frame.payload, { stream: true }));
    });

    // 입력: 키 입력을 바이트로 실어 보낸다
    const inputDisposable = term.onData((data) => {
      if (slot === undefined) return;
      transport.sendTerminalFrame(
        encodeTerminalFrame({
          opcode: TERMINAL_OPCODE.input,
          slot,
          payload: new TextEncoder().encode(data),
        }),
      );
    });

    void (async () => {
      try {
        const attached = (await transport.rpc('terminal.attach', {
          terminalId,
          cols: term.cols,
          rows: term.rows,
        })) as { slot: number; scrollback: string; truncated: boolean };
        if (disposed) {
          void transport.rpc('terminal.detach', { terminalId });
          return;
        }
        if (attached.truncated) {
          term.writeln('\u001b[2m… 이전 출력 일부가 잘렸습니다\u001b[0m');
        }
        // 스냅샷을 먼저 그리고 슬롯을 켠다 — 순서가 뒤바뀌면 중복·누락이 생긴다
        term.write(decoder.decode(decodeBase64(attached.scrollback), { stream: true }));
        slot = attached.slot;
      } catch (error) {
        onError?.(error);
      }
    })();

    const resize = (): void => {
      fit.fit();
      if (slot === undefined) return;
      void transport
        .rpc('terminal.resize', { terminalId, cols: term.cols, rows: term.rows })
        .catch(() => undefined); // 크기 보고 실패는 표시에 영향 없다
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    return () => {
      disposed = true;
      observer.disconnect();
      unsubscribe();
      inputDisposable.dispose();
      // 언마운트는 detach 일 뿐 — 터미널은 데몬에 살아 있다
      void transport.rpc('terminal.detach', { terminalId }).catch(() => undefined);
      term.dispose();
    };
  }, [terminalId, transport, onError]);

  return <div className="terminal-view" data-testid={`terminal-${terminalId}`} ref={hostRef} />;
}
