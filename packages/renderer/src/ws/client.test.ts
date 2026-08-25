import { WebSocket as NodeWebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@custom-harness/protocol';
import { DaemonClient, type DaemonClientOptions } from './client.js';

const TOKEN = 'renderer-test-token';

/** 데몬 프로토콜을 흉내내는 스텁 서버 — hello.response, system.version, ping/pong */
function startStubServer(port = 0): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port,
      handleProtocols: (protocols) => (protocols.has(TOKEN) ? TOKEN : false),
    });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const message = JSON.parse(String(data)) as Record<string, unknown>;
        if (message.type === 'hello') {
          ws.send(
            JSON.stringify({
              type: 'hello.response',
              protocolVersion: PROTOCOL_VERSION,
              serverInfo: { name: 'stub', version: '0.0.0' },
              features: { streaming: true },
            }),
          );
          return;
        }
        if (message.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        if (message.type === 'system.version.request') {
          ws.send(
            JSON.stringify({
              type: 'system.version.response',
              requestId: message.requestId,
              ok: true,
              result: { version: '0.0.0', protocolVersion: PROTOCOL_VERSION },
            }),
          );
          return;
        }
        if (message.type === 'session.prompt.request') {
          ws.send(
            JSON.stringify({
              type: 'session.prompt.response',
              requestId: message.requestId,
              ok: false,
              error: { code: 'busy', message: '활성 턴 존재' },
            }),
          );
        }
      });
    });
    wss.on('listening', () => {
      resolve({ wss, port: (wss.address() as AddressInfo).port });
    });
  });
}

const nodeWsFactory = ((url: string, protocols: string[]) =>
  new NodeWebSocket(url, protocols)) as unknown as NonNullable<
  DaemonClientOptions['webSocketFactory']
>;

function makeClient(port: number): DaemonClient {
  return new DaemonClient({
    url: `ws://127.0.0.1:${port}`,
    token: TOKEN,
    backoffBaseMs: 20,
    backoffMaxMs: 100,
    webSocketFactory: nodeWsFactory,
  });
}

describe('DaemonClient (WBS 1.5.1)', () => {
  const clients: DaemonClient[] = [];
  const servers: WebSocketServer[] = [];

  afterEach(async () => {
    for (const client of clients) client.stop();
    clients.length = 0;
    await Promise.all(
      servers.splice(0).map((wss) => new Promise((resolve) => wss.close(() => resolve(null)))),
    );
  });

  async function connected(port: number): Promise<DaemonClient> {
    const client = makeClient(port);
    clients.push(client);
    client.start();
    await vi.waitFor(() => {
      expect(client.getState()).toBe('connected');
    });
    return client;
  }

  it('connects with the token subprotocol and completes hello', async () => {
    const { wss, port } = await startStubServer();
    servers.push(wss);
    const client = await connected(port);
    expect(client.getFeatures()).toEqual({ streaming: true });
  });

  it('resolves RPC results and projects error responses as RpcFailure', async () => {
    const { wss, port } = await startStubServer();
    servers.push(wss);
    const client = await connected(port);
    await expect(client.rpc('system.version')).resolves.toMatchObject({ version: '0.0.0' });
    await expect(
      client.rpc('session.prompt', { sessionId: 's', prompt: 'x' }),
    ).rejects.toMatchObject({ code: 'busy' });
  });

  it('rejects RPC while disconnected', async () => {
    const client = makeClient(1); // 연결 안 함
    clients.push(client);
    await expect(client.rpc('system.version')).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('delivers session events to subscribers', async () => {
    const { wss, port } = await startStubServer();
    servers.push(wss);
    const client = await connected(port);
    const events: unknown[] = [];
    client.onEvent((event) => events.push(event));
    for (const ws of wss.clients) {
      ws.send(JSON.stringify({ type: 'message_delta', delta: 'hi', sessionId: 's-1', seq: 0 }));
      ws.send('not-json'); // 관대 파싱 — 무시돼야 함
      ws.send(JSON.stringify({ type: 'totally_unknown_frame' }));
    }
    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });
    expect(events[0]).toMatchObject({ type: 'message_delta', delta: 'hi' });
  });

  it('reconnects with backoff and fires the resync hook (protocol-design §5)', async () => {
    const first = await startStubServer();
    servers.push(first.wss);
    const client = await connected(first.port);
    const reconnected = vi.fn();
    client.onReconnected(reconnected);

    // 서버 강제 종료 → 재연결 대기 상태로 (연결 종료가 close 콜백보다 선행해야 함)
    for (const ws of first.wss.clients) ws.terminate();
    await new Promise((resolve) => first.wss.close(() => resolve(null)));
    await vi.waitFor(() => {
      expect(client.getState()).toBe('reconnecting');
    });

    // 같은 포트로 서버 재기동 → 자동 재연결 + 재동기화 훅
    const second = await startStubServer(first.port);
    servers.push(second.wss);
    await vi.waitFor(
      () => {
        expect(client.getState()).toBe('connected');
      },
      { timeout: 3000 },
    );
    await vi.waitFor(() => {
      expect(reconnected).toHaveBeenCalled();
    });
  });
});
