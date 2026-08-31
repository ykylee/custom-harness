import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@custom-harness/protocol';
import { ProcessSupervisor } from '../../processes.js';
import { runAdapterContractTests, type AdapterHarness } from '../contract-suite.js';
import { GrokAdapter, mapAcpToolKind, type GrokAdapterOptions } from './grok.js';

const fakeGrok = fileURLToPath(new URL('./fake-grok.fixture.cjs', import.meta.url));

function makeAdapter(options: Partial<GrokAdapterOptions> = {}): GrokAdapter {
  return new GrokAdapter({
    command: process.execPath,
    prependArgs: [fakeGrok],
    supervisor: new ProcessSupervisor({ gracePeriodMs: 500 }),
    responseTimeoutMs: 3000,
    ...options,
  });
}

const baseConfig = (sessionId: string, cwd: string, env: Record<string, string> = {}) =>
  ({ sessionId, cwd, env, approvalPolicy: 'mediate' }) as const;

async function factory(): Promise<AdapterHarness> {
  const cwd = await mkdtemp(join(tmpdir(), 'ch-grok-'));
  return {
    adapter: makeAdapter(),
    makeConfig: (sessionId) => baseConfig(sessionId, cwd),
  };
}

// fake grok 는 실측 스키마(grok 1.0.5 ACP)를 흉내낸다. 거부는 툴만 실패시키고
// 턴을 완결한다 (실측) — rejectionCancelsTurn: false.
runAdapterContractTests('grok(fake)', factory, { rejectionCancelsTurn: false });

async function openSession(
  env: Record<string, string> = {},
  options: Partial<GrokAdapterOptions> = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), 'ch-grok-'));
  const session = await makeAdapter(options).createSession(
    baseConfig(`grok-x-${Math.random().toString(36).slice(2)}`, cwd, env),
  );
  const events: AgentEvent[] = [];
  session.subscribe((event) => events.push(event));
  return { session, events, cwd };
}

describe('GrokAdapter specifics', () => {
  it('maps ACP tool kinds to neutral kinds (프로토콜 제공 kind)', () => {
    expect(mapAcpToolKind('execute')).toBe('shell');
    expect(mapAcpToolKind('edit')).toBe('edit');
    expect(mapAcpToolKind('think')).toBe('plan');
    expect(mapAcpToolKind('delete')).toBe('other');
    expect(mapAcpToolKind('unknown-kind')).toBe('other');
  });

  it('probes and verifies genuine grok output (비공식 CLI 충돌 대비)', async () => {
    const probe = await makeAdapter().probe();
    expect(probe).toMatchObject({ available: true, version: '1.0.5-fake' });

    const bogus = new GrokAdapter({
      command: process.execPath,
      prependArgs: [fakeGrok],
      supervisor: new ProcessSupervisor({ gracePeriodMs: 500 }),
    });
    const origEnv = process.env.FAKE_GROK_BOGUS;
    process.env.FAKE_GROK_BOGUS = '1';
    try {
      const result = await bogus.probe();
      expect(result.available).toBe(false);
      expect(result.warnings.join()).toContain('정품');
    } finally {
      if (origEnv === undefined) delete process.env.FAKE_GROK_BOGUS;
      else process.env.FAKE_GROK_BOGUS = origEnv;
    }
  });

  it('projects request_permission options verbatim (FR-1.5, WBS 2.2.3)', async () => {
    const { session, events } = await openSession();
    await session.startTurn('[approval] 승인 필요');
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'permission_requested')).toBe(true);
    });
    const requested = events.find(
      (e): e is Extract<AgentEvent, { type: 'permission_requested' }> =>
        e.type === 'permission_requested',
    )!;
    expect(requested.request).toMatchObject({
      kind: 'shell',
      summary: 'Execute `echo hi`',
      options: [
        { optionId: 'allow-once', label: 'Yes, proceed', kind: 'allow_once' },
        { optionId: 'reject-once', kind: 'reject_once' },
      ],
    });
    await session.respondToPermission(requested.request.requestId, { optionId: 'allow-once' });
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn_completed')).toBe(true);
    });
    await session.close();
  });

  it('stores the ACP sessionId + cwd as the persistence handle (FR-1.3.2)', async () => {
    const { session, cwd } = await openSession();
    expect(session.describeHandle()).toMatchObject({
      harness: 'grok',
      nativeHandle: 'grok-acp-session-1',
      metadata: { cwd },
    });
    await session.close();
  });

  it('resumes via session/load and drops the history replay (실측 — 응답 전 리플레이)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-grok-'));
    const session = await makeAdapter().resumeSession(
      { harness: 'grok', nativeHandle: 'prev-session-9', metadata: { cwd } },
      baseConfig('grok-resume', cwd),
    );
    const events: AgentEvent[] = [];
    session.subscribe((event) => events.push(event));
    expect(session.describeHandle().nativeHandle).toBe('prev-session-9');
    // 리플레이(과거 chunk·tool_call)가 이벤트로 새지 않아야 한다
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events.filter((e) => e.type !== 'session_status_changed')).toEqual([]);
    await session.startTurn('재개 후 턴');
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn_completed')).toBe(true);
    });
    expect(events.some((e) => e.type === 'message_delta')).toBe(true);
    await session.close();
  });

  it('emits usage from the prompt response _meta (FR-3.7 실측)', async () => {
    const { session, events } = await openSession();
    await session.startTurn('사용량 확인');
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn_completed')).toBe(true);
    });
    expect(events.find((e) => e.type === 'turn_completed')).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    await session.close();
  });

  it('signals session error on abnormal process exit (FR-1.1.3)', async () => {
    const { session, events } = await openSession();
    await session.startTurn('[die] 비정상 종료');
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'session_status_changed')).toBe(true);
    });
    expect(events.find((e) => e.type === 'session_status_changed')).toMatchObject({
      status: 'error',
      error: { kind: 'spawn' },
    });
    await session.close();
  });

  // WBS 7.2.0b — 권한 모드는 명시 고정한다. 미지정으로 두면 grok 이 사용자 환경에서
  // 모드를 주워오고(실측: Claude 호환 import), auto 모드가 승인 요청 없이 툴을 거절해
  // 승인 채널(FR-1.5)이 조용히 사라진다.
  it('spawns with --permission-mode default by default (WBS 7.2.0b)', async () => {
    const argvFile = join(await mkdtemp(join(tmpdir(), 'ch-grok-argv-')), 'argv.json');
    const { session } = await openSession({ FAKE_GROK_ARGV_FILE: argvFile });
    const argv = JSON.parse(await readFile(argvFile, 'utf8')) as string[];
    expect(argv).toEqual(['--permission-mode', 'default', 'agent', 'stdio']);
    await session.close();
  });

  it("omits the flag only for permissionMode: 'inherit' (WBS 7.2.0b)", async () => {
    const argvFile = join(await mkdtemp(join(tmpdir(), 'ch-grok-argv-')), 'argv.json');
    const { session } = await openSession(
      { FAKE_GROK_ARGV_FILE: argvFile },
      { permissionMode: 'inherit' },
    );
    expect(JSON.parse(await readFile(argvFile, 'utf8'))).toEqual(['agent', 'stdio']);
    await session.close();
  });

  it('honours an explicit permission mode (WBS 7.2.0b)', async () => {
    const argvFile = join(await mkdtemp(join(tmpdir(), 'ch-grok-argv-')), 'argv.json');
    const { session } = await openSession(
      { FAKE_GROK_ARGV_FILE: argvFile },
      { permissionMode: 'acceptEdits' },
    );
    expect(JSON.parse(await readFile(argvFile, 'utf8'))).toEqual([
      '--permission-mode',
      'acceptEdits',
      'agent',
      'stdio',
    ]);
    await session.close();
  });
});
