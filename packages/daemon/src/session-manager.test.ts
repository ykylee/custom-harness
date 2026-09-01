import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@custom-harness/protocol';
import { FakeAdapter, type FakeSession } from './adapters/testing.js';
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

  /**
   * emit 체인(영속화+팬아웃)이 **멎을 때까지** 기다린다.
   *
   * 고정 sleep 으로는 부하가 걸린 실행에서 마지막 이벤트를 놓친다(실측: 전체 스위트 병렬
   * 실행 중 간헐 실패). 길이가 두 번 연속 같을 때를 '정지'로 본다.
   */
  async function settled(): Promise<void> {
    let previous = -1;
    await vi.waitFor(
      () => {
        const current = events.length;
        const stable = current > 0 && current === previous;
        previous = current;
        expect(stable).toBe(true);
      },
      { timeout: 5000, interval: 15 },
    );
  }

  describe('서브에이전트 위임 — 대기·회수 (M7 7.3.1)', () => {
    /** 턴을 띄운 세션 하나 */
    async function running(): Promise<{ sessionId: string; session: FakeSession }> {
      const summary = await manager.createSession({ harness: 'mock', cwd: process.cwd() });
      await manager.prompt(summary.sessionId, '작업해라');
      return { sessionId: summary.sessionId, session: adapter.sessions.at(-1)! };
    }

    it('활성 턴이 없으면 즉시 돌아온다 — 보내기 전에 물어도 같은 답', async () => {
      const summary = await manager.createSession({ harness: 'mock', cwd: process.cwd() });
      const waited = await manager.waitForTurn(summary.sessionId, { timeoutMs: 5000 });
      expect(waited).toMatchObject({ activeTurn: false, timedOut: false, status: 'idle' });
      expect(waited.lastTurnOutcome).toBeUndefined(); // 한 번도 돈 적이 없다
      await settled();
    });

    it('턴이 끝나면 대기가 풀린다', async () => {
      const { sessionId, session } = await running();
      const pending = manager.waitForTurn(sessionId, { timeoutMs: 5000 });
      session.emit({ type: 'turn_completed', turnId: session.lastTurnId! });
      const waited = await pending;
      expect(waited).toMatchObject({
        activeTurn: false,
        timedOut: false,
        lastTurnOutcome: 'completed',
      });
      await settled();
    });

    it('상한을 넘으면 timedOut 으로 돌아온다 — 끊지 않는다', async () => {
      const { sessionId } = await running();
      const waited = await manager.waitForTurn(sessionId, { timeoutMs: 20 });
      expect(waited).toMatchObject({ activeTurn: true, timedOut: true });
      await settled();
    });

    it('턴 실패·중단도 대기를 푼다', async () => {
      const failed = await running();
      const pendingFail = manager.waitForTurn(failed.sessionId, { timeoutMs: 5000 });
      failed.session.emit({
        type: 'turn_failed',
        turnId: failed.session.lastTurnId!,
        error: { kind: 'protocol', message: '깨짐' },
      });
      expect((await pendingFail).lastTurnOutcome).toBe('failed');

      const canceled = await running();
      const pendingCancel = manager.waitForTurn(canceled.sessionId, { timeoutMs: 5000 });
      await manager.interrupt(canceled.sessionId);
      expect((await pendingCancel).lastTurnOutcome).toBe('canceled');
      await settled();
    });

    it('세션이 닫히거나 오류로 죽어도 대기가 풀린다 — 매달리는 경로를 남기지 않는다', async () => {
      const closing = await running();
      const pendingClose = manager.waitForTurn(closing.sessionId, { timeoutMs: 5000 });
      await manager.closeSession(closing.sessionId);
      expect((await pendingClose).timedOut).toBe(false);

      const dying = await running();
      const pendingDeath = manager.waitForTurn(dying.sessionId, { timeoutMs: 5000 });
      dying.session.emit({ type: 'session_status_changed', status: 'error' });
      expect((await pendingDeath).timedOut).toBe(false);
      await settled();
    });

    it('결과 회수는 마지막 턴의 본문만 잇는다', async () => {
      const { sessionId, session } = await running();
      session.emit({ type: 'message_delta', delta: '앞' });
      session.emit({ type: 'message_delta', delta: '뒤' });
      session.emit({
        type: 'turn_completed',
        turnId: session.lastTurnId!,
        usage: { totalTokens: 42 },
      });
      await settled();

      // 두 번째 턴 — 첫 턴 본문이 섞이면 안 된다
      await manager.prompt(sessionId, '또');
      session.emit({ type: 'message_delta', delta: '둘째' });
      session.emit({ type: 'turn_completed', turnId: session.lastTurnId! });
      await settled();

      const result = await manager.lastTurnResult(sessionId);
      expect(result.text).toBe('둘째');
      expect(result).toMatchObject({ outcome: 'completed', pending: false });
    });

    it('진행 중이면 pending 이고 지금까지 온 본문을 준다', async () => {
      const { sessionId, session } = await running();
      session.emit({ type: 'message_delta', delta: '쓰는 중' });
      await settled();
      const result = await manager.lastTurnResult(sessionId);
      expect(result).toMatchObject({ pending: true, text: '쓰는 중' });
      expect(result.outcome).toBeUndefined();
    });

    it('실패한 턴은 사유를 싣는다', async () => {
      const { sessionId, session } = await running();
      session.emit({
        type: 'turn_failed',
        turnId: session.lastTurnId!,
        error: { kind: 'protocol', message: '게이트웨이 거절' },
      });
      await settled();
      const result = await manager.lastTurnResult(sessionId);
      expect(result).toMatchObject({ outcome: 'failed', error: '게이트웨이 거절' });
    });

    it('턴이 한 번도 없던 세션은 빈 결과다', async () => {
      const summary = await manager.createSession({ harness: 'mock', cwd: process.cwd() });
      expect(await manager.lastTurnResult(summary.sessionId)).toMatchObject({
        text: '',
        pending: false,
      });
      await settled();
    });
  });

  describe('위임 비용 합산 (M7 7.3.2)', () => {
    /** 세션 하나를 만들고 턴 1회로 사용량을 심는다 */
    async function spend(totalTokens: number, labels?: Record<string, string>): Promise<string> {
      const summary = await manager.createSession({
        harness: 'mock',
        cwd: process.cwd(),
        ...(labels !== undefined ? { labels } : {}),
      });
      const session = adapter.sessions.at(-1)!;
      await manager.prompt(summary.sessionId, '작업');
      session.emit({
        type: 'turn_completed',
        turnId: session.lastTurnId!,
        usage: { totalTokens, inputTokens: totalTokens },
      });
      await settled();
      return summary.sessionId;
    }

    const child = (parent: string, depth = 1): Record<string, string> => ({
      'ch.parentSessionId': parent,
      'ch.toolDepth': String(depth),
    });

    it('자손까지 합산하고 자기 사용량과 나눠 준다', async () => {
      const parent = await spend(10);
      const childA = await spend(20, child(parent));
      await spend(5, child(childA, 2)); // 손자 — 부모의 subtree 에 들어와야 한다

      const usage = await manager.usageTree(parent);
      expect(usage.own.totalTokens).toBe(10);
      expect(usage.subtree.totalTokens).toBe(35); // 10 + 20 + 5
      expect(usage.childCount).toBe(1);
      // 자식별 내역은 그 자식의 자손까지 포함한다 — 어느 가지가 비싼지 보여야 한다
      expect(usage.children[0]).toMatchObject({ sessionId: childA });
      expect(usage.children[0]!.subtree.totalTokens).toBe(25);
      expect(usage.children[0]!.usage?.totalTokens).toBe(20);
    });

    it('닫힌 자식은 활성 수에서 빠지되 합산에는 남는다 — 쓴 토큰은 사라지지 않는다', async () => {
      const parent = await spend(10);
      const alive = await spend(1, child(parent));
      const closed = await spend(7, child(parent));
      await manager.closeSession(closed);
      await settled();

      const usage = await manager.usageTree(parent);
      expect(usage.childCount).toBe(2);
      expect(usage.activeChildCount).toBe(1); // 팬아웃 상한이 세는 값
      expect(usage.subtree.totalTokens).toBe(18); // 10 + 1 + 7
      expect(usage.children.map((c) => c.sessionId).sort()).toEqual([alive, closed].sort());
    });

    it('자식이 없으면 subtree 는 own 과 같다', async () => {
      const lone = await spend(3);
      const usage = await manager.usageTree(lone);
      expect(usage.subtree).toEqual(usage.own);
      expect(usage).toMatchObject({ childCount: 0, activeChildCount: 0 });
    });

    it('라벨이 순환해도 멎는다 — 손으로 고친 meta 하나가 데몬을 세우면 안 된다', async () => {
      // 순환은 정상 경로로 만들 수 없다(자식은 부모보다 늦게 생긴다). meta 를 직접 써서
      // "누군가 손으로 고쳤다"를 재현한 뒤 복원한다 — 방어의 대상이 그 상황이다.
      const now = new Date().toISOString();
      const base = { harness: 'mock' as const, cwd: process.cwd(), createdAt: now, updatedAt: now };
      await store.writeMeta({
        ...base,
        sessionId: 'cyc-a',
        status: 'idle',
        labels: child('cyc-b', 2),
        usageTotals: { totalTokens: 4 },
      });
      await store.writeMeta({
        ...base,
        sessionId: 'cyc-b',
        status: 'idle',
        labels: child('cyc-a'),
        usageTotals: { totalTokens: 6 },
      });
      const restored = new SessionManager({ store, adapters: [adapter] });
      await restored.init();

      const usage = await restored.usageTree('cyc-a');
      expect(usage.subtree.totalTokens).toBe(10); // 각 노드를 한 번씩만 센다
    });

    it('보고되지 않은 항목은 0 으로 채우지 않는다 — "안 씀"과 "모름"이 섞이면 안 된다', async () => {
      const parent = await spend(10);
      // 사용량을 한 번도 보고하지 않은 자식
      const quiet = await manager.createSession({
        harness: 'mock',
        cwd: process.cwd(),
        labels: child(parent),
      });
      expect(quiet).toBeDefined();
      const usage = await manager.usageTree(parent);
      expect(usage.children[0]!.usage).toBeUndefined();
      expect(usage.subtree.outputTokens).toBeUndefined(); // 아무도 보고한 적 없다
      expect(usage.subtree.totalTokens).toBe(10);
      await settled();
    });
  });

  describe('역방향 툴 승인 채널 (M7 7.2.4)', () => {
    it('요청이 하네스 승인과 같은 채널로 나가고, 허용하면 true 로 풀린다', async () => {
      const session = await manager.createSession({ harness: 'mock', cwd: process.cwd() });
      const pending = manager.requestReverseToolApproval({
        sessionId: session.sessionId,
        summary: '다른 에이전트가 터미널에 입력하려 한다',
      });
      await settled();

      const requested = events.find((event) => event.type === 'permission_requested');
      expect(requested).toBeDefined();
      const request = (requested as { request: { requestId: string; origin?: string } }).request;
      // 출처가 실려야 UI 가 "하네스가 물었다"와 "데몬이 물었다"를 구분할 수 있다
      expect(request.origin).toBe('reverse_tool');

      // 조회 경로에도 나온다 — 재접속한 클라이언트가 대기 중임을 알아야 한다
      const listed = (await manager.listSessions()).find((s) => s.sessionId === session.sessionId);
      expect(listed?.pendingPermissions?.map((p) => p.requestId)).toContain(request.requestId);
      expect(listed?.requiresAttention).toBe(true);

      await manager.respondPermission(session.sessionId, request.requestId, {
        optionId: 'allow',
      });
      await expect(pending).resolves.toBe(true);
      await settled();
    });

    it('거부하면 false 로 풀리고 대기 목록에서 사라진다', async () => {
      const session = await manager.createSession({ harness: 'mock', cwd: process.cwd() });
      const pending = manager.requestReverseToolApproval({
        sessionId: session.sessionId,
        summary: '중단하려 한다',
      });
      await settled();
      const request = (
        events.find((event) => event.type === 'permission_requested') as {
          request: { requestId: string };
        }
      ).request;

      await manager.respondPermission(session.sessionId, request.requestId, { optionId: 'deny' });
      await expect(pending).resolves.toBe(false);
      const listed = (await manager.listSessions()).find((s) => s.sessionId === session.sessionId);
      expect(listed?.pendingPermissions ?? []).toHaveLength(0);
      await settled();
    });

    it('만료는 거부다 — 무응답을 승인으로 해석하지 않는다', async () => {
      const session = await manager.createSession({ harness: 'mock', cwd: process.cwd() });
      await expect(
        manager.requestReverseToolApproval({
          sessionId: session.sessionId,
          summary: '자리를 비운 사이',
          timeoutMs: 10,
        }),
      ).resolves.toBe(false);
      // 리스너가 모듈 변수 `events` 를 클로저로 잡으므로, 늦게 도착한 이벤트는 **다음
      // 테스트의** 배열로 들어간다. 세션을 만든 테스트는 끝나기 전에 흘려보낸다
      await settled();
    });

    it('생성 라벨이 조회에 그대로 실린다 — 재귀 깊이의 근거', async () => {
      const session = await manager.createSession({
        harness: 'mock',
        cwd: process.cwd(),
        labels: { 'ch.toolDepth': '1', 'ch.parentSessionId': 'parent' },
      });
      const listed = (await manager.listSessions()).find((s) => s.sessionId === session.sessionId);
      expect(listed?.labels).toEqual({ 'ch.toolDepth': '1', 'ch.parentSessionId': 'parent' });
      await settled();
    });
  });

  it('creates a session: initializing → idle, meta+handle persisted (FR-1.3.5)', async () => {
    const summary = await manager.createSession({ harness: 'mock', cwd: process.cwd() });
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
    await expect(manager.createSession({ harness: 'mock', cwd: process.cwd() })).rejects.toThrow(
      'fake create failure',
    );
    const [summary] = await manager.listSessions();
    expect(summary?.status).toBe('error');
  });

  it('enforces the concurrent session cap (daemon-design §4)', async () => {
    const capped = new SessionManager({ store, adapters: [adapter], maxSessions: 1 });
    await capped.init();
    await capped.createSession({ harness: 'mock', cwd: process.cwd() });
    await expect(
      capped.createSession({ harness: 'mock', cwd: process.cwd() }),
    ).rejects.toMatchObject({
      code: 'session_limit',
    });
  });

  it('emits manager-owned user_message + turn_started on prompt (FR-1.4)', async () => {
    const { sessionId } = await manager.createSession({ harness: 'mock', cwd: process.cwd() });
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
      'attention_changed', // 턴 종료 → 확인 필요 (M7 7.1.2)
    ]);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    // 타임라인 영속화 동일 순서 (FR-1.3.1)
    expect((await manager.timeline(sessionId)).map((e) => e.type)).toEqual(types);

    const [summary] = await manager.listSessions();
    expect(summary?.status).toBe('idle');
    // 완료 후 새 턴 허용
    await expect(manager.prompt(sessionId, '다음')).resolves.toMatchObject({ turnId: 'turn-2' });
  });

  it('rejects a second prompt while a turn is active — 큐잉 없이 거부', async () => {
    const { sessionId } = await manager.createSession({ harness: 'mock', cwd: process.cwd() });
    await manager.prompt(sessionId, '첫 턴');
    await expect(manager.prompt(sessionId, '둘째 턴')).rejects.toMatchObject({ code: 'busy' });
  });

  it('interrupt is idempotent (FR-1.6)', async () => {
    const { sessionId } = await manager.createSession({ harness: 'mock', cwd: process.cwd() });
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
    const { sessionId } = await manager.createSession({ harness: 'mock', cwd: process.cwd() });
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

  // ── 주의 상태 1급화 (M7 7.1.1·7.1.2, FR-9.1) ────────────────────────────

  it('턴 종료가 주의 상태를 세우고 목록·이벤트에 함께 실린다', async () => {
    const { sessionId } = await manager.createSession({ harness: 'mock', cwd: process.cwd() });
    const { turnId } = await manager.prompt(sessionId, '해줘');
    adapter.sessions[0]!.emit({ type: 'turn_completed', turnId });
    await settled();

    const changed = events.filter((e) => e.type === 'attention_changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ requiresAttention: true, attentionReason: 'finished' });
    // 재접속 조회 경로 — 목록에 그대로 실린다
    const [summary] = await manager.listSessions();
    expect(summary).toMatchObject({ requiresAttention: true, attentionReason: 'finished' });
    expect(typeof summary?.attentionTimestamp).toBe('string');
  });

  it('확인 처리(ack)는 완료 주의를 지우고 이벤트를 1번만 낸다 — 멱등', async () => {
    const { sessionId } = await manager.createSession({ harness: 'mock', cwd: process.cwd() });
    const { turnId } = await manager.prompt(sessionId, '해줘');
    adapter.sessions[0]!.emit({ type: 'turn_completed', turnId });
    await settled();

    manager.acknowledgeAttention(sessionId);
    manager.acknowledgeAttention(sessionId); // 두 번 불러도 변화는 1회
    await settled();
    expect(events.filter((e) => e.type === 'attention_changed')).toHaveLength(2);
    const [summary] = await manager.listSessions();
    expect(summary?.requiresAttention).toBe(false);
  });

  it('승인 대기는 확인 처리로 사라지지 않는다 — 화면을 본 것이 응답은 아니다', async () => {
    const { sessionId } = await manager.createSession({ harness: 'mock', cwd: process.cwd() });
    adapter.sessions[0]!.emit({
      type: 'permission_requested',
      request: {
        requestId: 'p-1',
        kind: 'shell',
        summary: 'rm 실행',
        options: [{ optionId: 'o-1', label: '허용', kind: 'allow_once' }],
      },
    });
    await settled();
    manager.acknowledgeAttention(sessionId);
    await settled();

    const [summary] = await manager.listSessions();
    expect(summary).toMatchObject({ requiresAttention: true, attentionReason: 'permission' });

    // 승인에 응답하면 비로소 풀린다
    await manager.respondPermission(sessionId, 'p-1', { optionId: 'o-1' });
    await settled();
    expect((await manager.listSessions())[0]?.requiresAttention).toBe(false);
  });

  it('새 프롬프트는 주의 상태를 해제한다 — 사용자가 붙어 있다', async () => {
    const { sessionId } = await manager.createSession({ harness: 'mock', cwd: process.cwd() });
    const first = await manager.prompt(sessionId, '하나');
    adapter.sessions[0]!.emit({ type: 'turn_completed', turnId: first.turnId });
    await settled();
    expect((await manager.listSessions())[0]?.requiresAttention).toBe(true);

    await manager.prompt(sessionId, '둘');
    await settled();
    expect((await manager.listSessions())[0]?.requiresAttention).toBe(false);
  });

  it('데몬 재기동 후에도 주의 상태가 그대로 조회된다 (클라이언트 부재 구간)', async () => {
    const { sessionId } = await manager.createSession({ harness: 'mock', cwd: process.cwd() });
    const { turnId } = await manager.prompt(sessionId, '해줘');
    adapter.sessions[0]!.emit({ type: 'turn_completed', turnId });
    await settled();

    // 같은 저장소 위에 새 매니저를 세운다 = 데몬 재기동
    const restarted = new SessionManager({ store, adapters: [new FakeAdapter()] });
    await restarted.init();
    const [summary] = await restarted.listSessions();
    expect(summary).toMatchObject({
      sessionId,
      requiresAttention: true,
      attentionReason: 'finished',
    });
  });

  it('rejects model switch when unsupported — silent 실패 금지', async () => {
    const { sessionId } = await manager.createSession({ harness: 'mock', cwd: process.cwd() });
    await manager.setModel(sessionId, 'mock-model-2');
    expect(adapter.sessions[0]!.modelSet).toBe('mock-model-2');

    (adapter.capabilities as Record<string, boolean>).modelSwitch = false;
    await expect(manager.setModel(sessionId, 'x')).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('restarts: stale active statuses become closed, resume restores pending + seq (FR-1.3)', async () => {
    const { sessionId } = await manager.createSession({ harness: 'mock', cwd: process.cwd() });
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
    const { sessionId } = await manager.createSession({ harness: 'mock', cwd: process.cwd() });
    await manager.closeSession(sessionId);
    expect(adapter.sessions[0]!.closed).toBe(true);
    const [summary] = await manager.listSessions();
    expect(summary?.status).toBe('closed');
    await expect(manager.prompt(sessionId, 'x')).rejects.toMatchObject({ code: 'bad_request' });
    expect((await manager.timeline(sessionId)).length).toBeGreaterThan(0);
  });
});
