// pi 계열 JSONL RPC 전송 base (WBS 1.3.1·2.1.1, FR-1.2.2/1.2.3)
// stdin 으로 명령 JSONL, stdout 으로 응답(type:"response")·이벤트 JSONL.
// omp 재사용 전제: 명령·응답 봉투만 알고 페이로드는 관대하게 통과시킨다.
// protocol v2 청킹(rpc_chunk)은 stdout(수신) 전용 — omp 소스 실측(17.3.8):
// 서버 stdin 경로에는 재조립기가 없어 송신 프레임은 1MiB 라인 한도를 넘을 수 없다.
import { AdapterError } from '../contract.js';
import type { ManagedProcess } from '../../processes.js';

/** 물리 프레임(개행 포함) 최대 크기 — omp rpc-frame.ts 실측 상수와 동일 */
export const MAX_RPC_FRAME_BYTES = 1024 * 1024;
/** v2 재조립 논리 프레임 최대 크기 */
export const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;

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

interface PendingChunks {
  chunkId: string;
  count: number;
  byteLength: number;
  nextIndex: number;
  chunks: Buffer[];
  receivedBytes: number;
}

/**
 * rpc_chunk 재조립기 (omp protocol v2, WBS 2.1.1) — omp rpc-frame.ts RpcFrameDecoder 실측 사양.
 * 시퀀스는 index 0 부터 연속·비인터리브. 위반 시 예외 대신 시퀀스를 버리고 undefined 반환(관대 파싱, NFR-5).
 */
export class RpcChunkReassembler {
  private pending: PendingChunks | undefined;

  /** rpc_chunk 프레임을 누적한다. 완성 시 재조립된 프레임, 미완 시 undefined */
  push(
    frame: Record<string, unknown>,
    onWarning?: (message: string) => void,
  ): Record<string, unknown> | undefined {
    const fail = (reason: string): undefined => {
      this.pending = undefined;
      onWarning?.(`rpc_chunk 시퀀스 폐기: ${reason}`);
      return undefined;
    };
    const { chunkId, index, count, byteLength } = frame as {
      chunkId?: unknown;
      index?: unknown;
      count?: unknown;
      byteLength?: unknown;
    };
    if (
      typeof chunkId !== 'string' ||
      chunkId.length === 0 ||
      chunkId.length > 128 ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(byteLength) ||
      (index as number) < 0 ||
      (count as number) < 2 ||
      (index as number) >= (count as number) ||
      (byteLength as number) > MAX_RPC_REASSEMBLED_BYTES
    ) {
      return fail('메타데이터 불량');
    }
    if (typeof frame.data !== 'string') return fail('data 필드 불량');
    let bytes: Buffer;
    try {
      bytes = Buffer.from(frame.data, 'base64');
    } catch {
      return fail('base64 디코딩 실패');
    }

    if (!this.pending) {
      if (index !== 0) return fail('시퀀스가 index 0 으로 시작하지 않음');
      this.pending = {
        chunkId,
        count: count as number,
        byteLength: byteLength as number,
        nextIndex: 0,
        chunks: [],
        receivedBytes: 0,
      };
    }
    const pending = this.pending;
    if (
      pending.chunkId !== chunkId ||
      pending.count !== count ||
      pending.byteLength !== byteLength ||
      pending.nextIndex !== index
    ) {
      return fail('시퀀스 불일치');
    }
    pending.chunks.push(bytes);
    pending.receivedBytes += bytes.byteLength;
    pending.nextIndex += 1;
    if (pending.receivedBytes > pending.byteLength) return fail('선언 길이 초과');
    if (pending.nextIndex < pending.count) return undefined;
    if (pending.receivedBytes !== pending.byteLength) return fail('선언 길이 불일치');

    this.pending = undefined;
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(pending.chunks).toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null) return fail('재조립 결과가 객체 아님');
      return parsed as Record<string, unknown>;
    } catch {
      return fail('재조립 JSON 파싱 실패');
    }
  }

  /** 비청크 프레임 도착 시 호출 — 진행 중 시퀀스가 있으면 폐기 (인터리브 금지 사양) */
  interrupt(onWarning?: (message: string) => void): void {
    if (this.pending) {
      this.pending = undefined;
      onWarning?.('rpc_chunk 시퀀스 폐기: 비청크 프레임 인터리브');
    }
  }
}

export interface JsonlRpcOptions {
  /** 응답 타임아웃 — pi 계열 관례 30초 */
  responseTimeoutMs?: number;
  /** 응답이 아닌 모든 프레임(이벤트·extension_ui_request 등) */
  onFrame?: (frame: Record<string, unknown>) => void;
  onStderr?: (chunk: string) => void;
  /** 전송 계층 경고 (청크 시퀀스 폐기 등) — 프로토콜을 죽이지 않는 이상 신호 */
  onWarning?: (message: string) => void;
}

export class JsonlRpcTransport {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly responseTimeoutMs: number;
  private readonly reassembler = new RpcChunkReassembler();
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
    const line = this.encodeLine({ ...command, id });
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
      this.process.child.stdin?.write(line);
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
    this.process.child.stdin?.write(this.encodeLine(frame));
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAllPending(new AdapterError('interrupted', '전송 계층 종료'));
    await this.process.terminate();
  }

  /** stdin 은 청킹 미지원(실측) — 1MiB 한도 초과 송신은 명시 에러 (silent 절단 금지) */
  private encodeLine(frame: Record<string, unknown>): string {
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line, 'utf8') > MAX_RPC_FRAME_BYTES) {
      throw new AdapterError(
        'protocol',
        `송신 프레임이 라인 한도(1MiB) 초과 (${String(frame.type)}) — stdin 청킹 미지원`,
      );
    }
    return line;
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
    if (frame.type === 'rpc_chunk') {
      const reassembled = this.reassembler.push(frame, this.options.onWarning);
      if (reassembled) this.route(reassembled);
      return;
    }
    this.reassembler.interrupt(this.options.onWarning);
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
