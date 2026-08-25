import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@custom-harness/protocol';
import { FakeAdapter } from './adapters/testing.js';
import { SessionManager } from './session-manager.js';
import { SessionStore } from './store.js';

describe('SessionManager', () => {
  let store: SessionStore;
  let adapter: FakeAdapter;
  let manager: SessionManager;
  let events: SessionEvent[];

  beforeEach(async () => {
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'ch-mgr-')));
    adapter = new FakeAdapter();
    manager = new SessionManager({ store, adapters: [adapter] });
    await manager.init();
    events = [];
    manager.onEvent((event) => events.push(event));
  });

  async function settled(): Promise<void> {
    // emit 체인(영속화+팬아웃)이 비워질 때까지
    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  it('creates a session: initializing → idle, meta+handle persisted (FR-1.3.5)', async () => {
    const summary = await manager.createSession({ harness: 'mock', cwd: '/work' });
    expect(summary.status).toBe('idle');
    await settled();

    expect(events.map((e) => e.type)).toEqual(['session_status_changed', 'session_status_changed']);
    expect(events.map((e) => e.seq)).toEqual([0, 1]);

    const meta = await store.readMeta(summary.sessionId);
    expect(meta?.status).toBe('idle');
    expect(meta?.handle).toEqual({ harness: 'mock', nativeHandle: `native-${summary.sessionId}` });
  });

  it('marks the session error when the adapter fails to create', async () => {
    adapter.failNextCreate = true;
    await expect(manager.createSession({ harness: 'mock', cwd: '/w' })).rejects.toThrow(
      'fake create failure',
    );
    const [summary] = await manager.listSessions();
    expect(summary?.status).toBe('error');
  });

  it('enforces the concurrent session cap (daemon-design §4)', async () => {
    const capped = new SessionManager({ store, adapters: [adapter], maxSessions: 1 });
    await capped.init();
    await capped.createSession({ harness: 'mock', cwd: '/w' });
    await expect(capped.createSession({ harness: 'mock', cwd: '/w' })).rejects.toMatchObject({
      code: 'session_limit',
    });
  });

  it('emits manager-owned user_message + turn_started on prompt (FR-1.4)', async () => {
    const { sessionId } = await manager.createSession({ harness: 'mock', cwd: '/w' });
    const { turnId } = await manager.prompt(sessionId, '파일 고쳐줘');
    const session = adapter.sessions[0]!;
    session.emit({ type: 'message_delta', turnId, delta: '네' });
    session.emit({ type: 'turn_completed', turnId });
    await settled();

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'session_status_changed', // initializing
      'session_status_changed', // idle
      'user_message',
      'turn_started',
      'session_status_changed', // running
      'message_delta',
      'turn_completed',
      'session_status_changed', // idle
    ]);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // 타임라인 영속화 동일 순서 (FR-1.3.1)
    expect((await manager.timeline(sessionId)).map((e) => e.type)).toEqual(types);

    const [summary] = await manager.listSessions();
    expect(summary?.status).toBe('idle');
    // 완료 후 새 턴 허용
    await expect(manager.prompt(sessionId, '다음')).resolves.toMatchObject({ turnId: 'turn-2' });
  });

  it('rejects a second prompt while a turn is active — 큐잉 없이 거부', async () => {
    const { sessionId } = await manager.createSession({ harness: 'mock', cwd: '/w' });
    await manager.prompt(sessionId, '첫 턴');
    await expect(manager.prompt(sessionId, '둘째 턴')).rejects.toMatchObject({ code: 'busy' });
  });

  it('interrupt is idempotent (FR-1.6)', async () => {
    const { sessionId } = await manager.createSession({ harness: 'mock', cwd: '/w' });
    // 활성 턴 없음 — 에러 없이 완료, 어댑터 호출도 없음
    await manager.interrupt(sessionId);
    expect(adapter.sessions[0]!.interruptCalls).toBe(0);

    await manager.prompt(sessionId, '작업');
    await manager.interrupt(sessionId); // fake 가 turn_canceled 발행
    await settled();
    expect(adapter.sessions[0]!.interruptCalls).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: 'session_status_changed', status: 'idle' });
    await manager.interrupt(sessionId); // 다시 호출해도 no-op
    expect(adapter.sessions[0]!.interruptCalls).toBe(1);
  });

  it('tracks pending permissions and clears on resolution (FR-1.5)', async () => {
    const { sessionId } = await manager.createSession({ harness: 'mock', cwd: '/w' });
    const session = adapter.sessions[0]!;
    const request = {
      requestId: 'p-1',
      kind: 'shell' as const,
      summary: 'rm 실행',
      options: [{ optionId: 'o-1', label: '허용', kind: 'allow_once' as const }],
    };
    session.emit({ type: 'permission_requested', request });
    await settled();

    let [summary] = await manager.listSessions();
    expect(summary?.pendingPermissions).toEqual([request]);

    await expect(
      manager.respondPermission(sessionId, 'unknown', { optionId: 'o-1' }),
    ).rejects.toMatchObject({ code: 'not_found' });

    await manager.respondPermission(sessionId, 'p-1', { optionId: 'o-1' });
    await settled();
    [summary] = await manager.listSessions();
    expect(summary?.pendingPermissions).toBeUndefined();
  });

  it('rejects model switch when unsupported — silent 실패 금지', async () => {
    const { sessionId } = await manager.createSession({ harness: 'mock', cwd: '/w' });
    await manager.setModel(sessionId, 'mock-model-2');
    expect(adapter.sessions[0]!.modelSet).toBe('mock-model-2');

    (adapter.capabilities as Record<string, boolean>).modelSwitch = false;
    await expect(manager.setModel(sessionId, 'x')).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('restarts: stale active statuses become closed, resume restores pending + seq (FR-1.3)', async () => {
    const { sessionId } = await manager.createSession({ harness: 'mock', cwd: '/w' });
    const { turnId } = await manager.prompt(sessionId, '작업');
    adapter.sessions[0]!.emit({ type: 'turn_completed', turnId });
    await settled();
    const seqBefore = (await manager.listSessions())[0]!.seq;

    // 데몬 재기동 시뮬레이션 — 같은 store 로 새 매니저
    const adapter2 = new FakeAdapter();
    adapter2.pendingOnResume = [
      {
        requestId: 'p-9',
        kind: 'file_write',
        summary: 'a.ts 수정',
        options: [{ optionId: 'o-1', label: '허용', kind: 'allow_once' }],
      },
    ];
    const manager2 = new SessionManager({ store, adapters: [adapter2] });
    await manager2.init();

    let [summary] = await manager2.listSessions();
    expect(summary?.status).toBe('closed'); // running/idle 잔존 → closed 정정
    expect(summary?.seq).toBe(seqBefore);

    summary = await manager2.resumeSession(sessionId);
    expect(summary.status).toBe('idle');
    expect(adapter2.sessions[0]?.resumed).toBe(true);
    expect(summary.pendingPermissions?.[0]?.requestId).toBe('p-9');
    // seq 이어짐 — 재개 전이 이벤트가 이전 seq 다음부터
    expect(summary.seq).toBeGreaterThan(seqBefore);

    // 핸들 없는 세션은 재개 불가 안내 (FR-1.3.3 이력 열람은 가능)
    expect((await manager2.timeline(sessionId)).length).toBeGreaterThan(0);
  });

  it('close leaves data intact and prompt requires resume', async () => {
    const { sessionId } = await manager.createSession({ harness: 'mock', cwd: '/w' });
    await manager.closeSession(sessionId);
    expect(adapter.sessions[0]!.closed).toBe(true);
    const [summary] = await manager.listSessions();
    expect(summary?.status).toBe('closed');
    await expect(manager.prompt(sessionId, 'x')).rejects.toMatchObject({ code: 'bad_request' });
    expect((await manager.timeline(sessionId)).length).toBeGreaterThan(0);
  });
});
