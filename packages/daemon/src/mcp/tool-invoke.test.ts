// `tool.invoke` 배선 (WBS 7.2.4) — 데몬 안에서 관문이 실제로 도는지 본다.
//
// gate.ts 단위 테스트는 관문의 판단을 고정하고, 여기서는 **그 판단에 들어가는 값이 데몬에서
// 제대로 조달되는지**를 본다: 호출자 판정이 PID 원장을 실제로 읽는가, 승인 요청이 사용자
// 연결까지 나가는가, 툴 바인딩이 데몬 자신의 RPC 핸들러를 다시 타는가.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@custom-harness/protocol';
import { FakeAdapter } from '../adapters/testing.js';
import { ProcessSupervisor } from '../processes.js';
import { DaemonServer } from '../server.js';
import { SessionManager } from '../session-manager.js';
import { SessionStore } from '../store.js';
import type { AuditEntry } from './audit.js';

const TOKEN = 'test-token-0123456789abcdef';

interface Frame {
  type?: string;
  requestId?: string;
  ok?: boolean;
  result?: Record<string, unknown>;
  error?: { code: string };
  /** 세션 이벤트는 봉투 없이 평평하게 온다 — `type` 이 이벤트 종류 그 자체다 */
  request?: { requestId: string; origin?: string };
}

describe('tool.invoke 배선', () => {
  let server: DaemonServer;
  let ws: WebSocket;
  let frames: Frame[];
  let audited: AuditEntry[];
  let ledgerPath: string;
  let enabled: boolean;
  let maxDepth: number;
  let nextId = 0;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-toolrpc-'));
    ledgerPath = join(dir, 'processes.json');
    audited = [];
    enabled = true;
    maxDepth = 1;

    const manager = new SessionManager({
      store: new SessionStore(join(dir, 'sessions')),
      adapters: [new FakeAdapter()],
    });
    await manager.init();
    server = new DaemonServer({
      manager,
      token: TOKEN,
      serverVersion: '0.1.0',
      reverseTools: {
        audit: {
          async record(entry) {
            audited.push(entry);
          },
        },
        supervisor: new ProcessSupervisor({ ledgerPath }),
        isEnabled: () => enabled,
        maxSessionDepth: () => maxDepth,
      },
    });
    const { port } = await server.start();

    ws = new WebSocket(`ws://127.0.0.1:${port}`, [], {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    frames = [];
    ws.on('message', (data) => frames.push(JSON.parse(String(data)) as Frame));
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
    await waitFor(() => frames.some((f) => f.type === 'hello.response'));
  });

  afterEach(async () => {
    ws.close();
    await server.stop();
  });

  async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate()) return;
      if (Date.now() > deadline) throw new Error('조건이 만족되지 않았다');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** 요청을 보내고 그 requestId 의 응답 프레임을 기다린다 */
  async function rpc(type: string, params: Record<string, unknown> = {}): Promise<Frame> {
    const requestId = `r${++nextId}`;
    ws.send(JSON.stringify({ type, requestId, params }));
    await waitFor(() => frames.some((f) => f.requestId === requestId && f.ok !== undefined));
    return frames.find((f) => f.requestId === requestId && f.ok !== undefined)!;
  }

  /** 툴 결과의 JSON 페이로드 */
  function payloadOf(frame: Frame): Record<string, unknown> {
    const content = frame.result?.content as { text: string }[];
    return JSON.parse(content[0]!.text) as Record<string, unknown>;
  }

  function isError(frame: Frame): boolean {
    return frame.result?.isError === true;
  }

  /** pid → 세션 판정의 근거를 심는다 — 실제로는 데몬이 하네스를 spawn 할 때 적는다 */
  async function ledger(sessionId: string): Promise<void> {
    await writeFile(
      ledgerPath,
      JSON.stringify([
        { pid: process.pid, sessionId, harness: 'mock', spawnedAt: new Date().toISOString() },
      ]),
    );
  }

  async function createSession(): Promise<string> {
    const created = await rpc('session.create.request', {
      harness: 'mock',
      cwd: process.cwd(),
    });
    return (created.result?.session as { sessionId: string }).sessionId;
  }

  it('조회 툴은 데몬 자신의 RPC 를 타고 결과를 돌려준다', async () => {
    const sessionId = await createSession();
    const invoked = await rpc('tool.invoke.request', { name: 'session_list', args: {} });
    expect(invoked.ok).toBe(true);
    const sessions = payloadOf(invoked).sessions as { sessionId: string }[];
    expect(sessions.map((s) => s.sessionId)).toContain(sessionId);
    expect(audited.at(-1)).toMatchObject({ tool: 'session_list', outcome: 'ok' });
  });

  it('opt-in 이 꺼지면 그 즉시 막힌다 — 기동 시 값을 굳히지 않는다', async () => {
    enabled = false;
    const invoked = await rpc('tool.invoke.request', { name: 'session_list', args: {} });
    expect(isError(invoked)).toBe(true);
    expect(audited.at(-1)).toMatchObject({ outcome: 'blocked', reason: 'opt-in off' });
  });

  it('호출자 세션을 PID 원장으로 판정한다 — 감사에 그 세션이 남는다', async () => {
    const sessionId = await createSession();
    await ledger(sessionId);
    await rpc('tool.invoke.request', {
      name: 'session_list',
      args: {},
      callerPid: process.pid,
    });
    expect(audited.at(-1)).toMatchObject({ callerSessionId: sessionId, callerHarness: 'mock' });
  });

  it('write 툴은 승인 요청을 사용자 연결로 내보내고, 허용하면 실행된다', async () => {
    const sessionId = await createSession();
    await ledger(sessionId);

    // 승인을 기다리므로 응답을 먼저 붙잡지 않는다
    const requestId = `r${++nextId}`;
    ws.send(
      JSON.stringify({
        type: 'tool.invoke.request',
        requestId,
        params: { name: 'session_stop', args: { sessionId }, callerPid: process.pid },
      }),
    );

    await waitFor(() => frames.some((f) => f.type === 'permission_requested'));
    const request = frames.find((f) => f.type === 'permission_requested')!.request!;
    expect(request.origin).toBe('reverse_tool');

    await rpc('session.permission.respond.request', {
      sessionId,
      requestId: request.requestId,
      outcome: { optionId: 'allow' },
    });

    await waitFor(() => frames.some((f) => f.requestId === requestId && f.ok !== undefined));
    const invoked = frames.find((f) => f.requestId === requestId && f.ok !== undefined)!;
    expect(isError(invoked)).toBe(false);
    expect(audited.at(-1)).toMatchObject({ approval: 'granted', outcome: 'ok' });
  });

  it('거부하면 툴이 실패로 끝난다', async () => {
    const sessionId = await createSession();
    await ledger(sessionId);

    const requestId = `r${++nextId}`;
    ws.send(
      JSON.stringify({
        type: 'tool.invoke.request',
        requestId,
        params: { name: 'session_stop', args: { sessionId }, callerPid: process.pid },
      }),
    );
    await waitFor(() => frames.some((f) => f.type === 'permission_requested'));
    const request = frames.find((f) => f.type === 'permission_requested')!.request!;

    await rpc('session.permission.respond.request', {
      sessionId,
      requestId: request.requestId,
      outcome: { optionId: 'deny' },
    });
    await waitFor(() => frames.some((f) => f.requestId === requestId && f.ok !== undefined));
    const invoked = frames.find((f) => f.requestId === requestId && f.ok !== undefined)!;
    expect(isError(invoked)).toBe(true);
    expect(audited.at(-1)).toMatchObject({ approval: 'denied' });
  });

  it('재귀 상한은 승인보다 앞선다 — 못 할 일로 사용자를 깨우지 않는다', async () => {
    const sessionId = await createSession();
    await ledger(sessionId);
    maxDepth = 0;
    const invoked = await rpc('tool.invoke.request', {
      name: 'session_new',
      args: { harness: 'mock', cwd: process.cwd() },
      callerPid: process.pid,
    });
    expect(isError(invoked)).toBe(true);
    expect(frames.some((f) => f.type === 'permission_requested')).toBe(false);
  });

  it('배선이 없으면 unimplemented 다 — 조용히 성공하지 않는다', async () => {
    const bare = new DaemonServer({
      manager: await (async () => {
        const manager = new SessionManager({
          store: new SessionStore(await mkdtemp(join(tmpdir(), 'ch-bare-'))),
          adapters: [new FakeAdapter()],
        });
        await manager.init();
        return manager;
      })(),
      token: TOKEN,
      serverVersion: '0.1.0',
    });
    const { port } = await bare.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, [], {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const received: Frame[] = [];
    socket.on('message', (data) => received.push(JSON.parse(String(data)) as Frame));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'test', version: '0.0.0' },
        capabilities: {},
      }),
    );
    socket.send(
      JSON.stringify({
        type: 'tool.invoke.request',
        requestId: 'bare-1',
        params: { name: 'ws_list', args: {} },
      }),
    );
    await waitFor(() => received.some((f) => f.requestId === 'bare-1'));
    expect(received.find((f) => f.requestId === 'bare-1')?.error?.code).toBe('unimplemented');
    socket.close();
    await bare.stop();
  });
});
