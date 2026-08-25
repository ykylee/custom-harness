import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@custom-harness/protocol';
import { ProcessSupervisor } from '../../processes.js';
import { runAdapterContractTests, type AdapterHarness } from '../contract-suite.js';
import { PiAdapter, mapToolKind } from './pi.js';

const fakePi = fileURLToPath(new URL('./fake-pi.fixture.cjs', import.meta.url));

function makeAdapter(): PiAdapter {
  return new PiAdapter({
    command: process.execPath,
    prependArgs: [fakePi],
    supervisor: new ProcessSupervisor({ gracePeriodMs: 500 }),
    responseTimeoutMs: 3000,
  });
}

async function factory(): Promise<AdapterHarness> {
  const cwd = await mkdtemp(join(tmpdir(), 'ch-pi-'));
  return {
    adapter: makeAdapter(),
    makeConfig: (sessionId) => ({ sessionId, cwd, env: {}, approvalPolicy: 'mediate' }),
  };
}

// fake pi 는 실측 스키마(rpc-types 0.84.1)를 흉내낸다 — 계약 스위트를 mock 과 동일하게 통과해야 한다.
runAdapterContractTests('pi(fake)', factory);

describe('PiAdapter specifics', () => {
  const config = (sessionId: string, cwd: string) =>
    ({ sessionId, cwd, env: {}, approvalPolicy: 'mediate' }) as const;

  it('maps native tool names to neutral kinds (관대 테이블)', () => {
    expect(mapToolKind('bash')).toBe('shell');
    expect(mapToolKind('read')).toBe('read');
    expect(mapToolKind('grep')).toBe('search');
    expect(mapToolKind('quantum_flux')).toBe('other');
  });

  it('probes the executable version', async () => {
    const probe = await makeAdapter().probe();
    expect(probe).toMatchObject({ available: true, version: '0.84.1-fake' });
  });

  it('reports unavailable when the executable is missing', async () => {
    const adapter = new PiAdapter({
      command: '/nonexistent/pi',
      supervisor: new ProcessSupervisor(),
    });
    const probe = await adapter.probe();
    expect(probe.available).toBe(false);
    expect(probe.warnings.length).toBeGreaterThan(0);
  });

  it('stores the native session file as the persistence handle (FR-1.3.2)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-pi-'));
    const session = await makeAdapter().createSession(config('s-1', cwd));
    expect(session.describeHandle()).toMatchObject({
      harness: 'pi',
      nativeHandle: '/fake/sessions/native-abc.jsonl',
      metadata: { sessionId: 'native-abc' },
    });
    await session.close();
  });

  it('resumes by passing --session with the stored handle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-pi-'));
    const handlePath = '/persisted/sessions/prev.jsonl';
    const session = await makeAdapter().resumeSession(
      { harness: 'pi', nativeHandle: handlePath },
      config('s-2', cwd),
    );
    // fake pi 는 --session 인자를 get_state.sessionFile 로 되돌린다
    expect(session.describeHandle().nativeHandle).toBe(handlePath);
    await session.close();
  });

  it('rejects session-scoped MCP injection (capability false — 무시 금지)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-pi-'));
    await expect(
      makeAdapter().createSession({
        ...config('s-3', cwd),
        mcpServers: [{ name: 'x', command: '/bin/x' }],
      }),
    ).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('requires provider/id form for set_model', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-pi-'));
    const session = await makeAdapter().createSession(config('s-4', cwd));
    await expect(session.setModel!('no-slash')).rejects.toMatchObject({ kind: 'model' });
    await session.setModel!('gateway/grok-4.6');
    await session.close();
  });

  it('signals session error on abnormal process exit (FR-1.1.3)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-pi-'));
    const session = await makeAdapter().createSession(config('s-5', cwd));
    const events: AgentEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.startTurn('[die] 비정상 종료 시나리오');
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'session_status_changed')).toBe(true);
    });
    expect(events.find((e) => e.type === 'session_status_changed')).toMatchObject({
      status: 'error',
      error: { kind: 'spawn' },
    });
  });

  it('tolerates garbage lines and drops unknown events without dying (NFR-5)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-pi-'));
    const session = await makeAdapter().createSession(config('s-6', cwd));
    const events: AgentEvent[] = [];
    session.subscribe((event) => events.push(event));
    // fake pi 는 매 턴 비 JSON 줄 + mystery_event 를 주입한다 — 정상 완료가 곧 내성 증명
    await session.startTurn('내성 확인');
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn_completed')).toBe(true);
    });
    await session.close();
  });
});
