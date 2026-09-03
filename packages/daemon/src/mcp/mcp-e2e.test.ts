// 역방향 툴 MCP e2e (WBS 7.2.3) — 하네스가 하는 그대로 한다.
//
// 실제 데몬을 띄우고, 하네스가 spawn 하듯 **빌드된 MCP 서버 프로세스**를 띄운 뒤 줄 단위
// JSON-RPC 로 몰아본다. 여기까지 통과하면 남은 미지수는 "하네스가 이 서버를 띄우는가" 하나이고,
// 그건 7.2.1 이 같은 등록 형식으로 이미 실증했다.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TOOL_CATALOG } from '@custom-harness/protocol';
import { FakeAdapter } from '../adapters/testing.js';
import { startDaemon, type DaemonHandle } from '../index.js';

/** 빌드 산출물을 띄운다 — 하네스가 실행하는 것이 이 파일이다 */
const mcpEntry = fileURLToPath(new URL('../../dist/mcp/main.js', import.meta.url));

interface JsonRpcReply {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

describe('MCP 서버 e2e', () => {
  let daemon: DaemonHandle;
  let child: ChildProcessWithoutNullStreams;
  let replies: JsonRpcReply[] = [];
  let nextId = 0;

  beforeAll(async () => {
    // dist 가 없으면 이 스위트는 의미가 없다 — 조용히 통과시키지 않고 안내와 함께 실패시킨다
    await access(mcpEntry).catch(() => {
      throw new Error(`MCP 진입점이 없다: ${mcpEntry} — 먼저 \`npm run typecheck\` 로 빌드하라`);
    });
  });

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'ch-mcpe2e-'));
    // 역방향 툴은 기본 off (WBS 7.2.4) — e2e 는 켠 상태를 본다.
    // env 가 아니라 settings.json 으로 켜는 이유: env 는 이 vitest 프로세스 전역이라
    // 같은 워커의 다른 스위트까지 켜 버린다.
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(
      join(root, 'data', 'settings.json'),
      JSON.stringify({ tools: { reverseExposure: true } }),
    );
    daemon = await startDaemon({ root, version: '0.1.0', adapters: () => [new FakeAdapter()] });

    child = spawn(process.execPath, [mcpEntry], {
      env: { ...process.env, CUSTOM_HARNESS_HOME: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    replies = [];
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line !== '') replies.push(JSON.parse(line) as JsonRpcReply);
      }
    });
  });

  afterEach(async () => {
    child.kill('SIGKILL');
    await daemon.stop();
  });

  /** 요청을 보내고 그 id 의 응답을 기다린다 */
  async function request(method: string, params?: Record<string, unknown>): Promise<JsonRpcReply> {
    const id = ++nextId;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const deadline = Date.now() + 15_000;
    for (;;) {
      const found = replies.find((reply) => reply.id === id);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`${method} 응답 없음`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const payloadOf = (reply: JsonRpcReply): Record<string, unknown> => {
    const content = (reply.result as { content: { text: string }[] }).content;
    return JSON.parse(content[0]!.text) as Record<string, unknown>;
  };

  it('initialize → tools/list 로 카탈로그 전체가 노출된다', async () => {
    await request('initialize', { protocolVersion: '2025-06-18' });
    const listed = await request('tools/list');
    const tools = (listed.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_CATALOG.map((t) => t.name).sort());
    // 각 툴은 모델이 쓸 수 있는 JSON Schema 를 들고 온다
    for (const tool of tools) {
      expect((tool as unknown as { inputSchema: { type: string } }).inputSchema.type).toBe(
        'object',
      );
    }
  });

  it('read 툴이 실제 데몬 상태를 되돌린다 — 왕복 완결', async () => {
    await request('initialize', {});
    // 데몬에 실제 프로젝트·워크스페이스를 만든다
    const cwd = await mkdtemp(join(tmpdir(), 'ch-mcpe2e-ws-'));
    const opened = await daemon.provisioning.openProject(cwd);

    const called = await request('tools/call', { name: 'ws_list', arguments: {} });
    expect((called.result as { isError: boolean }).isError).toBe(false);
    const payload = payloadOf(called) as { workspaces: { id: string }[] };
    expect(payload.workspaces.map((w) => w.id)).toContain(opened.workspace.id);
  });

  it('세션 목록에 주의 상태가 실린다 — 7.1 의 데몬 값 그대로', async () => {
    await request('initialize', {});
    const cwd = await mkdtemp(join(tmpdir(), 'ch-mcpe2e-s-'));
    const opened = await daemon.provisioning.openProject(cwd);
    const created = await daemon.manager.createSession({
      harness: 'mock',
      workspaceId: opened.workspace.id,
      cwd,
    });

    const called = await request('tools/call', { name: 'session_list', arguments: {} });
    const payload = payloadOf(called) as { sessions: Record<string, unknown>[] };
    const found = payload.sessions.find((s) => s.sessionId === created.sessionId);
    expect(found).toBeDefined();
    expect(found).toHaveProperty('status');
  });

  it('승인 대상 write 툴은 호출자 세션을 못 찾으면 거부된다 — 재귀 상한을 셀 근거가 없다', async () => {
    await request('initialize', {});
    const called = await request('tools/call', {
      name: 'session_say',
      arguments: { sessionId: 'nope', prompt: '안녕' },
    });
    const result = called.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    // session_say 는 write 승인보다 재귀 상한 검사를 먼저 통과해야 한다.
    // 호출자를 찾지 못하면 사용자에게 승인 카드를 띄우기 전 안전하게 거부한다.
    expect(result.content[0]!.text).toContain('호출자 세션');
  });

  it('환각 파라미터는 조용히 무시되지 않는다', async () => {
    await request('initialize', {});
    const called = await request('tools/call', {
      name: 'ws_list',
      arguments: { projectID: 'wrong-case' },
    });
    expect((called.result as { isError: boolean }).isError).toBe(true);
  });

  it('없는 대상은 데몬 오류를 결과로 되돌린다 (프로토콜 오류가 아니다)', async () => {
    await request('initialize', {});
    const called = await request('tools/call', {
      name: 'term_read',
      arguments: { terminalId: 'ghost' },
    });
    expect(called.error).toBeUndefined();
    expect((called.result as { isError: boolean }).isError).toBe(true);
  });
});
