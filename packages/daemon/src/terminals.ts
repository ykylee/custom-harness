// 데몬 소유 터미널 (WBS 6.3, workbench-tabs §2).
//
// 소유권이 데몬에 있다는 것이 핵심이다 — 클라이언트가 끊겨도 pty 는 살아 있고, 재접속하면
// 스크롤백부터 이어 붙인다. 클라이언트는 "보는 창"일 뿐이다.
import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import type { Terminal } from '@custom-harness/protocol';
import { spawn as spawnPty, type IPty } from '@lydell/node-pty';

/** 스크롤백 링 버퍼 (workbench-tabs E-2 확정) */
const SCROLLBACK_BYTES = 256 * 1024;

/** 기본 셸 (E-3 확정) — POSIX 는 $SHELL, Windows 는 PowerShell */
export function defaultShell(env: NodeJS.ProcessEnv = process.env): string {
  if (platform() === 'win32')
    return env.COMSPEC?.replace(/cmd\.exe$/i, 'powershell.exe') ?? 'powershell.exe';
  return env.SHELL ?? '/bin/sh';
}

/**
 * 고정 크기 링 버퍼 — 넘치면 앞을 버리고 잘림을 기록한다.
 * 무한 보관은 장시간 빌드 로그 하나로 데몬 메모리를 먹는다.
 */
class Scrollback {
  private chunks: Uint8Array[] = [];
  private size = 0;
  truncated = false;

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > SCROLLBACK_BYTES && this.chunks.length > 0) {
      const dropped = this.chunks.shift()!;
      this.size -= dropped.length;
      this.truncated = true;
    }
  }

  snapshot(): Uint8Array {
    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

interface LiveTerminal {
  record: Terminal;
  pty: IPty | undefined;
  scrollback: Scrollback;
  /** 출력 구독자 — 연결(클라이언트)별로 하나씩 */
  listeners: Set<(chunk: Uint8Array) => void>;
}

export interface CreateTerminalInput {
  workspaceId: string;
  cwd: string;
  cols: number;
  rows: number;
  shell?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export type TerminalChangeReason = 'created' | 'exited' | 'killed';

export class TerminalManager {
  private readonly terminals = new Map<string, LiveTerminal>();
  private readonly changeListeners = new Set<
    (reason: TerminalChangeReason, terminal: Terminal) => void
  >();

  onChange(listener: (reason: TerminalChangeReason, terminal: Terminal) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private emit(reason: TerminalChangeReason, terminal: Terminal): void {
    for (const listener of this.changeListeners) listener(reason, terminal);
  }

  create(input: CreateTerminalInput): Terminal {
    const shell = input.shell ?? defaultShell(input.env);
    const record: Terminal = {
      id: `trm_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      workspaceId: input.workspaceId,
      shell,
      cols: input.cols,
      rows: input.rows,
      createdAt: new Date().toISOString(),
    };
    const pty = spawnPty(shell, [], {
      name: 'xterm-256color',
      cols: input.cols,
      rows: input.rows,
      cwd: input.cwd,
      env: { ...(input.env ?? process.env) } as Record<string, string>,
    });
    const live: LiveTerminal = { record, pty, scrollback: new Scrollback(), listeners: new Set() };
    this.terminals.set(record.id, live);

    pty.onData((data) => {
      // node-pty 는 문자열을 준다 — 바이트로 되돌려 멀티바이트 경계 손상을 피한다
      const bytes = Buffer.from(data, 'utf8');
      live.scrollback.push(bytes);
      for (const listener of live.listeners) listener(bytes);
    });
    pty.onExit(({ exitCode }) => {
      live.pty = undefined;
      live.record = { ...live.record, exitedAt: new Date().toISOString(), exitCode };
      this.emit('exited', live.record);
    });

    this.emit('created', record);
    return record;
  }

  list(workspaceId?: string): Terminal[] {
    const all = [...this.terminals.values()].map((live) => live.record);
    return workspaceId === undefined
      ? all
      : all.filter((terminal) => terminal.workspaceId === workspaceId);
  }

  find(terminalId: string): Terminal | undefined {
    return this.terminals.get(terminalId)?.record;
  }

  /**
   * 출력 구독 + 스크롤백 스냅샷을 **한 번에** 준다.
   * 스냅샷을 따로 읽고 나중에 구독하면 그 사이 출력이 사라진다 — 순서가 계약이다.
   */
  attach(
    terminalId: string,
    listener: (chunk: Uint8Array) => void,
  ): { scrollback: Uint8Array; truncated: boolean; detach: () => void } | undefined {
    const live = this.terminals.get(terminalId);
    if (!live) return undefined;
    const scrollback = live.scrollback.snapshot();
    live.listeners.add(listener);
    return {
      scrollback,
      truncated: live.scrollback.truncated,
      detach: () => live.listeners.delete(listener),
    };
  }

  write(terminalId: string, data: Uint8Array): void {
    const live = this.terminals.get(terminalId);
    live?.pty?.write(Buffer.from(data).toString('utf8'));
  }

  /** 크기는 마지막 resize 가 이긴다 (workbench-tabs §2.6) */
  resize(terminalId: string, cols: number, rows: number): void {
    const live = this.terminals.get(terminalId);
    if (!live?.pty) return;
    live.pty.resize(cols, rows);
    live.record = { ...live.record, cols, rows };
  }

  kill(terminalId: string): void {
    const live = this.terminals.get(terminalId);
    if (!live) return;
    live.pty?.kill();
    live.pty = undefined;
    if (live.record.exitedAt === undefined) {
      live.record = { ...live.record, exitedAt: new Date().toISOString() };
    }
    this.emit('killed', live.record);
  }

  /** 데몬 종료 — 살아 있는 pty 를 전부 정리한다 */
  shutdown(): void {
    for (const live of this.terminals.values()) {
      live.pty?.kill();
      live.pty = undefined;
      live.listeners.clear();
    }
    this.terminals.clear();
    this.changeListeners.clear();
  }
}
