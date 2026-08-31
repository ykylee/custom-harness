import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@custom-harness/protocol';
import { ProcessSupervisor } from '../../processes.js';
import { runAdapterContractTests, type AdapterHarness } from '../contract-suite.js';
import { OmpAdapter, approvalModeFor, mapOmpToolKind } from './omp.js';

const fakeOmp = fileURLToPath(new URL('./fake-omp.fixture.cjs', import.meta.url));

function makeAdapter(): OmpAdapter {
  return new OmpAdapter({
    command: process.execPath,
    prependArgs: [fakeOmp],
    supervisor: new ProcessSupervisor({ gracePeriodMs: 500 }),
    responseTimeoutMs: 3000,
    readyTimeoutMs: 2000,
  });
}

const baseConfig = (sessionId: string, cwd: string, env: Record<string, string> = {}) =>
  ({ sessionId, cwd, env, approvalPolicy: 'mediate' }) as const;

async function factory(): Promise<AdapterHarness> {
  const cwd = await mkdtemp(join(tmpdir(), 'ch-omp-'));
  return {
    adapter: makeAdapter(),
    makeConfig: (sessionId) => baseConfig(sessionId, cwd),
  };
}

// fake omp 는 실측 스키마(oh-my-pi 17.3.8)를 흉내낸다. 승인 중재는 §4 결정으로 미지원 —
// 해당 테스트는 스위트 옵션으로 건너뛴다.
runAdapterContractTests('omp(fake)', factory, { permissionMediation: false });

async function openWith(
  prompt: string | undefined,
  configOverride?: Partial<{ env: Record<string, string>; approvalPolicy: 'mediate' | 'auto' }>,
) {
  const cwd = await mkdtemp(join(tmpdir(), 'ch-omp-'));
  const session = await makeAdapter().createSession({
    ...baseConfig(`omp-x-${Math.random().toString(36).slice(2)}`, cwd),
    ...configOverride,
  });
  const events: AgentEvent[] = [];
  session.subscribe((event) => events.push(event));
  if (prompt !== undefined) await session.startTurn(prompt);
  return { session, events };
}

describe('OmpAdapter specifics', () => {
  it('maps omp-specific tool names on top of the shared table', () => {
    expect(mapOmpToolKind('ast_grep')).toBe('search');
    expect(mapOmpToolKind('ast_edit')).toBe('edit');
    expect(mapOmpToolKind('task')).toBe('sub_agent');
    expect(mapOmpToolKind('bash')).toBe('shell');
    expect(mapOmpToolKind('quantum_flux')).toBe('other');
  });

  it('translates approvalPolicy to --approval-mode (mediate→write, auto→yolo)', async () => {
    expect(approvalModeFor('mediate')).toBe('write');
    expect(approvalModeFor('auto')).toBe('yolo');
    const { session } = await openWith(undefined, { approvalPolicy: 'auto' });
    // fake 는 --approval-mode 값을 get_state 로 되돌린다
    const state = await (
      session as unknown as {
        transport: { request(c: Record<string, unknown>): Promise<{ data?: unknown }> };
      }
    ).transport.request({ type: 'get_state' });
    expect((state.data as { fakeApprovalMode?: string }).fakeApprovalMode).toBe('yolo');
    await session.close();
  });

  it('negotiates protocol v2 and reassembles rpc_chunk frames (WBS 2.1.1)', async () => {
    const { session, events } = await openWith('[bigframe] 큰 프레임');
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn_completed')).toBe(true);
    });
    const bigDelta = events.find(
      (e): e is Extract<AgentEvent, { type: 'message_delta' }> =>
        e.type === 'message_delta' && e.delta.length >= 1_500_000,
    );
    expect(bigDelta).toBeDefined();
    expect(bigDelta!.delta).toBe('x'.repeat(1_500_000));
    await session.close();
  });

  it('falls back to protocol v1 when negotiation is rejected (COMPAT)', async () => {
    const { session, events } = await openWith('일반 턴', { env: { FAKE_OMP_NO_V2: '1' } });
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn_completed')).toBe(true);
    });
    await session.close();
  });

  it('degrades ui requests by auto-cancelling instead of mediating (§4 결정)', async () => {
    const { session, events } = await openWith('[uiconfirm] 확인 요청');
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn_completed')).toBe(true);
    });
    // 승인 이벤트는 발행되지 않아야 한다 — 격하 확인은 fake 가 취소 응답 수신 시 턴을 잇는 것으로 증명
    expect(events.some((e) => e.type === 'permission_requested')).toBe(false);
    const state = await (
      session as unknown as {
        transport: { request(c: Record<string, unknown>): Promise<{ data?: unknown }> };
      }
    ).transport.request({ type: 'get_state' });
    expect((state.data as { fakeUiCancelled?: boolean }).fakeUiCancelled).toBe(true);
    await session.close();
  });

  it('rejects permission responses as unsupported (silent no-op 금지)', async () => {
    const { session } = await openWith(undefined);
    expect(await session.getPendingPermissions()).toEqual([]);
    await expect(session.respondToPermission('x', { cancelled: true })).rejects.toMatchObject({
      kind: 'unsupported',
    });
    await session.close();
  });

  it('stores the native session file as the persistence handle (FR-1.3.2)', async () => {
    const { session } = await openWith(undefined);
    expect(session.describeHandle()).toMatchObject({
      harness: 'omp',
      nativeHandle: '/fake/sessions/omp-native.jsonl',
      metadata: { sessionId: 'omp-native-abc' },
    });
    await session.close();
  });

  it('resumes by passing --session and drops replayed events (WBS 2.1.2, FR-1.3.4)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-omp-'));
    const adapter = makeAdapter();
    const session = await adapter.resumeSession(
      { harness: 'omp', nativeHandle: '/persisted/sessions/prev.jsonl' },
      { ...baseConfig('omp-resume', cwd), env: { FAKE_OMP_REPLAY: '1' } },
    );
    const events: AgentEvent[] = [];
    session.subscribe((event) => events.push(event));
    expect(session.describeHandle().nativeHandle).toBe('/persisted/sessions/prev.jsonl');
    // 리플레이 잔향(message_delta·tool·agent_end)이 이벤트로 새지 않아야 한다
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events.filter((e) => e.type !== 'session_status_changed')).toEqual([]);
    // 첫 턴은 정상 수신
    await session.startTurn('재개 후 턴');
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn_completed')).toBe(true);
    });
    expect(events.some((e) => e.type === 'message_delta')).toBe(true);
    await session.close();
  });

  it('rejects session-scoped MCP injection (capability false — 무시 금지)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-omp-'));
    await expect(
      makeAdapter().createSession({
        ...baseConfig('omp-mcp', cwd),
        mcpServers: [{ name: 'x', command: '/bin/x' }],
      }),
    ).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('probes the executable version (omp/ 접두 제거)', async () => {
    const probe = await makeAdapter().probe();
    expect(probe).toMatchObject({ available: true, version: '17.3.8-fake' });
  });

  it('signals session error on abnormal process exit (FR-1.1.3)', async () => {
    const { session, events } = await openWith('[die] 비정상 종료 시나리오');
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'session_status_changed')).toBe(true);
    });
    expect(events.find((e) => e.type === 'session_status_changed')).toMatchObject({
      status: 'error',
      error: { kind: 'spawn' },
    });
    await session.close();
  });
});

describe('MCP 준비 완료 게이트 (WBS 7.2.3)', () => {
  /** 게이트 동작만 보려고 어댑터를 직접 만든다 — 대기 한도를 테스트 시간에 맞춘다 */
  function gatedAdapter(mcpReadyTimeoutMs: number): OmpAdapter {
    return new OmpAdapter({
      command: process.execPath,
      prependArgs: [fakeOmp],
      supervisor: new ProcessSupervisor({ gracePeriodMs: 500 }),
      responseTimeoutMs: 3000,
      readyTimeoutMs: 2000,
      mcpReadyTimeoutMs,
    });
  }

  async function openSession(env: Record<string, string>, mcpReadyTimeoutMs = 1500) {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-omp-gate-'));
    return gatedAdapter(mcpReadyTimeoutMs).createSession({
      sessionId: `omp-gate-${Math.random().toString(36).slice(2)}`,
      cwd,
      env,
      approvalPolicy: 'mediate',
    });
  }

  it('1턴째는 기다리지 않는다 — 로딩을 시작시키는 것이 이 턴이다', async () => {
    // MCP 가 영원히 안 뜨는 설정인데도 1턴째가 즉시 나가야 한다
    const session = await openSession({}, 5000);
    const started = Date.now();
    await session.startTurn('첫 턴');
    expect(Date.now() - started).toBeLessThan(1000);
    await session.close();
  });

  it('2턴째는 준비될 때까지 기다렸다가 나간다', async () => {
    const session = await openSession({ FAKE_OMP_MCP_AFTER_TURNS: '1' });
    await session.startTurn('첫 턴');
    await session.startTurn('둘째 턴');
    // 게이트가 준비를 확인했으므로 이후 조회는 캐시로 즉시 참이다
    expect(await (session as unknown as { hasMcpTools(): Promise<boolean> }).hasMcpTools()).toBe(
      true,
    );
    await session.close();
  });

  it('준비되지 않아도 한도를 넘기면 턴은 나간다 — 막지 않는다', async () => {
    // 역방향 툴 없는 턴이 턴이 아예 없는 것보다 낫다
    const session = await openSession({}, 600);
    await session.startTurn('첫 턴');
    const started = Date.now();
    const turn = await session.startTurn('둘째 턴');
    const elapsed = Date.now() - started;
    expect(turn.turnId).toBeTruthy();
    expect(elapsed).toBeGreaterThanOrEqual(500); // 기다리긴 했다
    expect(elapsed).toBeLessThan(3000); // 그러나 무한정은 아니다
    await session.close();
  });
});
