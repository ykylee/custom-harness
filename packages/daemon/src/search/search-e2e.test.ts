// 타임라인 전문 검색 배선 검증 (M7 WBS 7.4.1, FR-9.4) — 데몬 조립부터 RPC 응답까지.
//
// 단위 테스트가 각 층을 따로 확인해도, 이벤트 구독을 안 걸거나 서버에 색인을 안 넘기면
// 화면에서는 아무것도 안 잡힌다. 그 연결을 여기서만 확인할 수 있다.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type SearchHit } from '@custom-harness/protocol';
import { MockAdapter } from '../adapters/mock.js';
import { startDaemon } from '../index.js';

type Daemon = Awaited<ReturnType<typeof startDaemon>>;

const boot = async (root: string): Promise<Daemon> =>
  startDaemon({ root, version: '0.1.0', managedBy: 'test', adapters: [new MockAdapter()] });

class RpcClient {
  private constructor(private readonly ws: WebSocket) {}

  static async connect(daemon: Daemon): Promise<RpcClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const client = new RpcClient(ws);
    await client.send('hello', {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'test', version: '0.0.0' },
      capabilities: {},
    });
    return client;
  }

  /** 요청 하나를 보내고 그 requestId 의 응답만 골라 온다 (이벤트가 섞여 온다) */
  async call<T>(method: string, params: unknown): Promise<T> {
    const requestId = Math.random().toString(36).slice(2);
    const response = await this.send(`${method}.request`, { requestId, params }, (message) => {
      const frame = message as { type?: string; requestId?: string };
      return frame.type === `${method}.response` && frame.requestId === requestId;
    });
    const frame = response as { ok: boolean; result?: T; error?: { message: string } };
    if (!frame.ok) throw new Error(frame.error?.message ?? 'rpc 실패');
    return frame.result as T;
  }

  private async send(
    type: string,
    body: Record<string, unknown>,
    match: (message: unknown) => boolean = (message) =>
      (message as { type?: string }).type === 'hello.response',
  ): Promise<unknown> {
    return new Promise<unknown>((resolve) => {
      const onMessage = (data: unknown): void => {
        const message: unknown = JSON.parse(String(data));
        if (!match(message)) return;
        this.ws.off('message', onMessage);
        resolve(message);
      };
      this.ws.on('message', onMessage);
      this.ws.send(JSON.stringify({ type, ...body }));
    });
  }

  close(): void {
    this.ws.close();
  }
}

describe('session.search (e2e)', () => {
  const cleanup: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const task of cleanup.splice(0)) await task();
  });

  it('방금 나눈 대화를 재기동 없이 찾는다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ch-search-e2e-'));
    const daemon = await boot(root);
    cleanup.push(async () => {
      await daemon.stop();
      await rm(root, { recursive: true, force: true });
    });
    await daemon.searchReady;

    const cwd = await mkdtemp(join(tmpdir(), 'ch-search-cwd-'));
    cleanup.push(() => rm(cwd, { recursive: true, force: true }));
    const session = await daemon.manager.createSession({ harness: 'mock', cwd });
    await daemon.manager.prompt(session.sessionId, '타임라인 전문 검색을 붙여줘');

    const client = await RpcClient.connect(daemon);
    cleanup.push(async () => client.close());

    // 사용자 발화
    await vi.waitFor(async () => {
      const { hits } = await client.call<{ hits: SearchHit[] }>('session.search', {
        query: '전문 검색',
      });
      expect(hits.map((hit) => hit.kind)).toContain('user');
      expect(hits[0]?.sessionId).toBe(session.sessionId);
    });

    // 어시스턴트 발화 — 목 어댑터가 '작업을 ' + '시작합니다' 두 델타로 흘린다.
    // 원본 줄에는 이 문자열이 통째로 존재하지 않는다.
    //
    // 사용자 발화와 따로 기다리는 이유: `user_message` 는 턴의 **첫** 행이라 그것이
    // 잡혔다는 것이 어시스턴트 세그먼트까지 색인됐다는 뜻은 아니다.
    await vi.waitFor(async () => {
      const { hits } = await client.call<{ hits: SearchHit[] }>('session.search', {
        query: '작업을 시작합니다',
        kinds: ['assistant'],
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ sessionId: session.sessionId, kind: 'assistant' });
      expect(hits[0]?.snippet).toContain('작업을 시작합니다');
      // 결과를 눌렀을 때 찾아갈 자리
      expect(hits[0]?.seq).toBeGreaterThanOrEqual(0);
    });
  });

  it('파일 검색이 같은 연결에서 왕복한다 — 팔레트가 두 RPC 를 함께 쓴다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ch-search-file-'));
    const cwd = await mkdtemp(join(tmpdir(), 'ch-search-cwd-'));
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src', 'palette.ts'), 'export const x = 1;\n');
    const daemon = await boot(root);
    cleanup.push(async () => {
      await daemon.stop();
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    });
    await daemon.searchReady;
    const { workspace } = await daemon.provisioning.openProject(cwd);

    const client = await RpcClient.connect(daemon);
    cleanup.push(async () => client.close());
    const result = await client.call<{ paths: string[]; truncated: boolean }>('file.search', {
      workspaceId: workspace.id,
      query: 'palette',
    });
    expect(result.paths).toEqual(['src/palette.ts']);
  });

  it('색인 파일을 지워도 기동 시 타임라인에서 되살아난다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ch-search-rebuild-'));
    const cwd = await mkdtemp(join(tmpdir(), 'ch-search-cwd-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    cleanup.push(() => rm(cwd, { recursive: true, force: true }));

    const first = await boot(root);
    await first.searchReady;
    const session = await first.manager.createSession({ harness: 'mock', cwd });
    await first.manager.prompt(session.sessionId, '폐쇄망 게이트웨이 경계 점검');
    await vi.waitFor(() => {
      expect(first.searchIndex.search({ query: '폐쇄망' })).not.toHaveLength(0);
    });
    await first.stop();

    // 색인은 파생물이다 — 통째로 날려도 SSOT(timeline.jsonl)에서 다시 만들어져야 한다
    for (const suffix of ['', '-wal', '-shm']) {
      await rm(`${first.paths.searchIndexFile}${suffix}`, { force: true });
    }

    const second = await boot(root);
    cleanup.push(() => second.stop());
    await second.searchReady;
    const hits = second.searchIndex.search({ query: '게이트웨이 경계' });
    expect(hits.map((hit) => hit.sessionId)).toEqual([session.sessionId]);
  });
});
