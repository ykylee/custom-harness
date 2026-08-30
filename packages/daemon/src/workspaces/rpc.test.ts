// project.* / workspace.* RPC 배선 (WBS 5.2.3·5.3.5)
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, ServerMessageSchema } from '@custom-harness/protocol';
import { FakeAdapter } from '../adapters/testing.js';
import { resolvePaths, type DaemonPaths } from '../paths.js';
import { DaemonServer } from '../server.js';
import { SessionManager } from '../session-manager.js';
import { SessionStore } from '../store.js';
import { WorkspaceProvisioning } from './registry.js';

const TOKEN = 'test-token-0123456789abcdef';

interface RpcOk {
  type: string;
  requestId: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

describe('project/workspace RPC', () => {
  let server: DaemonServer;
  let provisioning: WorkspaceProvisioning;
  let paths: DaemonPaths;
  let ws: WebSocket;
  let counter = 0;
  const events: unknown[] = [];
  const inbox: RpcOk[] = [];
  const waiters: ((message: RpcOk) => void)[] = [];

  beforeEach(async () => {
    paths = resolvePaths(await mkdtemp(join(tmpdir(), 'ch-rpc-')));
    const store = new SessionStore(paths.sessionsDir);
    const manager = new SessionManager({ store, adapters: [new FakeAdapter()] });
    await manager.init();
    provisioning = new WorkspaceProvisioning(paths);
    server = new DaemonServer({ manager, token: TOKEN, serverVersion: '0.1.0', provisioning });
    const { port } = await server.start();

    ws = new WebSocket(`ws://127.0.0.1:${port}`, [], {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as RpcOk;
      if (message.type.endsWith('.response')) {
        const waiter = waiters.shift();
        if (waiter) waiter(message);
        else inbox.push(message);
        return;
      }
      if (message.type.endsWith('_changed')) events.push(message);
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
    await waitForResponse(); // hello.response
    events.length = 0;
  });

  afterEach(async () => {
    ws.close();
    await server.stop();
    inbox.length = 0;
    waiters.length = 0;
    events.length = 0;
  });

  function waitForResponse(): Promise<RpcOk> {
    const buffered = inbox.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve) => waiters.push(resolve));
  }

  async function rpc(type: string, params: Record<string, unknown> = {}): Promise<RpcOk> {
    counter += 1;
    const pending = waitForResponse();
    ws.send(JSON.stringify({ type, requestId: `r-${counter}`, params }));
    return pending;
  }

  it('project.open 은 프로젝트와 기본 워크스페이스를 함께 준다 (멱등)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-proj-'));
    const first = await rpc('project.open.request', { root: dir });
    expect(first.ok).toBe(true);
    expect(first.result?.project).toMatchObject({ kind: 'plain' });
    expect(first.result?.workspace).toMatchObject({ isolation: 'directory' });

    const second = await rpc('project.open.request', { root: dir });
    expect((second.result?.project as { id: string }).id).toBe(
      (first.result?.project as { id: string }).id,
    );
    expect(((await rpc('project.list.request')).result?.projects as unknown[]).length).toBe(1);
  });

  it('변경이 레지스트리 이벤트로 브로드캐스트된다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-proj-'));
    await rpc('project.open.request', { root: dir });
    // 프로젝트 생성 + 기본 워크스페이스 생성 2건
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual([
      expect.objectContaining({ type: 'project_changed', reason: 'created' }),
      expect.objectContaining({ type: 'workspace_changed', reason: 'created' }),
    ]);
    // 발행한 이벤트는 와이어 스키마를 통과해야 한다
    for (const event of events) expect(ServerMessageSchema.safeParse(event).success).toBe(true);
  });

  it('workspace.update 로 표시 이름·라벨을 바꾸고 이벤트를 낸다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-proj-'));
    const opened = await rpc('project.open.request', { root: dir });
    const workspaceId = (opened.result?.workspace as { id: string }).id;

    const updated = await rpc('workspace.update.request', {
      workspaceId,
      displayName: 'API 작업',
      labels: { team: 'platform' },
    });
    expect(updated.result?.workspace).toMatchObject({
      displayName: 'API 작업',
      labels: { team: 'platform' },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.at(-1)).toMatchObject({ type: 'workspace_changed', reason: 'updated' });
  });

  it('라벨 할당이 카탈로그에 남아 재사용 가능하다 (WBS 5.3.4)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-proj-'));
    const opened = await rpc('project.open.request', { root: dir });
    const workspaceId = (opened.result?.workspace as { id: string }).id;

    await rpc('workspace.update.request', { workspaceId, labels: { team: 'platform' } });
    const catalog = await rpc('workspace.labels.list.request');
    expect(catalog.result?.labels).toEqual([
      expect.objectContaining({ id: 'team=platform', key: 'team', value: 'platform' }),
    ]);

    // 같은 라벨 재할당은 중복을 만들지 않는다 (멱등)
    await rpc('workspace.update.request', { workspaceId, labels: { team: 'platform' } });
    expect(((await rpc('workspace.labels.list.request')).result?.labels as unknown[]).length).toBe(
      1,
    );
  });

  it('없는 대상은 not_found 로 구분된다', async () => {
    const response = await rpc('project.update.request', {
      projectId: 'prj_없음',
      displayName: 'x',
    });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('not_found');
  });

  it('빈 변경 요청은 bad_request 다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-proj-'));
    const opened = await rpc('project.open.request', { root: dir });
    const workspaceId = (opened.result?.workspace as { id: string }).id;
    const response = await rpc('workspace.update.request', { workspaceId });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('bad_request');
  });

  it('미구현 경로(worktree 생성·setup 실행)는 unimplemented 로 명시 거절한다', async () => {
    const worktree = await rpc('workspace.create.request', {
      projectId: 'prj_x',
      isolation: 'worktree',
    });
    expect(worktree.error?.code).toBe('unimplemented');
    const setup = await rpc('workspace.setup.run.request', { workspaceId: 'wsp_x' });
    expect(setup.error?.code).toBe('unimplemented');
  });

  it('아카이브는 소프트 삭제이고, 관리 밖 체크아웃은 제거하지 않는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-proj-'));
    const opened = await rpc('project.open.request', { root: dir });
    const workspaceId = (opened.result?.workspace as { id: string }).id;

    // removeCheckout 요청이라도 사용자가 고른 디렉토리는 지우지 않는다
    const refused = await rpc('workspace.archive.request', { workspaceId, removeCheckout: true });
    expect(refused.ok).toBe(false);
    expect(refused.error?.message).toContain('관리 밖');
    expect((await stat(dir)).isDirectory()).toBe(true);

    const listed = await rpc('workspace.list.request', {});
    expect(listed.result?.workspaces).toEqual([]); // 레코드는 이미 아카이브됨
    const withArchived = await rpc('workspace.list.request', { includeArchived: true });
    expect((withArchived.result?.workspaces as unknown[]).length).toBe(1);
  });

  it('provisioning 미배선이면 unimplemented 를 돌려준다', async () => {
    const store = new SessionStore(paths.sessionsDir);
    const manager = new SessionManager({ store, adapters: [new FakeAdapter()] });
    await manager.init();
    const bare = new DaemonServer({ manager, token: TOKEN, serverVersion: '0.1.0' });
    const { port } = await bare.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, [], {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const first = new Promise<RpcOk>((resolve) =>
      socket.on('message', (data) => resolve(JSON.parse(String(data)) as RpcOk)),
    );
    await new Promise<void>((resolve) => socket.once('open', resolve));
    socket.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'test', version: '0.0.0' },
        capabilities: {},
      }),
    );
    await first;
    const response = await new Promise<RpcOk>((resolve) => {
      socket.once('message', (data) => resolve(JSON.parse(String(data)) as RpcOk));
      socket.send(JSON.stringify({ type: 'project.list.request', requestId: 'r-1', params: {} }));
    });
    expect(response.error?.code).toBe('unimplemented');
    socket.close();
    await bare.stop();
  });
});
