// 데몬 WS 클라이언트 (WBS 1.5.1, protocol-design §4·§5)
// 토큰은 Sec-WebSocket-Protocol 로 전달(브라우저 경로), 지수 백오프 재연결 +
// 애플리케이션 레벨 ping/pong. 끊김 시 대기 중 RPC 는 즉시 실패, 재연결 후 재동기화 훅 호출.
import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  type HelloResponse,
  type SessionEvent,
} from '@custom-harness/protocol';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';

/** 브라우저 WebSocket 최소 표면 — 테스트에서 node `ws` 주입 가능 */
interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface DaemonClientOptions {
  url: string;
  token: string;
  clientInfo?: { name: string; version: string };
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** 테스트 주입용 — 기본은 전역 WebSocket */
  webSocketFactory?: (url: string, protocols: string[]) => WebSocketLike;
}

interface PendingRpc {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class RpcFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retriable?: boolean,
  ) {
    super(message);
    this.name = 'RpcFailure';
  }
}

export class DaemonClient {
  private ws: WebSocketLike | undefined;
  private state: ConnectionState = 'closed';
  private stopped = false;
  private attempt = 0;
  private nextRequestId = 0;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private readonly eventListeners = new Set<(event: SessionEvent) => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private helloResponse: HelloResponse | undefined;
  private everConnected = false;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: DaemonClientOptions) {}

  getState(): ConnectionState {
    return this.state;
  }

  /** 데몬 features — 렌더러 기능 게이트 단일 지점 (protocol-design §3) */
  getFeatures(): Record<string, boolean> {
    return this.helloResponse?.features ?? {};
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** 재연결(hello 완료) 후 호출 — 스토어가 session.list + timeline 재동기화 수행 */
  onReconnected(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.setState('closed');
  }

  async rpc(type: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.state !== 'connected') {
      throw new RpcFailure('disconnected', '데몬에 연결되어 있지 않음', true);
    }
    const requestId = `r-${this.nextRequestId++}`;
    const frame = { type: `${type}.request`, requestId, params };
    // 발신 프레임도 스키마로 검증 — 형식 오류를 로컬에서 조기 발견
    const parsed = ClientMessageSchema.safeParse(frame);
    if (!parsed.success) {
      throw new RpcFailure('bad_request', `요청 형식 오류: ${type}`);
    }
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.ws?.send(JSON.stringify(frame));
    });
  }

  private connect(): void {
    this.setState(this.everConnected ? 'reconnecting' : 'connecting');
    const factory =
      this.options.webSocketFactory ??
      ((url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike);
    const ws = factory(this.options.url, [this.options.token]);
    this.ws = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: this.options.clientInfo ?? { name: 'renderer', version: '0.1.0' },
          capabilities: {},
        }),
      );
    };
    ws.onmessage = (event) => this.onMessage(String(event.data));
    ws.onerror = () => {
      // onclose 가 이어서 온다 — 재연결은 거기서
    };
    ws.onclose = () => this.onClose();
  }

  private onMessage(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = ServerMessageSchema.safeParse(json);
    if (!parsed.success) return; // 미지 프레임은 무시 (관대 파싱, NFR-5)
    const message = parsed.data;

    if (message.type === 'hello.response') {
      this.helloResponse = message;
      this.attempt = 0;
      const wasConnectedBefore = this.everConnected;
      this.everConnected = true;
      this.setState('connected');
      this.startPing();
      if (wasConnectedBefore) for (const listener of this.reconnectListeners) listener();
      return;
    }
    if (message.type === 'pong') {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
      return;
    }
    if (message.type === 'ping') {
      this.ws?.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if ('requestId' in message && 'ok' in message) {
      // loose 스키마의 인덱스 시그니처 탓에 유니온 판별이 좁혀지지 않아 국소 형으로 단언
      const response = message as unknown as {
        requestId: string;
        ok: boolean;
        result?: unknown;
        error?: { code: string; message: string; retriable?: boolean };
      };
      const pending = this.pending.get(response.requestId);
      if (!pending) return;
      this.pending.delete(response.requestId);
      if (response.ok) pending.resolve(response.result);
      else
        pending.reject(
          new RpcFailure(
            response.error?.code ?? 'internal',
            response.error?.message ?? 'RPC 실패',
            response.error?.retriable,
          ),
        );
      return;
    }
    for (const listener of this.eventListeners) listener(message as SessionEvent);
  }

  private onClose(): void {
    this.clearTimers();
    // 끊김 시 대기 중 RPC 즉시 실패 (protocol-design §5)
    for (const pending of this.pending.values()) {
      pending.reject(new RpcFailure('disconnected', '연결 끊김', true));
    }
    this.pending.clear();
    if (this.stopped) return;
    const base = this.options.backoffBaseMs ?? 500;
    const max = this.options.backoffMaxMs ?? 10_000;
    const delay = Math.min(base * 2 ** this.attempt, max);
    this.attempt += 1;
    this.setState('reconnecting');
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startPing(): void {
    const interval = this.options.pingIntervalMs ?? 15_000;
    const pongTimeout = this.options.pongTimeoutMs ?? 5_000;
    this.pingTimer = setInterval(() => {
      if (this.state !== 'connected') return;
      this.ws?.send(JSON.stringify({ type: 'ping' }));
      this.pongTimer ??= setTimeout(() => {
        // pong 미수신 — 연결이 죽은 것으로 보고 재연결 유도
        this.ws?.close();
      }, pongTimeout);
    }, interval);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = undefined;
    this.pongTimer = undefined;
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }
}
