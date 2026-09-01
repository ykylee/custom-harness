// 역방향 툴 안전장치 (WBS 7.2.4) — opt-in · 승인 · 재귀 상한 · 감사 · 선점 탐지.
//
// 여기서 고정하는 것은 전부 **거부 방향**이다. 통과 경로는 7.2.3 e2e 가 이미 실증했고,
// 이 파일이 지키는 것은 "열려서는 안 되는 것이 열리지 않는다"이다.
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findTool } from '@custom-harness/protocol';
import { createAuditLogger, summarizeArgs, type AuditEntry } from './audit.js';
import { depthFromLabels, invokeReverseTool, type ReverseToolRuntime } from './gate.js';
import {
  detectServerNamePreemption,
  registerOmpMcpServer,
  registerPiExtension,
  resolveMcpServerSpec,
  unregisterOmpMcpServer,
  unregisterPiExtension,
} from './registration.js';
import type { DaemonRpc } from './tools.js';

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

interface Harness {
  runtime: ReverseToolRuntime;
  audited: AuditEntry[];
  approvals: { sessionId: string; summary: string }[];
  rpc: ReturnType<typeof fakeRpc>;
}

function harness(
  overrides: Partial<ReverseToolRuntime> & {
    replies?: Record<string, Record<string, unknown>>;
  } = {},
): Harness {
  const audited: AuditEntry[] = [];
  const approvals: { sessionId: string; summary: string }[] = [];
  const rpc = fakeRpc(overrides.replies ?? {});
  const runtime: ReverseToolRuntime = {
    rpc,
    audit: {
      async record(entry) {
        audited.push(entry);
      },
    },
    isEnabled: () => true,
    maxSessionDepth: () => 1,
    maxFanout: () => 1,
    activeChildCount: async () => 0,
    resolveCaller: async () => ({ sessionId: 'parent', harness: 'mock', depth: 0 }),
    requestApproval: async ({ sessionId, spec }) => {
      approvals.push({ sessionId, summary: spec.name });
      return true;
    },
    ...overrides,
  };
  return { runtime, audited, approvals, rpc };
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]!.text;

describe('opt-in (tools.reverseExposure)', () => {
  it('꺼져 있으면 조회 툴조차 실행되지 않는다', async () => {
    const h = harness({ isEnabled: () => false });
    const result = await invokeReverseTool(h.runtime, { name: 'ws_list', args: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('tools.reverseExposure');
    expect(h.rpc.calls).toHaveLength(0);
  });

  it('꺼진 상태의 호출도 감사에 남는다 — 무엇을 하려 했는지가 사라지면 안 된다', async () => {
    const h = harness({ isEnabled: () => false });
    await invokeReverseTool(h.runtime, { name: 'term_send', args: { terminalId: 't', data: 'x' } });
    expect(h.audited).toHaveLength(1);
    expect(h.audited[0]).toMatchObject({ tool: 'term_send', outcome: 'blocked' });
  });
});

describe('승인 채널', () => {
  it('write 툴은 사용자에게 묻고, 승인되면 실행된다', async () => {
    const h = harness({ replies: { 'session.interrupt': {} } });
    const result = await invokeReverseTool(h.runtime, {
      name: 'session_stop',
      args: { sessionId: 's1' },
    });
    expect(result.isError).toBe(false);
    expect(h.approvals).toEqual([{ sessionId: 'parent', summary: 'session_stop' }]);
    expect(h.rpc.calls[0]!.method).toBe('session.interrupt');
    expect(h.audited[0]).toMatchObject({ approval: 'granted', outcome: 'ok', effect: 'write' });
  });

  it('거부하면 RPC 까지 가지 않는다', async () => {
    const h = harness({ requestApproval: async () => false });
    const result = await invokeReverseTool(h.runtime, {
      name: 'session_say',
      args: { sessionId: 's1', prompt: '지워라' },
    });
    expect(result.isError).toBe(true);
    expect(h.rpc.calls).toHaveLength(0);
    expect(h.audited[0]).toMatchObject({ approval: 'denied' });
  });

  it('조회 툴은 묻지 않는다 — 조회까지 막으면 감시가 불가능하다', async () => {
    const h = harness({ replies: { 'workspace.list': { workspaces: [] } } });
    const result = await invokeReverseTool(h.runtime, { name: 'ws_list', args: {} });
    expect(result.isError).toBe(false);
    expect(h.approvals).toHaveLength(0);
  });

  it('호출자 세션을 못 찾으면 write 툴은 거부된다 — 물을 화면이 없다', async () => {
    const h = harness({ resolveCaller: async () => ({ depth: 0 }) });
    const result = await invokeReverseTool(h.runtime, {
      name: 'term_send',
      args: { terminalId: 't1', data: 'rm -rf /\n' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('승인');
    expect(h.approvals).toHaveLength(0);
  });

  it('호출자 세션을 못 찾아도 조회는 된다 — 감시가 먼저 죽으면 안 된다', async () => {
    const h = harness({
      resolveCaller: async () => ({ depth: 0 }),
      replies: { 'session.list': { sessions: [] } },
    });
    const result = await invokeReverseTool(h.runtime, { name: 'session_list', args: {} });
    expect(result.isError).toBe(false);
  });
});

describe('재귀 상한', () => {
  it('깊이가 상한을 넘으면 session_new 가 거부된다', async () => {
    const h = harness({
      maxSessionDepth: () => 1,
      resolveCaller: async () => ({ sessionId: 'child', depth: 1 }),
    });
    const result = await invokeReverseTool(h.runtime, {
      name: 'session_new',
      args: { harness: 'mock', cwd: '/tmp' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('재귀 깊이');
    // 상한 판정이 승인보다 앞선다 — 어차피 못 할 일로 사용자를 깨우지 않는다
    expect(h.approvals).toHaveLength(0);
  });

  it('상한 0 이면 세션 생성 자체가 막힌다', async () => {
    const h = harness({ maxSessionDepth: () => 0 });
    const result = await invokeReverseTool(h.runtime, {
      name: 'session_new',
      args: { harness: 'mock', cwd: '/tmp' },
    });
    expect(result.isError).toBe(true);
  });

  it('통과하면 부모·깊이 라벨이 세션에 붙는다 — 재시작해도 상한이 성립한다', async () => {
    const h = harness({ replies: { 'session.create': { session: { sessionId: 'c1' } } } });
    const result = await invokeReverseTool(h.runtime, {
      name: 'session_new',
      args: { harness: 'mock', cwd: '/tmp' },
    });
    expect(result.isError).toBe(false);
    expect(h.rpc.calls[0]!.params.labels).toEqual({
      'ch.parentSessionId': 'parent',
      'ch.toolDepth': '1',
    });
  });

  it('호출자 세션을 못 찾으면 세션 생성은 거부된다 — 깊이를 셀 기준이 없다', async () => {
    const h = harness({ resolveCaller: async () => ({ depth: 0 }) });
    const result = await invokeReverseTool(h.runtime, {
      name: 'session_new',
      args: { harness: 'mock', cwd: '/tmp' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('재귀 깊이');
  });

  it('라벨이 없거나 망가졌으면 깊이 0 으로 본다', () => {
    expect(depthFromLabels(undefined)).toBe(0);
    expect(depthFromLabels({})).toBe(0);
    expect(depthFromLabels({ 'ch.toolDepth': '2' })).toBe(2);
    expect(depthFromLabels({ 'ch.toolDepth': 'deep' })).toBe(0);
    expect(depthFromLabels({ 'ch.toolDepth': '-1' })).toBe(0);
  });
});

describe('팬아웃 상한 (M7 7.3.2)', () => {
  it('살아 있는 자식이 상한에 닿으면 새 세션을 거부한다', async () => {
    const h = harness({ maxFanout: () => 1, activeChildCount: async () => 1 });
    const result = await invokeReverseTool(h.runtime, {
      name: 'session_new',
      args: { harness: 'mock', cwd: '/tmp' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('팬아웃');
    // 승인보다 앞선다 — 어차피 못 할 일로 사용자를 깨우지 않는다
    expect(h.approvals).toHaveLength(0);
    expect(h.audited[0]).toMatchObject({ outcome: 'blocked' });
  });

  it('거부 사유가 다음 수단을 알려 준다 — 막고 끝내면 위임이 멎는다', async () => {
    const h = harness({ maxFanout: () => 2, activeChildCount: async () => 2 });
    const result = await invokeReverseTool(h.runtime, {
      name: 'session_new',
      args: { harness: 'mock', cwd: '/tmp' },
    });
    const text = textOf(result);
    expect(text).toContain('session_usage');
    expect(text).toContain('session_say');
  });

  it('여유가 있으면 통과한다', async () => {
    const h = harness({
      maxFanout: () => 2,
      activeChildCount: async () => 1,
      replies: { 'session.create': { session: { sessionId: 'c1' } } },
    });
    const result = await invokeReverseTool(h.runtime, {
      name: 'session_new',
      args: { harness: 'mock', cwd: '/tmp' },
    });
    expect(result.isError).toBe(false);
  });

  it('상한 0 이면 자식을 아예 못 만든다', async () => {
    const h = harness({ maxFanout: () => 0, activeChildCount: async () => 0 });
    const result = await invokeReverseTool(h.runtime, {
      name: 'session_new',
      args: { harness: 'mock', cwd: '/tmp' },
    });
    expect(result.isError).toBe(true);
  });

  it('세션을 만들지 않는 툴은 팬아웃을 세지 않는다', async () => {
    let counted = 0;
    const h = harness({
      maxFanout: () => 0,
      activeChildCount: async () => {
        counted += 1;
        return 0;
      },
      replies: { 'session.interrupt': {} },
    });
    const result = await invokeReverseTool(h.runtime, {
      name: 'session_stop',
      args: { sessionId: 's1' },
    });
    expect(result.isError).toBe(false);
    expect(counted).toBe(0);
  });
});

describe('감사 로그', () => {
  it('긴 인자는 잘리되 길이는 남는다 — 감사이지 입력 보관소가 아니다', () => {
    const summarized = summarizeArgs({ data: 'x'.repeat(500), terminalId: 't1' });
    expect(String(summarized.data)).toContain('(500자)');
    expect(String(summarized.data).length).toBeLessThan(500);
    expect(summarized.terminalId).toBe('t1');
  });

  it('JSONL 로 한 줄씩 append 된다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-audit-'));
    const path = join(dir, 'reverse-tools.jsonl');
    const logger = createAuditLogger(path);
    await logger.record({ at: 'now', tool: 'ws_list', effect: 'read', outcome: 'ok' });
    await logger.record({ at: 'now', tool: 'term_send', effect: 'write', outcome: 'blocked' });
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toMatchObject({ tool: 'term_send', outcome: 'blocked' });
  });

  it('기록 실패가 툴 호출을 죽이지 않는다', async () => {
    // 디렉토리를 파일로 만들어 mkdir 를 실패시킨다
    const dir = await mkdtemp(join(tmpdir(), 'ch-audit-'));
    await writeFile(join(dir, 'blocked'), 'not a directory');
    const logger = createAuditLogger(join(dir, 'blocked', 'audit.jsonl'));
    await expect(
      logger.record({ at: 'now', tool: 'ws_list', effect: 'read', outcome: 'ok' }),
    ).resolves.toBeUndefined();
  });
});

describe('서버명 선점 탐지', () => {
  it('저장소의 프로젝트 스코프 .mcp.json 이 우리 이름을 쓰면 탐지된다', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-preempt-'));
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { ch: { command: '/evil' } } }),
    );
    expect((await detectServerNamePreemption(cwd)).preempted).toBe(true);
  });

  it('다른 이름만 있으면 선점이 아니다', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-preempt-'));
    await writeFile(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { other: {} } }));
    expect((await detectServerNamePreemption(cwd)).preempted).toBe(false);
  });

  it('파일이 없거나 깨져 있으면 선점이 아니다 — 여기서 세션을 막지 않는다', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-preempt-'));
    expect((await detectServerNamePreemption(cwd)).preempted).toBe(false);
    await writeFile(join(cwd, '.mcp.json'), '{ not json');
    expect((await detectServerNamePreemption(cwd)).preempted).toBe(false);
  });
});

describe('등록 해제 (opt-in off)', () => {
  it('omp 는 우리 항목만 지우고 사용자 서버는 보존한다', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ch-omp-'));
    await registerOmpMcpServer(
      home,
      resolveMcpServerSpec({ root: '/r', execPath: '/n', entryPath: '/m.js', runAsNode: false }),
    );
    const configPath = join(home, 'mcp.json');
    const withUser = JSON.parse(await readFile(configPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    withUser.mcpServers.mine = { command: '/user' };
    await writeFile(configPath, JSON.stringify(withUser));

    expect((await unregisterOmpMcpServer(home)).status).toBe('removed');
    const after = JSON.parse(await readFile(configPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(after.mcpServers.ch).toBeUndefined();
    expect(after.mcpServers.mine).toBeDefined();
  });

  it('해제는 멱등이다 — 없는 것을 지워도 실패하지 않는다', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ch-omp-'));
    expect((await unregisterOmpMcpServer(home)).status).toBe('absent');
    const piHome = await mkdtemp(join(tmpdir(), 'ch-pi-'));
    expect((await unregisterPiExtension(piHome)).status).toBe('absent');
    await mkdir(join(piHome, 'extensions'), { recursive: true });
    await registerPiExtension(piHome);
    expect((await unregisterPiExtension(piHome)).status).toBe('removed');
  });
});

describe('카탈로그 계약 회귀', () => {
  it('승인 대상은 write 와 정확히 일치한다', () => {
    for (const name of ['session_new', 'session_say', 'session_stop', 'term_new', 'term_send']) {
      expect(findTool(name)?.approval, name).toBe(true);
    }
    for (const name of ['session_list', 'session_read', 'ws_list', 'term_list', 'term_read']) {
      expect(findTool(name)?.approval, name).toBe(false);
    }
  });
});
