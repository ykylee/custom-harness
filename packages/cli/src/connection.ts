// 데몬 연결 (M7 WBS 7.5.1, FR-9.6) — CLI 가 데몬과 말하는 유일한 통로.
//
// 이전에는 `commands.ts` 안에 "hello 하고 정해진 RPC 두 개를 던지고 닫는" 헬퍼가 있었다.
// 세션 조작 표면(FR-9.6)은 임의의 RPC 와 **이벤트 구독**이 필요해서 그 모양으로는 안 된다.
//
// 렌더러의 `DaemonClient` 를 쓰지 않는 이유: 그쪽은 재연결·재동기화·터미널 바이너리 채널을
// 안고 있는 장기 실행 클라이언트다. CLI 는 명령 하나를 살고 끝난다 — 끊기면 재연결이 아니라
// 종료 코드를 내는 것이 맞다.
import { WebSocket } from 'ws';
import { readFile } from 'node:fs/promises';
import { PROTOCOL_VERSION, type SessionEvent } from '@custom-harness/protocol';
import { readDaemonInfo, type DaemonPaths } from '@custom-harness/daemon';

export class DaemonNotRunningError extends Error {
  constructor() {
    super('실행 중인 데몬이 없습니다 — custom-harness daemon start');
    this.name = 'DaemonNotRunningError';
  }
}

export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class DaemonConnection {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private nextId = 0;
  private closed = false;

  private constructor(
    private readonly ws: WebSocket,
    private readonly clientVersion: string,
  ) {}

  static async open(
    paths: DaemonPaths,
    clientVersion: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<DaemonConnection> {
    const info = await readDaemonInfo(paths);
    if (!info || info.port === null) throw new DaemonNotRunningError();
    const token = (await readFile(paths.tokenFile, 'utf8')).trim();
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}`, [], {
      headers: { authorization: `Bearer ${token}` },
    });
    const connection = new DaemonConnection(ws, clientVersion);
    await connection.handshake(timeoutMs);
    return connection;
  }

  private async handshake(timeoutMs: number): Promise<void> {
    const { ws } = this;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('데몬 연결 타임아웃')), timeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    ws.on('message', (data) => this.dispatch(data));
    // 연결이 먼저 끊기면 대기 중인 요청은 영영 안 온다 — 매달린 프로세스보다 오류가 낫다
    ws.on('close', () => this.failAllPending(new Error('데몬 연결이 끊겼습니다')));

    const hello = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('hello 응답 타임아웃')), timeoutMs);
      this.pending.set('__hello__', { resolve: () => resolve(), reject, timer });
    });
    ws.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'custom-harness-cli', version: this.clientVersion },
        capabilities: {},
      }),
    );
    await hello;
  }

  private dispatch(data: unknown): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return; // 파손 프레임은 무시 — 대기 중인 요청은 타임아웃이 처리한다
    }
    if (frame.type === 'hello.response') {
      this.settle('__hello__', undefined);
      return;
    }
    const requestId = frame.requestId;
    if (typeof requestId === 'string' && this.pending.has(requestId)) {
      if (frame.ok === true) this.settle(requestId, frame.result);
      else {
        const error = frame.error as { code?: string; message?: string } | undefined;
        this.rejectPending(
          requestId,
          new RpcError(error?.code ?? 'unknown', error?.message ?? 'RPC 실패'),
        );
      }
      return;
    }
    // 세션 이벤트 — 봉투(sessionId + seq)가 있는 프레임만 구독자에게 넘긴다.
    // 레지스트리·터미널 이벤트는 CLI 가 소비하지 않는다.
    if (typeof frame.sessionId === 'string' && typeof frame.seq === 'number') {
      for (const listener of this.listeners) listener(frame as unknown as SessionEvent);
    }
  }

  private settle(requestId: string, result: unknown): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve(result);
  }

  private rejectPending(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.reject(error);
  }

  private failAllPending(error: Error): void {
    for (const requestId of [...this.pending.keys()]) this.rejectPending(requestId, error);
  }

  async rpc<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    if (this.closed) throw new Error('연결이 이미 닫혔습니다');
    const requestId = `cli-${this.nextId++}`;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => this.rejectPending(requestId, new Error(`${method} 응답 타임아웃`)),
        timeoutMs,
      );
      this.pending.set(requestId, { resolve, reject, timer });
    });
    this.ws.send(JSON.stringify({ type: `${method}.request`, requestId, params }));
    return (await result) as T;
  }

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 연결이 끊기면 알린다 — 스트리밍 명령이 매달리지 않게 */
  onClose(listener: () => void): void {
    this.ws.once('close', listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAllPending(new Error('연결이 닫혔습니다'));
    this.ws.close();
  }
}
