// 역방향 툴 MCP 노출 (WBS 7.2.3) — 전송·바인딩·등록 3층을 각각 고정한다.
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOL_CATALOG } from '@custom-harness/protocol';
import { createLineReader, McpStdioServer, type ToolInvoker } from './server.js';
import { createToolInvoker, type DaemonRpc } from './tools.js';
import { access, readFile as readFileAsync } from 'node:fs/promises';
import {
  PI_EXTENSION_FILENAME,
  piExtensionEnv,
  registerGrokMcpServer,
  registerOmpMcpServer,
  registerPiExtension,
  resolveMcpServerSpec,
  REVERSE_MCP_SERVER_NAME,
  type CommandRunner,
} from './registration.js';

/** 호출을 기록하는 가짜 데몬 RPC */
function fakeRpc(replies: Record<string, Record<string, unknown>> = {}): DaemonRpc & {
  calls: { method: string; params: Record<string, unknown> }[];
} {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      const reply = replies[method];
      if (reply === undefined) throw new Error(`가짜 RPC 에 ${method} 응답이 없다`);
      return reply;
    },
  };
}

function collectingServer(invoker: ToolInvoker): {
  server: McpStdioServer;
  sent: Record<string, unknown>[];
} {
  const sent: Record<string, unknown>[] = [];
  const server = new McpStdioServer({ invoker, send: (message) => sent.push(message) });
  return { server, sent };
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]!.text;

describe('McpStdioServer', () => {
  const stubInvoker: ToolInvoker = {
    list: () => [{ name: 'x', description: 'd', inputSchema: {} }],
    call: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
  };

  it('initialize 는 클라이언트가 요청한 프로토콜 버전을 되돌린다', async () => {
    // 하네스마다 버전이 다르다(grok 은 2025-11-25) — 우리가 고집하면 서버가 아예 안 뜬다
    const { server, sent } = collectingServer(stubInvoker);
    await server.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25' },
      }),
    );
    expect((sent[0]!.result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');
  });

  it('알림(id 없음)에는 응답하지 않는다', async () => {
    const { server, sent } = collectingServer(stubInvoker);
    await server.handleLine(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );
    expect(sent).toHaveLength(0);
  });

  it('파싱 불가 줄은 서버를 죽이지 않는다', async () => {
    const { server, sent } = collectingServer(stubInvoker);
    await server.handleLine('{ 깨진 JSON');
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.id).toBe(2);
  });

  it('알 수 없는 method 는 JSON-RPC 오류로 답한다', async () => {
    const { server, sent } = collectingServer(stubInvoker);
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'nope' }));
    expect((sent[0]!.error as { code: number }).code).toBe(-32601);
  });

  it('툴 실행 실패는 프로토콜 오류가 아니라 isError 결과다', async () => {
    // 프로토콜 오류로 올리면 하네스가 대화 밖에서 삼켜 모델이 못 본다
    const failing: ToolInvoker = {
      list: () => [],
      call: async () => ({ content: [{ type: 'text', text: '거부됨' }], isError: true }),
    };
    const { server, sent } = collectingServer(failing);
    await server.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'x', arguments: {} },
      }),
    );
    expect(sent[0]!.error).toBeUndefined();
    expect((sent[0]!.result as { isError: boolean }).isError).toBe(true);
  });
});

describe('createLineReader', () => {
  it('청크 경계와 줄 경계가 달라도 줄을 온전히 모은다', () => {
    const lines: string[] = [];
    const feed = createLineReader((line) => lines.push(line));
    feed('{"a":1}\n{"b":');
    feed('2}\n{"c":3}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
});

describe('createToolInvoker — 승인 게이트', () => {
  it('게이트 없는 경로에서는 write 툴 전부가 거부된다', async () => {
    const invoker = createToolInvoker({ rpc: fakeRpc() });
    const writeTools = TOOL_CATALOG.filter((tool) => tool.effect === 'write');
    expect(writeTools.length).toBeGreaterThan(0);
    // 스키마가 엄격하므로(z.strictObject) 툴마다 **정확한** 최소 인자를 준다 —
    // 공통 superset 을 넘기면 검증에서 걸려 승인 게이트를 확인하지 못한다
    const minimalArgs: Record<string, Record<string, unknown>> = {
      session_new: { harness: 'mock', cwd: '/tmp' },
      session_say: { sessionId: 's1', prompt: 'hi' },
      session_stop: { sessionId: 's1' },
      term_new: { workspaceId: 'w1' },
      term_send: { terminalId: 't1', data: 'ls\n' },
    };
    for (const tool of writeTools) {
      const args = minimalArgs[tool.name];
      expect(args, `${tool.name} 의 최소 인자가 테스트에 없다`).toBeDefined();
      const result = await invoker.call(tool.name, args!);
      expect(result.isError, `${tool.name} 가 승인 없이 통과했다`).toBe(true);
      expect(textOf(result)).toContain('승인');
    }
  });

  it('read 툴은 승인 없이 통과한다 — 조회까지 막으면 감시가 불가능하다', async () => {
    const rpc = fakeRpc({ 'workspace.list': { workspaces: [{ id: 'w1' }] } });
    const invoker = createToolInvoker({ rpc });
    const result = await invoker.call('ws_list', {});
    expect(result.isError).toBe(false);
    expect(rpc.calls[0]!.method).toBe('workspace.list');
  });

  it('게이트가 통과시키면 write 툴이 데몬 RPC 까지 간다 (7.2.4)', async () => {
    const rpc = fakeRpc({ 'session.interrupt': {} });
    const invoker = createToolInvoker({ rpc, gate: async () => ({ allow: true }) });
    const result = await invoker.call('session_stop', { sessionId: 's1' });
    expect(result.isError).toBe(false);
    expect(rpc.calls[0]!.method).toBe('session.interrupt');
  });

  it('게이트가 거부하면 사유가 그대로 모델에게 간다 — RPC 는 불리지 않는다', async () => {
    const rpc = fakeRpc({ 'session.interrupt': {} });
    const invoker = createToolInvoker({
      rpc,
      gate: async () => ({ allow: false, reason: '사용자가 거부했다' }),
    });
    const result = await invoker.call('session_stop', { sessionId: 's1' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('사용자가 거부했다');
    expect(rpc.calls).toHaveLength(0);
  });

  it('게이트가 만든 라벨이 session.create 로 전달된다 — 재귀 깊이의 근거', async () => {
    const rpc = fakeRpc({ 'session.create': { session: { sessionId: 'child' } } });
    const invoker = createToolInvoker({
      rpc,
      gate: async () => ({ allow: true, labels: { 'ch.toolDepth': '1' } }),
    });
    const result = await invoker.call('session_new', { harness: 'mock', cwd: '/tmp' });
    expect(result.isError).toBe(false);
    expect(rpc.calls[0]!.params.labels).toEqual({ 'ch.toolDepth': '1' });
  });
});

describe('createToolInvoker — 파라미터 검증', () => {
  it('환각 파라미터는 조용히 무시되지 않고 실패한다', async () => {
    // z.strictObject 를 쓰는 이유 (7.2.2) — 입력을 만드는 쪽이 모델이다.
    // **RPC 는 성공하도록 준비해 둔다** — 응답을 안 주면 "RPC 에 응답이 없다"는 다른 이유로
    // isError 가 되어 검증이 통과해 버린다(7.2.3 e2e 가 이 함정을 실제로 드러냈다).
    const rpc = fakeRpc({ 'workspace.list': { workspaces: [] } });
    const result = await createToolInvoker({ rpc }).call('ws_list', { projctId: 'oops' });
    expect(result.isError).toBe(true);
    expect(rpc.calls).toHaveLength(0); // 검증에서 걸렸으므로 데몬까지 가지 않았다
  });

  it('타입이 틀리면 실패한다', async () => {
    const invoker = createToolInvoker({ rpc: fakeRpc() });
    const result = await invoker.call('term_read', { terminalId: 't1', bytes: 'lots' });
    expect(result.isError).toBe(true);
  });

  it('알 수 없는 툴 이름은 사용 가능 목록과 함께 실패한다', async () => {
    const invoker = createToolInvoker({ rpc: fakeRpc() });
    const result = await invoker.call('session_delete', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('session_list');
  });
});

describe('createToolInvoker — read 툴 바인딩', () => {
  it('session_list 는 주의 상태를 다시 계산하지 않고 데몬 값으로 거른다', async () => {
    const rpc = fakeRpc({
      'session.list': {
        sessions: [
          {
            sessionId: 'a',
            requiresAttention: true,
            attentionReason: 'permission',
            status: 'idle',
          },
          { sessionId: 'b', requiresAttention: false, status: 'running' },
        ],
      },
    });
    const invoker = createToolInvoker({ rpc });
    const result = await invoker.call('session_list', { requiresAttention: true });
    const payload = JSON.parse(textOf(result)) as { sessions: Record<string, unknown>[] };
    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0]!.sessionId).toBe('a');
    expect(payload.sessions[0]!.attentionReason).toBe('permission');
  });

  it('session_list 는 승인 원문 대신 개수만 싣는다', async () => {
    const rpc = fakeRpc({
      'session.list': {
        sessions: [
          { sessionId: 'a', pendingPermissions: [{ requestId: 'p1' }, { requestId: 'p2' }] },
        ],
      },
    });
    const result = await createToolInvoker({ rpc }).call('session_list', {});
    const payload = JSON.parse(textOf(result)) as { sessions: Record<string, unknown>[] };
    expect(payload.sessions[0]!.pendingPermissionCount).toBe(2);
    expect(payload.sessions[0]!.pendingPermissions).toBeUndefined();
  });

  it('session_read 는 limit 을 끝에서 자르고 truncated 를 알린다', async () => {
    const events = Array.from({ length: 5 }, (_, i) => ({ seq: i }));
    const rpc = fakeRpc({ 'session.timeline': { events } });
    const result = await createToolInvoker({ rpc }).call('session_read', {
      sessionId: 's1',
      limit: 2,
    });
    const payload = JSON.parse(textOf(result)) as {
      events: { seq: number }[];
      truncated: boolean;
    };
    expect(payload.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(payload.truncated).toBe(true);
  });

  it('term_read 는 base64 가 아니라 읽을 수 있는 텍스트를 준다', async () => {
    const rpc = fakeRpc({
      'terminal.read': { scrollback: Buffer.from('hello\n').toString('base64'), truncated: false },
    });
    const result = await createToolInvoker({ rpc }).call('term_read', { terminalId: 't1' });
    const payload = JSON.parse(textOf(result)) as { output: string };
    expect(payload.output).toBe('hello\n');
  });

  it('데몬 RPC 실패는 예외가 아니라 isError 결과로 나온다', async () => {
    const rpc: DaemonRpc = {
      call: async () => {
        throw new Error('not_found: 터미널 없음');
      },
    };
    const result = await createToolInvoker({ rpc }).call('term_read', { terminalId: 'gone' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('터미널 없음');
  });
});

describe('createToolInvoker — 위임 툴 바인딩 (M7 7.3.1)', () => {
  const parentLabels = (parent: string): Record<string, string> => ({
    'ch.parentSessionId': parent,
    'ch.toolDepth': '1',
  });

  it('session_list 가 부모로 자식만 거른다 — 관계의 정본은 라벨이다', async () => {
    const rpc = fakeRpc({
      'session.list': {
        sessions: [
          { sessionId: 'child', labels: parentLabels('p1'), status: 'running' },
          { sessionId: 'other', labels: parentLabels('p2'), status: 'idle' },
          { sessionId: 'orphan', status: 'idle' },
        ],
      },
    });
    const result = await createToolInvoker({ rpc }).call('session_list', {
      parentSessionId: 'p1',
    });
    const payload = JSON.parse(textOf(result)) as { sessions: Record<string, unknown>[] };
    expect(payload.sessions.map((s) => s.sessionId)).toEqual(['child']);
    // 라벨이 결과에 남아야 모델이 위임 구조를 읽는다
    expect(payload.sessions[0]!.labels).toEqual(parentLabels('p1'));
  });

  it('session_wait 는 미완료를 실패가 아니라 done=false 로 알린다', async () => {
    const rpc = fakeRpc({
      'session.wait': { status: 'running', activeTurn: true, timedOut: true },
    });
    const result = await createToolInvoker({ rpc }).call('session_wait', {
      sessionId: 's1',
      timeoutMs: 1000,
    });
    expect(result.isError).toBe(false);
    const payload = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(payload).toMatchObject({ done: false, timedOut: true });
    // 다시 부르라는 안내가 없으면 모델이 포기하고 위임이 끊긴다
    expect(String(payload.note)).toContain('다시 호출');
  });

  it('session_wait 는 완료를 done=true + 결말로 준다', async () => {
    const rpc = fakeRpc({
      'session.wait': {
        status: 'idle',
        activeTurn: false,
        timedOut: false,
        lastTurnOutcome: 'completed',
      },
    });
    const result = await createToolInvoker({ rpc }).call('session_wait', { sessionId: 's1' });
    const payload = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(payload).toMatchObject({ done: true, outcome: 'completed' });
    expect(payload.note).toBeUndefined();
    // 상한을 안 넘기면 데몬 기본값을 쓰게 둔다
    expect(rpc.calls[0]!.params).toEqual({ sessionId: 's1' });
  });

  it('session_result 는 타임라인이 아니라 마지막 턴만 가져온다', async () => {
    const rpc = fakeRpc({
      'session.result': { status: 'idle', outcome: 'completed', text: '답', pending: false },
    });
    const result = await createToolInvoker({ rpc }).call('session_result', { sessionId: 's1' });
    expect(rpc.calls[0]!.method).toBe('session.result'); // session.timeline 이 아니다
    expect(JSON.parse(textOf(result))).toMatchObject({ text: '답', outcome: 'completed' });
  });

  it('session_usage 는 자기 사용량과 자손 합을 나눠 준다 (7.3.2)', async () => {
    const rpc = fakeRpc({
      'session.usage': {
        own: { totalTokens: 10 },
        subtree: { totalTokens: 35 },
        childCount: 1,
        activeChildCount: 1,
        children: [{ sessionId: 'c1', status: 'idle', harness: 'mock', subtree: {} }],
      },
    });
    const result = await createToolInvoker({ rpc }).call('session_usage', { sessionId: 'p1' });
    const payload = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(payload).toMatchObject({ activeChildCount: 1 });
    expect((payload.own as { totalTokens: number }).totalTokens).toBe(10);
    expect((payload.subtree as { totalTokens: number }).totalTokens).toBe(35);
  });

  it('대기·회수·비용 조회는 승인 대상이 아니다 — 조회를 막으면 위임을 감시할 수 없다', () => {
    for (const name of ['session_wait', 'session_result', 'session_usage']) {
      const spec = TOOL_CATALOG.find((tool) => tool.name === name);
      expect(spec?.effect, name).toBe('read');
      expect(spec?.approval, name).toBe(false);
    }
  });
});

describe('등록 — omp mcp.json', () => {
  it('없으면 만들고, 두 번째는 unchanged 다', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ch-omp-'));
    const spec = resolveMcpServerSpec({
      root: '/data/root',
      execPath: '/bin/node',
      entryPath: '/app/mcp.js',
      runAsNode: false,
    });

    const first = await registerOmpMcpServer(home, spec);
    expect(first.status).toBe('created');

    const written = JSON.parse(await readFile(join(home, 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    expect(written.mcpServers[REVERSE_MCP_SERVER_NAME]!.command).toBe('/bin/node');
    expect(written.mcpServers[REVERSE_MCP_SERVER_NAME]!.args).toEqual(['/app/mcp.js']);
    // 데이터 루트는 반드시 명시된다 — 홈이 격리된 하네스의 자식이라 homedir() 로는 못 찾는다
    expect(written.mcpServers[REVERSE_MCP_SERVER_NAME]!.env.CUSTOM_HARNESS_HOME).toBe('/data/root');

    expect((await registerOmpMcpServer(home, spec)).status).toBe('unchanged');
  });

  it('사용자가 추가한 다른 서버를 지우지 않는다', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ch-omp-'));
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, 'mcp.json'),
      JSON.stringify({ mcpServers: { mine: { command: 'x' } }, other: 1 }),
    );
    const spec = resolveMcpServerSpec({
      root: '/r',
      execPath: '/n',
      entryPath: '/e',
      runAsNode: false,
    });
    await registerOmpMcpServer(home, spec);

    const written = JSON.parse(await readFile(join(home, 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
      other: number;
    };
    expect(written.mcpServers.mine).toEqual({ command: 'x' });
    expect(written.mcpServers[REVERSE_MCP_SERVER_NAME]).toBeDefined();
    expect(written.other).toBe(1); // 우리 것 밖의 최상위 키도 보존
  });

  it('번들 경로가 바뀌면 우리 항목을 갱신한다', async () => {
    // 이 항목은 사용자 설정이 아니라 데몬의 실행 사양이다 — 낡으면 서버가 아예 안 뜬다
    const home = await mkdtemp(join(tmpdir(), 'ch-omp-'));
    await registerOmpMcpServer(
      home,
      resolveMcpServerSpec({ root: '/r', execPath: '/n', entryPath: '/old.js', runAsNode: false }),
    );
    const second = await registerOmpMcpServer(
      home,
      resolveMcpServerSpec({ root: '/r', execPath: '/n', entryPath: '/new.js', runAsNode: false }),
    );
    expect(second.status).toBe('updated');
    const written = JSON.parse(await readFile(join(home, 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    expect(written.mcpServers[REVERSE_MCP_SERVER_NAME]!.args).toEqual(['/new.js']);
  });

  it('ELECTRON_RUN_AS_NODE 는 번들에서만 붙는다', () => {
    expect(resolveMcpServerSpec({ root: '/r', runAsNode: true }).env.ELECTRON_RUN_AS_NODE).toBe(
      '1',
    );
    expect(
      resolveMcpServerSpec({ root: '/r', runAsNode: false }).env.ELECTRON_RUN_AS_NODE,
    ).toBeUndefined();
  });
});

describe('등록 — grok CLI 위임', () => {
  it('remove 로 멱등성을 만들고 add 에 env 와 명령을 전달한다', async () => {
    const invocations: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const run: CommandRunner = async (file, args, options) => {
      invocations.push({ file, args, env: options.env });
      return { stdout: 'added', stderr: '' };
    };
    const spec = resolveMcpServerSpec({
      root: '/data',
      execPath: '/bin/node',
      entryPath: '/app/mcp.js',
      runAsNode: false,
    });

    const result = await registerGrokMcpServer({
      execPath: '/bundle/grok',
      grokHome: '/data/grok-home',
      spec,
      env: { HOME: '/data/harness-home/grok' },
      run,
    });

    expect(result.status).toBe('registered');
    expect(invocations).toHaveLength(2);
    expect(invocations[0]!.args).toEqual(['mcp', 'remove', 'ch', '--scope', 'user']);

    const add = invocations[1]!;
    expect(add.file).toBe('/bundle/grok');
    // TOML 스키마를 추측하지 않는다 — grok 자신의 CLI 가 쓰게 한다
    expect(add.args.slice(0, 5)).toEqual(['mcp', 'add', 'ch', '--scope', 'user']);
    expect(add.args).toContain('-e');
    expect(add.args).toContain('CUSTOM_HARNESS_HOME=/data');
    expect(add.args.slice(add.args.indexOf('--'))).toEqual(['--', '/bin/node', '/app/mcp.js']);
    // 격리 홈 env 를 물려주고 GROK_HOME 을 덮는다
    expect(add.env.HOME).toBe('/data/harness-home/grok');
    expect(add.env.GROK_HOME).toBe('/data/grok-home');
  });

  it('remove 실패는 무시한다 — 없던 이름이면 실패가 정상이다', async () => {
    let calls = 0;
    const run: CommandRunner = async () => {
      calls += 1;
      if (calls === 1) throw new Error('no such server');
      return { stdout: '', stderr: '' };
    };
    const spec = resolveMcpServerSpec({
      root: '/d',
      execPath: '/n',
      entryPath: '/e',
      runAsNode: false,
    });
    await expect(
      registerGrokMcpServer({ execPath: '/g', grokHome: '/gh', spec, run }),
    ).resolves.toMatchObject({ status: 'registered' });
  });
});

describe('등록 — pi 확장 (7.2.3b)', () => {
  it('격리 홈의 extensions/ 에 설치한다', async () => {
    // PI_CODING_AGENT_DIR 가 ~/.pi/agent 를 대체하므로 전역 자동 탐색 경로가 여기다
    const piHome = await mkdtemp(join(tmpdir(), 'ch-pi-'));
    const source = join(await mkdtemp(join(tmpdir(), 'ch-pi-src-')), 'ext.ts');
    await writeFile(source, '// 확장 원본\n');

    const result = await registerPiExtension(piHome, { sourcePath: source });
    expect(result.path).toBe(join(piHome, 'extensions', PI_EXTENSION_FILENAME));
    await expect(access(result.path)).resolves.toBeUndefined();
    expect(await readFileAsync(result.path, 'utf8')).toBe('// 확장 원본\n');
  });

  it('매번 덮어쓴다 — 번들 갱신본이 낡으면 툴이 조용히 사라진다', async () => {
    const piHome = await mkdtemp(join(tmpdir(), 'ch-pi-'));
    const srcDir = await mkdtemp(join(tmpdir(), 'ch-pi-src-'));
    const source = join(srcDir, 'ext.ts');

    await writeFile(source, 'v1');
    await registerPiExtension(piHome, { sourcePath: source });
    await writeFile(source, 'v2');
    const result = await registerPiExtension(piHome, { sourcePath: source });

    expect(await readFileAsync(result.path, 'utf8')).toBe('v2');
  });

  it('확장은 spawn 사양을 env 로 받는다 — 파일에 경로를 굽지 않는다', async () => {
    // 파일에 구우면 번들 갱신 시점이 어긋날 때 없는 실행 파일을 가리킨 채로 남는다
    const spec = resolveMcpServerSpec({
      root: '/data',
      execPath: '/bin/node',
      entryPath: '/app/mcp.js',
      runAsNode: false,
    });
    const env = piExtensionEnv(spec);
    expect(env.CUSTOM_HARNESS_MCP_COMMAND).toBe('/bin/node');
    expect(JSON.parse(env.CUSTOM_HARNESS_MCP_ARGS!)).toEqual(['/app/mcp.js']);
    expect(env.CUSTOM_HARNESS_HOME).toBe('/data');
  });
});
