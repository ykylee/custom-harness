import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@custom-harness/protocol';
import { FakeAdapter } from './adapters/testing.js';
import { DaemonServer } from './server.js';
import { SessionManager } from './session-manager.js';
import { SessionStore } from './store.js';

const TOKEN = 'test-token-0123456789abcdef';

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(JSON.parse(String(data))));
    ws.once('close', (code) => reject(new Error(`closed: ${code}`)));
    ws.once('error', reject);
  });
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

async function hello(ws: WebSocket): Promise<unknown> {
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(
    JSON.stringify({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'test', version: '0.0.0' },
      capabilities: {},
    }),
  );
  return nextMessage(ws);
}

describe('DaemonServer', () => {
  let server: DaemonServer;
  let adapter: FakeAdapter;
  let port: number;
  let sockets: WebSocket[];

  beforeEach(async () => {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'ch-srv-')));
    adapter = new FakeAdapter();
    const manager = new SessionManager({ store, adapters: [adapter] });
    await manager.init();
    server = new DaemonServer({ manager, token: TOKEN, serverVersion: '0.1.0' });
    ({ port } = await server.start());
    sockets = [];
  });

  afterEach(async () => {
    for (const ws of sockets) ws.close();
    await server.stop();
  });

  function connect(options?: { bearer?: boolean; subprotocol?: boolean }): WebSocket {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}`,
      options?.subprotocol ? [TOKEN] : [],
      options?.bearer === false ? {} : { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    sockets.push(ws);
    return ws;
  }

  it('closes an unauthenticated connection immediately (NFR-3)', async () => {
    const ws = connect({ bearer: false });
    expect(await closed(ws)).toBe(4401);
  });

  it('accepts the Sec-WebSocket-Protocol token path (브라우저 경로)', async () => {
    const ws = connect({ bearer: false, subprotocol: true });
    const response = await hello(ws);
    expect(response).toMatchObject({ type: 'hello.response' });
  });

  it('requires hello before RPC', async () => {
    const ws = connect();
    await new Promise<void>((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ type: 'system.version.request', requestId: 'r-0', params: {} }));
    expect(await closed(ws)).toBe(4400);
  });

  it('answers hello then serves system.version', async () => {
    const ws = connect();
    const helloResponse = await hello(ws);
    expect(helloResponse).toMatchObject({
      type: 'hello.response',
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: { name: 'custom-harness-daemon', version: '0.1.0' },
    });

    ws.send(JSON.stringify({ type: 'system.version.request', requestId: 'r-1', params: {} }));
    expect(await nextMessage(ws)).toEqual({
      type: 'system.version.response',
      requestId: 'r-1',
      ok: true,
      result: { version: '0.1.0', protocolVersion: PROTOCOL_VERSION },
    });
  });

  it('responds pong to ping (protocol-design §5)', async () => {
    const ws = connect();
    await hello(ws);
    ws.send(JSON.stringify({ type: 'ping' }));
    expect(await nextMessage(ws)).toEqual({ type: 'pong' });
  });

  it('creates a session over RPC and broadcasts its wire events', async () => {
    const ws = connect();
    await hello(ws);
    const received: unknown[] = [];
    ws.on('message', (data) => received.push(JSON.parse(String(data))));

    // 브로드캐스트 이벤트가 RPC 응답보다 먼저 도착할 수 있다 — requestId 로 선별
    const responsePromise = new Promise<{
      ok: boolean;
      result: { session: { sessionId: string; status: string } };
    }>((resolve) => {
      ws.on('message', (data) => {
        const message = JSON.parse(String(data)) as { requestId?: string };
        if (message.requestId === 'r-2') resolve(message as never);
      });
    });
    ws.send(
      JSON.stringify({
        type: 'session.create.request',
        requestId: 'r-2',
        params: { harness: 'mock', cwd: process.cwd() },
      }),
    );
    const response = await responsePromise;
    expect(response.ok).toBe(true);
    expect(response.result.session.status).toBe('idle');

    // 브로드캐스트 — initializing/idle 전이 이벤트 수신
    await new Promise((resolve) => setTimeout(resolve, 30));
    const statuses = received
      .filter(
        (m): m is { type: string; status: string } =>
          (m as { type?: string }).type === 'session_status_changed',
      )
      .map((m) => m.status);
    expect(statuses).toContain('idle');
  });

  it('routes session.attention.ack and is idempotent (M7 7.1.2)', async () => {
    const ws = connect();
    await hello(ws);
    const ask = <T>(requestId: string, type: string, params: unknown): Promise<T> => {
      const done = new Promise<T>((resolve) => {
        ws.on('message', (data) => {
          const message = JSON.parse(String(data)) as { requestId?: string };
          if (message.requestId === requestId) resolve(message as T);
        });
      });
      ws.send(JSON.stringify({ type, requestId, params }));
      return done;
    };
    const created = await ask<{ result: { session: { sessionId: string } } }>(
      'a-1',
      'session.create.request',
      { harness: 'mock', cwd: process.cwd() },
    );
    const { sessionId } = created.result.session;
    for (const requestId of ['a-2', 'a-3']) {
      const acked = await ask<{ ok: boolean }>(requestId, 'session.attention.ack.request', {
        sessionId,
      });
      expect(acked.ok).toBe(true);
    }
  });

  it('projects DaemonError onto the RPC error shape', async () => {
    const ws = connect();
    await hello(ws);
    ws.send(
      JSON.stringify({
        type: 'session.prompt.request',
        requestId: 'r-3',
        params: { sessionId: 'nope', prompt: 'x' },
      }),
    );
    expect(await nextMessage(ws)).toMatchObject({
      type: 'session.prompt.response',
      requestId: 'r-3',
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('rejects unimplemented config domain (WBS 1.4.3 예정)', async () => {
    const ws = connect();
    await hello(ws);
    ws.send(JSON.stringify({ type: 'config.get.request', requestId: 'r-4', params: {} }));
    expect(await nextMessage(ws)).toMatchObject({
      ok: false,
      error: { code: 'unimplemented' },
    });
  });

  it('answers a schema-mismatch request with bad_request instead of dropping', async () => {
    const ws = connect();
    await hello(ws);
    ws.send(
      JSON.stringify({ type: 'session.prompt.request', requestId: 'r-5', params: { bogus: 1 } }),
    );
    expect(await nextMessage(ws)).toMatchObject({
      type: 'session.prompt.response',
      requestId: 'r-5',
      ok: false,
      error: { code: 'bad_request' },
    });
  });
});

describe('DaemonServer config domain (WBS 1.4.3)', () => {
  it('routes config.get/key.set through the gateway services', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { resolvePaths } = await import('./paths.js');
    const { KeyStore } = await import('./gateway/key-store.js');
    const { GatewayService } = await import('./gateway/service.js');

    const paths = resolvePaths(await mkdtemp(join(tmpdir(), 'ch-srvgw-')));
    const keyStore = new KeyStore(paths.credentialsFile);
    const gateway = new GatewayService(paths, keyStore);
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'ch-srvgw-s-')));
    const manager = new SessionManager({ store, adapters: [] });
    await manager.init();
    const server = new DaemonServer({
      manager,
      token: TOKEN,
      serverVersion: '0.1.0',
      gateway,
      keyStore,
    });
    const { port } = await server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, [], {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    try {
      await hello(ws);
      ws.send(
        JSON.stringify({
          type: 'config.key.set.request',
          requestId: 'c-1',
          params: { apiKey: 'sk-abc' },
        }),
      );
      expect(await nextMessage(ws)).toMatchObject({ requestId: 'c-1', ok: true });

      ws.send(JSON.stringify({ type: 'config.get.request', requestId: 'c-2', params: {} }));
      expect(await nextMessage(ws)).toMatchObject({
        requestId: 'c-2',
        ok: true,
        // 키 값은 응답에 실리지 않는다 — 상태만. maxSessions 기본 8 (WBS 2.3.1)
        result: {
          values: { gateway: null, keyState: { present: true, fallback: true }, maxSessions: 8 },
        },
      });

      // maxSessions 설정 — 영속 + 매니저 즉시 반영 (WBS 2.3.1)
      ws.send(
        JSON.stringify({
          type: 'config.set.request',
          requestId: 'c-3',
          params: { values: { maxSessions: 5 } },
        }),
      );
      expect(await nextMessage(ws)).toMatchObject({
        requestId: 'c-3',
        ok: true,
        result: { values: { maxSessions: 5 } },
      });
      expect(manager.getMaxSessions()).toBe(5);

      ws.send(
        JSON.stringify({
          type: 'config.set.request',
          requestId: 'c-4',
          params: { values: { maxSessions: 0 } },
        }),
      );
      expect(await nextMessage(ws)).toMatchObject({
        requestId: 'c-4',
        ok: false,
        error: { code: 'bad_request' },
      });

      // harness.list — gateway 배선 시 모델 카탈로그 동봉 (FR-2.4). 미온보딩이면 빈 목록
      ws.send(JSON.stringify({ type: 'harness.list.request', requestId: 'c-5', params: {} }));
      expect(await nextMessage(ws)).toMatchObject({ requestId: 'c-5', ok: true });
    } finally {
      ws.close();
      await server.stop();
    }
  });
});

// ── 앱 정보 · 라이선스 고지 (WBS 3.3.2, FR-4.5) ────────────────────────────
describe('system.about / system.license.read', () => {
  it('번들 신원·고지 색인을 주고, licenses/ 밖은 거절한다', async () => {
    const bundleRoot = await mkdtemp(join(tmpdir(), 'ch-about-'));
    const licensesDir = join(bundleRoot, 'licenses');
    await mkdir(join(licensesDir, 'pi'), { recursive: true });
    await writeFile(join(licensesDir, 'NOTICE.md'), '# NOTICE\n');
    await writeFile(
      join(licensesDir, 'notices.json'),
      JSON.stringify({
        components: [{ name: 'pi', version: '0.84.1', license: 'MIT', paths: ['pi/LICENSE'] }],
      }),
    );
    await writeFile(join(licensesDir, 'pi', 'LICENSE'), 'MIT License — pi\n');
    await writeFile(join(bundleRoot, 'manifest.json'), '{}'); // 봉쇄 밖의 이웃 파일

    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'ch-srv-about-')));
    const manager = new SessionManager({ store, adapters: [new FakeAdapter()] });
    await manager.init();
    const server = new DaemonServer({
      manager,
      token: TOKEN,
      serverVersion: '0.1.0',
      about: {
        bundle: { root: bundleRoot, version: '0.1.0', os: 'darwin', arch: 'arm64' },
        licensesDir,
      },
    });
    const { port } = await server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, [], {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    try {
      await hello(ws);

      ws.send(JSON.stringify({ type: 'system.about.request', requestId: 'a-1', params: {} }));
      expect(await nextMessage(ws)).toMatchObject({
        requestId: 'a-1',
        ok: true,
        result: {
          version: '0.1.0',
          protocolVersion: PROTOCOL_VERSION,
          bundle: { root: bundleRoot, version: '0.1.0', os: 'darwin' },
          licenses: {
            available: true,
            notice: '# NOTICE\n',
            components: [{ name: 'pi', version: '0.84.1', paths: ['pi/LICENSE'] }],
          },
        },
      });

      ws.send(
        JSON.stringify({
          type: 'system.license.read.request',
          requestId: 'a-2',
          params: { path: 'pi/LICENSE' },
        }),
      );
      expect(await nextMessage(ws)).toMatchObject({
        requestId: 'a-2',
        ok: true,
        result: { text: 'MIT License — pi\n', eof: true },
      });

      // 봉쇄 — 번들 안이라도 licenses/ 밖은 이 창구로 읽히지 않는다
      ws.send(
        JSON.stringify({
          type: 'system.license.read.request',
          requestId: 'a-3',
          params: { path: '../manifest.json' },
        }),
      );
      expect(await nextMessage(ws)).toMatchObject({
        requestId: 'a-3',
        ok: false,
        error: { code: 'bad_request' },
      });
    } finally {
      ws.close();
      await server.stop();
    }
  });

  it('번들이 아닌 실행에서는 고지 없음으로 응답한다 — 화면이 깨지지 않는다', async () => {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'ch-srv-dev-')));
    const manager = new SessionManager({ store, adapters: [new FakeAdapter()] });
    await manager.init();
    const server = new DaemonServer({ manager, token: TOKEN, serverVersion: '0.1.0' });
    const { port } = await server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, [], {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    try {
      await hello(ws);
      ws.send(JSON.stringify({ type: 'system.about.request', requestId: 'd-1', params: {} }));
      expect(await nextMessage(ws)).toMatchObject({
        requestId: 'd-1',
        ok: true,
        result: { licenses: { available: false, components: [], files: [] } },
      });
      ws.send(
        JSON.stringify({
          type: 'system.license.read.request',
          requestId: 'd-2',
          params: { path: 'pi/LICENSE' },
        }),
      );
      expect(await nextMessage(ws)).toMatchObject({ requestId: 'd-2', ok: false });
    } finally {
      ws.close();
      await server.stop();
    }
  });
});
