// 터미널 e2e (WBS 6.3) — WS 를 통한 실제 왕복. 바이너리 채널·슬롯·재접속까지.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  TERMINAL_OPCODE,
  decodeTerminalFrame,
  encodeTerminalFrame,
} from '@custom-harness/protocol';
import { FakeAdapter } from './adapters/testing.js';
import { startDaemon, type DaemonHandle } from './index.js';

interface Rpc {
  type: string;
  ok?: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

describe('터미널 e2e', () => {
  let daemon: DaemonHandle;
  let ws: WebSocket;
  let counter = 0;
  const jsonInbox: Rpc[] = [];
  const jsonWaiters: ((message: Rpc) => void)[] = [];
  let binary: Uint8Array[] = [];

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'ch-te2e-'));
    daemon = await startDaemon({ root, version: '0.1.0', adapters: () => [new FakeAdapter()] });
    ws = new WebSocket(`ws://127.0.0.1:${daemon.port}`, [], {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    ws.binaryType = 'arraybuffer';
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        binary.push(new Uint8Array(data as Buffer));
        return;
      }
      const message = JSON.parse(String(data)) as Rpc;
      if (!message.type.endsWith('.response')) return;
      const waiter = jsonWaiters.shift();
      if (waiter) waiter(message);
      else jsonInbox.push(message);
    });
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
    await next();
  });

  afterEach(async () => {
    ws.close();
    await daemon.stop();
    jsonInbox.length = 0;
    jsonWaiters.length = 0;
    binary = [];
  });

  function next(): Promise<Rpc> {
    const buffered = jsonInbox.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve) => jsonWaiters.push(resolve));
  }

  async function rpc(type: string, params: Record<string, unknown> = {}): Promise<Rpc> {
    counter += 1;
    const pending = next();
    ws.send(JSON.stringify({ type, requestId: `r-${counter}`, params }));
    return pending;
  }

  /** 바이너리 출력에서 기대 문자열이 나올 때까지 (슬롯 필터 포함) */
  async function awaitOutput(slot: number, needle: string, timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let seen = '';
    while (Date.now() < deadline) {
      for (const frame of binary.splice(0)) {
        const decoded = decodeTerminalFrame(frame);
        if (decoded?.opcode === TERMINAL_OPCODE.output && decoded.slot === slot) {
          seen += Buffer.from(decoded.payload).toString('utf8');
        }
      }
      if (seen.includes(needle)) return seen;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`타임아웃 — 관측: ${seen.slice(-200)}`);
  }

  async function openWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ch-tews-'));
    const opened = await rpc('project.open.request', { root: dir });
    return (opened.result?.workspace as { id: string }).id;
  }

  it('워크스페이스 터미널을 만들고 입력·출력이 바이너리로 오간다', async () => {
    const workspaceId = await openWorkspace();
    const created = await rpc('terminal.create.request', { workspaceId, cols: 80, rows: 24 });
    const terminalId = (created.result?.terminal as { id: string }).id;

    const attached = await rpc('terminal.attach.request', { terminalId, cols: 80, rows: 24 });
    const slot = attached.result?.slot as number;
    expect(typeof slot).toBe('number');

    ws.send(
      encodeTerminalFrame({
        opcode: TERMINAL_OPCODE.input,
        slot,
        // 마커를 셸에서 이어붙인다 — 그러지 않으면 되울린 명령줄만으로 검사가 통과한다
        payload: new TextEncoder().encode('echo "E2E""_OK"\n'),
      }),
      { binary: true },
    );
    expect(await awaitOutput(slot, 'E2E_OK')).toContain('E2E_OK');
  });

  it('재접속하면 스크롤백부터 이어 받는다', async () => {
    const workspaceId = await openWorkspace();
    const created = await rpc('terminal.create.request', { workspaceId, cols: 80, rows: 24 });
    const terminalId = (created.result?.terminal as { id: string }).id;

    const first = await rpc('terminal.attach.request', { terminalId, cols: 80, rows: 24 });
    const slot = first.result?.slot as number;
    ws.send(
      encodeTerminalFrame({
        opcode: TERMINAL_OPCODE.input,
        slot,
        payload: new TextEncoder().encode('echo "BEFORE""_DETACH"\n'),
      }),
      { binary: true },
    );
    await awaitOutput(slot, 'BEFORE_DETACH');
    await rpc('terminal.detach.request', { terminalId });

    // 다시 붙으면 이전 출력이 스크롤백으로 온다 — 데몬이 pty 를 계속 소유했다는 증거
    const second = await rpc('terminal.attach.request', { terminalId, cols: 80, rows: 24 });
    const scrollback = Buffer.from(second.result?.scrollback as string, 'base64').toString('utf8');
    expect(scrollback).toContain('BEFORE_DETACH');
    expect(second.result?.truncated).toBe(false);
  });

  it('detach 후에는 그 슬롯으로 온 입력을 버린다', async () => {
    const workspaceId = await openWorkspace();
    const created = await rpc('terminal.create.request', { workspaceId, cols: 80, rows: 24 });
    const terminalId = (created.result?.terminal as { id: string }).id;
    const attached = await rpc('terminal.attach.request', { terminalId, cols: 80, rows: 24 });
    const slot = attached.result?.slot as number;
    await rpc('terminal.detach.request', { terminalId });

    binary = [];
    ws.send(
      encodeTerminalFrame({
        opcode: TERMINAL_OPCODE.input,
        slot,
        payload: new TextEncoder().encode('echo SHOULD_NOT_ARRIVE\n'),
      }),
      { binary: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(binary).toHaveLength(0);
  });

  it('없는 워크스페이스·터미널은 not_found 다', async () => {
    const created = await rpc('terminal.create.request', {
      workspaceId: 'wsp_none',
      cols: 80,
      rows: 24,
    });
    expect(created.error?.code).toBe('not_found');
    const attached = await rpc('terminal.attach.request', {
      terminalId: 'trm_none',
      cols: 80,
      rows: 24,
    });
    expect(attached.error?.code).toBe('not_found');
  });

  it('kill 하면 목록에 종료 시각이 남는다', async () => {
    const workspaceId = await openWorkspace();
    const created = await rpc('terminal.create.request', { workspaceId, cols: 80, rows: 24 });
    const terminalId = (created.result?.terminal as { id: string }).id;

    await rpc('terminal.kill.request', { terminalId });
    const listed = await rpc('terminal.list.request', { workspaceId });
    const terminals = listed.result?.terminals as { id: string; exitedAt?: string }[];
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.exitedAt).toBeDefined();
  });

  it('데몬이 터미널 기능을 features 로 광고한다 (폴백 경로 금지)', async () => {
    // hello.response 는 beforeEach 에서 소비했으므로 새 연결로 확인한다
    const probe = new WebSocket(`ws://127.0.0.1:${daemon.port}`, [], {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    const hello = new Promise<Record<string, unknown>>((resolve) => {
      probe.on('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    await new Promise<void>((resolve) => probe.once('open', resolve));
    probe.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'probe', version: '0.0.0' },
        capabilities: {},
      }),
    );
    const response = await hello;
    expect((response.features as Record<string, boolean>).terminalBinaryFrames).toBe(true);
    probe.close();
  });
});

describe('터미널 부하·복원 (WBS 6.7.1)', () => {
  let daemon: DaemonHandle;
  let ws: WebSocket;
  const inbox: Rpc[] = [];
  const waiters: ((message: Rpc) => void)[] = [];
  let frames: Uint8Array[] = [];
  let counter = 0;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'ch-tload-'));
    daemon = await startDaemon({ root, version: '0.1.0', adapters: () => [new FakeAdapter()] });
    ws = new WebSocket(`ws://127.0.0.1:${daemon.port}`, [], {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    ws.binaryType = 'arraybuffer';
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        frames.push(new Uint8Array(data as Buffer));
        return;
      }
      const message = JSON.parse(String(data)) as Rpc;
      if (!message.type.endsWith('.response')) return;
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else inbox.push(message);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'load', version: '0.0.0' },
        capabilities: {},
      }),
    );
    await nextResponse();
  });

  afterEach(async () => {
    ws.close();
    await daemon.stop();
    inbox.length = 0;
    waiters.length = 0;
    frames = [];
  });

  function nextResponse(): Promise<Rpc> {
    const buffered = inbox.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve) => waiters.push(resolve));
  }

  async function call(type: string, params: Record<string, unknown> = {}): Promise<Rpc> {
    counter += 1;
    const pending = nextResponse();
    ws.send(JSON.stringify({ type, requestId: `L-${counter}`, params }));
    return pending;
  }

  function collect(slot: number): string {
    let out = '';
    for (const frame of frames) {
      const decoded = decodeTerminalFrame(frame);
      if (decoded?.opcode === TERMINAL_OPCODE.output && decoded.slot === slot) {
        out += Buffer.from(decoded.payload).toString('utf8');
      }
    }
    return out;
  }

  it('대용량 출력을 흘려도 프레임이 유실되지 않는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-tload-ws-'));
    const opened = await call('project.open.request', { root: dir });
    const workspaceId = (opened.result?.workspace as { id: string }).id;
    const created = await call('terminal.create.request', { workspaceId, cols: 200, rows: 50 });
    const terminalId = (created.result?.terminal as { id: string }).id;
    const attached = await call('terminal.attach.request', { terminalId, cols: 200, rows: 50 });
    const slot = attached.result?.slot as number;

    // 10000줄 × ~60B ≈ 600KiB — 링 버퍼(256KiB)를 확실히 넘긴다
    ws.send(
      encodeTerminalFrame({
        opcode: TERMINAL_OPCODE.input,
        slot,
        payload: new TextEncoder().encode(
          'for i in $(seq 1 10000); do echo "line-$i-padding-padding-padding-padding-padding"; done; echo "LOAD""_DONE"\n',
        ),
      }),
      { binary: true },
    );
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !collect(slot).includes('LOAD_DONE')) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const output = collect(slot);
    expect(output).toContain('LOAD_DONE');
    expect(output).toContain('line-10000-');
    // 스트림은 전부 흘렀지만 스크롤백은 상한을 지킨다
    const reattached = await call('terminal.attach.request', { terminalId, cols: 200, rows: 50 });
    const scrollback = Buffer.from(reattached.result?.scrollback as string, 'base64');
    expect(scrollback.length).toBeLessThanOrEqual(256 * 1024);
    expect(reattached.result?.truncated).toBe(true);
  }, 60_000);

  it('여러 터미널이 서로 다른 슬롯으로 섞이지 않는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-tload-ws-'));
    const opened = await call('project.open.request', { root: dir });
    const workspaceId = (opened.result?.workspace as { id: string }).id;

    const slots: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await call('terminal.create.request', { workspaceId, cols: 80, rows: 24 });
      const terminalId = (created.result?.terminal as { id: string }).id;
      const attached = await call('terminal.attach.request', { terminalId, cols: 80, rows: 24 });
      const slot = attached.result?.slot as number;
      slots.push(slot);
      ws.send(
        encodeTerminalFrame({
          opcode: TERMINAL_OPCODE.input,
          slot,
          payload: new TextEncoder().encode(`echo "SLOT""_MARK_${index}"\n`),
        }),
        { binary: true },
      );
    }
    expect(new Set(slots).size).toBe(3); // 슬롯이 겹치지 않는다

    const deadline = Date.now() + 20_000;
    while (
      Date.now() < deadline &&
      !slots.every((slot, i) => collect(slot).includes(`SLOT_MARK_${i}`))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // 각 슬롯은 자기 터미널의 출력만 본다
    slots.forEach((slot, index) => {
      const output = collect(slot);
      expect(output).toContain(`SLOT_MARK_${index}`);
      for (const other of [0, 1, 2].filter((n) => n !== index)) {
        expect(output).not.toContain(`SLOT_MARK_${other}\r\n`);
      }
    });
  }, 40_000);
});
