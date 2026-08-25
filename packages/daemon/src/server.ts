// WS 서버 (protocol-design §1·§4, NFR-3)
// 127.0.0.1 바인드 고정, 토큰 인증 2중화(Bearer 헤더 + Sec-WebSocket-Protocol), hello 선행.
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  type CapabilityFlags,
  type ClientMessage,
  type ServerMessage,
} from '@custom-harness/protocol';
import { DaemonError, toRpcError } from './errors.js';
import type { KeyStore } from './gateway/key-store.js';
import type { GatewayService } from './gateway/service.js';
import type { SessionManager } from './session-manager.js';

export interface DaemonServerOptions {
  manager: SessionManager;
  token: string;
  serverVersion: string;
  port?: number;
  /** hello.response.features — 렌더러 기능 게이트 (protocol-design §3) */
  features?: CapabilityFlags;
  /** config.* 도메인 배선 (WBS 1.4.3) — 미공급 시 unimplemented 응답 */
  gateway?: GatewayService;
  keyStore?: KeyStore;
  onShutdownRequest?: () => void;
}

const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_PROTOCOL_ERROR = 4400;

export class DaemonServer {
  private wss: WebSocketServer | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly helloDone = new WeakSet<WebSocket>();

  constructor(private readonly options: DaemonServerOptions) {}

  async start(): Promise<{ port: number }> {
    const { token } = this.options;
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: this.options.port ?? 0,
      // 브라우저 경로: 커스텀 헤더 불가 → 토큰을 서브프로토콜로 전달 (protocol-design §4)
      handleProtocols: (protocols) => (protocols.has(token) ? token : false),
    });
    this.wss = wss;

    wss.on('connection', (ws, req) => {
      if (!this.isAuthorized(ws, req)) {
        ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
      ws.on('message', (data) => {
        void this.onFrame(ws, String(data));
      });
    });

    // 매니저 이벤트 → hello 완료 연결 전체에 브로드캐스트
    this.unsubscribe = this.options.manager.onEvent((event) => {
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN && this.helloDone.has(client)) {
          this.send(client, event);
        }
      }
    });

    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
    return { port: (wss.address() as AddressInfo).port };
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    const wss = this.wss;
    if (!wss) return;
    for (const client of wss.clients) client.close(1001, 'daemon shutdown');
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    this.wss = undefined;
  }

  private isAuthorized(ws: WebSocket, req: IncomingMessage): boolean {
    if (req.headers.authorization === `Bearer ${this.options.token}`) return true;
    return ws.protocol === this.options.token; // handleProtocols 를 통과한 서브프로토콜 경로
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    ws.send(JSON.stringify(message));
  }

  private async onFrame(ws: WebSocket, raw: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      ws.close(CLOSE_PROTOCOL_ERROR, 'invalid json');
      return;
    }
    const parsed = ClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.rejectUnparsable(ws, json);
      return;
    }
    const message = parsed.data;

    // hello 선행 규약 — 봉투 2계층의 연결 레벨 (protocol-design §1)
    if (!this.helloDone.has(ws)) {
      if (message.type !== 'hello') {
        ws.close(CLOSE_PROTOCOL_ERROR, 'hello first');
        return;
      }
      this.helloDone.add(ws);
      this.send(ws, {
        type: 'hello.response',
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: 'custom-harness-daemon', version: this.options.serverVersion },
        features: this.options.features ?? {},
      });
      return;
    }

    if (message.type === 'hello') {
      ws.close(CLOSE_PROTOCOL_ERROR, 'duplicate hello');
      return;
    }
    if (message.type === 'ping') {
      this.send(ws, { type: 'pong' });
      return;
    }
    if (message.type === 'pong') return;

    await this.dispatchRpc(ws, message);
  }

  /** 스키마 불일치 프레임 — requestId 를 건질 수 있으면 bad_request 응답, 아니면 드롭 */
  private rejectUnparsable(ws: WebSocket, json: unknown): void {
    if (typeof json === 'object' && json !== null) {
      const { type, requestId } = json as { type?: unknown; requestId?: unknown };
      if (typeof type === 'string' && type.endsWith('.request') && typeof requestId === 'string') {
        ws.send(
          JSON.stringify({
            type: type.replace(/\.request$/, '.response'),
            requestId,
            ok: false,
            error: { code: 'bad_request', message: '스키마 불일치 요청' },
          }),
        );
      }
    }
  }

  private async dispatchRpc(
    ws: WebSocket,
    message: Exclude<ClientMessage, { type: 'hello' | 'ping' | 'pong' }>,
  ): Promise<void> {
    const responseType = message.type.replace(/\.request$/, '.response');
    try {
      const result = await this.handle(message);
      ws.send(
        JSON.stringify({ type: responseType, requestId: message.requestId, ok: true, result }),
      );
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: responseType,
          requestId: message.requestId,
          ok: false,
          error: toRpcError(error),
        }),
      );
    }
  }

  private async handle(
    message: Exclude<ClientMessage, { type: 'hello' | 'ping' | 'pong' }>,
  ): Promise<unknown> {
    const { manager } = this.options;
    switch (message.type) {
      case 'session.create.request':
        return { session: await manager.createSession(message.params) };
      case 'session.resume.request':
        return { session: await manager.resumeSession(message.params.sessionId) };
      case 'session.list.request':
        return { sessions: await manager.listSessions() };
      case 'session.close.request':
        await manager.closeSession(message.params.sessionId);
        return {};
      case 'session.prompt.request':
        return await manager.prompt(message.params.sessionId, message.params.prompt);
      case 'session.interrupt.request':
        await manager.interrupt(message.params.sessionId);
        return {};
      case 'session.permission.respond.request':
        await manager.respondPermission(
          message.params.sessionId,
          message.params.requestId,
          message.params.outcome,
        );
        return {};
      case 'session.model.set.request':
        await manager.setModel(message.params.sessionId, message.params.modelId);
        return {};
      case 'session.timeline.request':
        return {
          events: await manager.timeline(message.params.sessionId, message.params.fromSeq),
        };
      case 'harness.list.request':
        return {
          harnesses: manager
            .listAdapters()
            .map((adapter) => ({ id: adapter.id, capabilities: adapter.capabilities })),
        };
      case 'harness.probe.request':
        return { probe: await manager.getAdapter(message.params.harness).probe() };
      case 'system.version.request':
        return { version: this.options.serverVersion, protocolVersion: PROTOCOL_VERSION };
      case 'system.shutdown.request':
        queueMicrotask(() => this.options.onShutdownRequest?.());
        return {};
      case 'config.key.set.request': {
        const { keyStore, gateway } = this.requireConfigServices();
        await keyStore.set(message.params.apiKey);
        // 키 저장 직후 주입 상태 동기화 — env 보간 방식이라 파일 재작성은 최초 1회뿐
        await gateway.ensurePiInjection();
        return {};
      }
      case 'config.key.test.request': {
        const { gateway } = this.requireConfigServices();
        return await gateway.testKey();
      }
      case 'config.get.request': {
        const { gateway, keyStore } = this.requireConfigServices();
        return {
          values: {
            gateway: (await gateway.getConfig()) ?? null,
            keyState: await keyStore.state(), // 키 값 자체는 절대 반환하지 않는다
          },
        };
      }
      case 'config.set.request': {
        const { gateway } = this.requireConfigServices();
        const partial = message.params.values.gateway;
        if (typeof partial !== 'object' || partial === null) {
          throw new DaemonError('bad_request', 'values.gateway 객체가 필요');
        }
        return { values: { gateway: await gateway.setConfig(partial) } };
      }
    }
  }

  private requireConfigServices(): { gateway: GatewayService; keyStore: KeyStore } {
    const { gateway, keyStore } = this.options;
    if (!gateway || !keyStore) {
      throw new DaemonError('unimplemented', 'config 도메인 서비스가 배선되지 않음');
    }
    return { gateway, keyStore };
  }
}
