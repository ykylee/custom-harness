// pi 계열 JSONL RPC 전송 base (WBS 1.3.1, FR-1.2.2)
// stdin 으로 명령 JSONL, stdout 으로 응답(type:"response")·이벤트 JSONL.
// omp 재사용 전제: 명령·응답 봉투만 알고 페이로드는 관대하게 통과시킨다.
// (omp v2 협상·rpc_chunk 청킹은 M2 2.1 에서 이 계층 확장으로 구현)
import { AdapterError } from '../contract.js';
import type { ManagedProcess } from '../../processes.js';

interface RpcResponseFrame {
  type: 'response';
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (frame: RpcResponseFrame) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface JsonlRpcOptions {
  /** 응답 타임아웃 — pi 계열 관례 30초 */
  responseTimeoutMs?: number;
  /** 응답이 아닌 모든 프레임(이벤트·extension_ui_request 등) */
  onFrame?: (frame: Record<string, unknown>) => void;
  onStderr?: (chunk: string) => void;
}

export class JsonlRpcTransport {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly responseTimeoutMs: number;
  private buffer = '';
  private nextId = 0;
  private closed = false;

  constructor(
    private readonly process: ManagedProcess,
    private readonly options: JsonlRpcOptions = {},
  ) {
    this.responseTimeoutMs = options.responseTimeoutMs ?? 30_000;
    process.child.stdout?.on('data', (chunk: Buffer) => this.onStdout(String(chunk)));
    process.child.stderr?.on('data', (chunk: Buffer) => options.onStderr?.(String(chunk)));
    void process.exited.then(() =>
      this.failAllPending(new AdapterError('protocol', '프로세스 종료')),
    );
  }

  /** 명령 전송 후 id 상관 응답 대기. success:false 는 AdapterError('protocol') 로 투영 */
  async request(command: Record<string, unknown>): Promise<RpcResponseFrame> {
    if (this.closed) throw new AdapterError('protocol', '전송 계층이 닫힘');
    const id = `rpc-${this.nextId++}`;
    const frame = await new Promise<RpcResponseFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AdapterError('protocol', `RPC 응답 타임아웃 (${String(command.type)})`, {
            retriable: true,
          }),
        );
      }, this.responseTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process.child.stdin?.write(`${JSON.stringify({ ...command, id })}\n`);
    });
    if (!frame.success) {
      throw new AdapterError('protocol', frame.error ?? `RPC 실패: ${frame.command}`, {
        nativeDetail: frame,
      });
    }
    return frame;
  }

  /** 응답을 기다리지 않는 단방향 프레임 (extension_ui_response 등) */
  send(frame: Record<string, unknown>): void {
    if (this.closed) return;
    this.process.child.stdin?.write(`${JSON.stringify(frame)}\n`);
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAllPending(new AdapterError('interrupted', '전송 계층 종료'));
    await this.process.terminate();
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
    if (frame.type === 'response' && typeof frame.id === 'string') {
      const pending = this.pending.get(frame.id);
      if (pending) {
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        pending.resolve(frame as unknown as RpcResponseFrame);
        return;
      }
    }
    this.options.onFrame?.(frame);
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
