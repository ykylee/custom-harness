// ACP(Agent Client Protocol) 공용 클라이언트 (WBS 2.2.1, adapter-contract §5)
// JSON-RPC 2.0 over stdio ndjson. 표준 부분만 담는다 — x.ai/* 확장 처리는 grok.ts 몫.
// 일반화 구현은 하지 않는다(과설계 방지) — 훅(onNotification/onServerRequest)만 분리.
import { AdapterError } from '../contract.js';
import type { ManagedProcess } from '../../processes.js';

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ServerRequest {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface AcpClientOptions {
  /** 요청 타임아웃 기본값 — prompt 는 턴 길이만큼 걸리므로 요청별 오버라이드 사용 */
  requestTimeoutMs?: number;
  /** 알림 (session/update, _x.ai/* 등) */
  onNotification?: (method: string, params: Record<string, unknown>) => void;
  /** 서버→클라이언트 요청 (session/request_permission 등) — respond() 로 응답할 것 */
  onServerRequest?: (request: ServerRequest) => void;
  onStderr?: (chunk: string) => void;
}

export class AcpClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private buffer = '';
  private nextId = 0;
  private closed = false;

  constructor(
    private readonly process: ManagedProcess,
    private readonly options: AcpClientOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    process.child.stdout?.on('data', (chunk: Buffer) => this.onStdout(String(chunk)));
    process.child.stderr?.on('data', (chunk: Buffer) => options.onStderr?.(String(chunk)));
    void process.exited.then(() =>
      this.failAllPending(new AdapterError('protocol', '프로세스 종료')),
    );
  }

  /** 요청 전송 후 id 상관 응답 대기. JSON-RPC error 는 AdapterError('protocol') 로 투영 */
  async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.closed) throw new AdapterError('protocol', 'ACP 클라이언트가 닫힘');
    const id = this.nextId++;
    const result = await new Promise<unknown>((resolve, reject) => {
      const effective = timeoutMs ?? this.requestTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AdapterError('protocol', `ACP 응답 타임아웃 (${method})`, { retriable: true }));
      }, effective);
      // prompt 처럼 무기한 대기가 정당한 요청은 timeoutMs=0 으로 비활성화
      if (timeoutMs === 0) clearTimeout(timer);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
    return result;
  }

  /** 알림 (응답 없음) — session/cancel 등 */
  notify(method: string, params: Record<string, unknown>): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** 서버→클라이언트 요청에 대한 응답 */
  respond(id: number | string, result: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAllPending(new AdapterError('interrupted', 'ACP 클라이언트 종료'));
    // SIGTERM 시 grok 는 세션을 저장한다 (1.0.5 실측) — supervisor 의 단계적 종료에 위임
    await this.process.terminate();
  }

  private write(frame: Record<string, unknown>): void {
    this.process.child.stdin?.write(`${JSON.stringify(frame)}\n`);
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        continue; // 비 JSON 출력은 무시 (관대 파싱, NFR-5)
      }
      if (typeof frame !== 'object' || frame === null) continue;
      this.route(frame as Record<string, unknown>);
    }
  }

  private route(frame: Record<string, unknown>): void {
    const hasId = frame.id !== undefined && frame.id !== null;
    const method = typeof frame.method === 'string' ? frame.method : undefined;
    if (method !== undefined && hasId) {
      // 서버→클라이언트 요청 (request_permission 등)
      this.options.onServerRequest?.({
        id: frame.id as number | string,
        method,
        params: (frame.params ?? {}) as Record<string, unknown>,
      });
      return;
    }
    if (method !== undefined) {
      this.options.onNotification?.(method, (frame.params ?? {}) as Record<string, unknown>);
      return;
    }
    if (hasId && typeof frame.id === 'number') {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      const error = frame.error as { code?: number; message?: string } | undefined;
      if (error) {
        pending.reject(
          new AdapterError('protocol', error.message ?? 'ACP 요청 실패', { nativeDetail: frame }),
        );
        return;
      }
      pending.resolve(frame.result);
    }
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
