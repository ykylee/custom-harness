// 어댑터 계약 공유 스위트 (WBS 1.3.4, test-strategy §1)
// 전 계약 메서드·이벤트를 mock 하네스와 실제 어댑터 양쪽에 동일하게 실행한다.
// 테스트 전용 헬퍼 — 런타임 export 아님 (*.test.ts 에서만 import).
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@custom-harness/protocol';
import type { AgentAdapter, AgentSession, SessionConfig } from './contract.js';

export interface AdapterHarness {
  adapter: AgentAdapter;
  makeConfig(sessionId: string): SessionConfig;
}

class EventCollector {
  readonly events: AgentEvent[] = [];
  constructor(session: AgentSession) {
    session.subscribe((event) => this.events.push(event));
  }

  async waitFor(type: AgentEvent['type'], timeoutMs = 3000): Promise<AgentEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.find((e) => e.type === type);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `이벤트 대기 타임아웃: ${type} (수신: ${this.events.map((e) => e.type).join(',')})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

export interface ContractSuiteOptions {
  /** runtimePermission capability 가 false 인 어댑터는 승인 중재 테스트를 건너뛴다 (§4 결정) */
  permissionMediation?: boolean;
  /**
   * 승인 거부가 턴을 취소하는가 — pi/mock 은 true(aborted), grok 은 false
   * (실측: 거부는 툴만 실패시키고 모델이 거부를 안고 턴을 완결한다)
   */
  rejectionCancelsTurn?: boolean;
}

export function runAdapterContractTests(
  name: string,
  factory: () => Promise<AdapterHarness>,
  options: ContractSuiteOptions = {},
): void {
  const { permissionMediation = true, rejectionCancelsTurn = true } = options;
  describe(`adapter contract: ${name}`, () => {
    let counter = 0;
    async function openSession(): Promise<{
      adapter: AgentAdapter;
      session: AgentSession;
      collector: EventCollector;
    }> {
      const { adapter, makeConfig } = await factory();
      counter += 1;
      const session = await adapter.createSession(makeConfig(`contract-${name}-${counter}`));
      return { adapter, session, collector: new EventCollector(session) };
    }

    it('probe reports availability', async () => {
      const { adapter } = await factory();
      const probe = await adapter.probe();
      expect(probe.available).toBe(true);
      expect(Array.isArray(probe.warnings)).toBe(true);
    });

    it('createSession yields a handle owned by this harness (FR-1.3.2)', async () => {
      const { adapter, session } = await openSession();
      expect(session.describeHandle().harness).toBe(adapter.id);
      await session.close();
    });

    it('runs a full turn: deltas → tool events → turn_completed with usage (FR-1.4)', async () => {
      const { session, collector } = await openSession();
      const { turnId } = await session.startTurn('파일 하나 수정해줘');
      const completed = await collector.waitFor('turn_completed');
      expect(completed).toMatchObject({ turnId, usage: { totalTokens: 15 } });

      const types = collector.events.map((e) => e.type);
      expect(types).toContain('message_delta');
      expect(types).toContain('reasoning_delta');
      const started = await collector.waitFor('tool_execution_started');
      expect(started).toMatchObject({ kind: 'shell', toolName: 'bash' });
      const toolDone = await collector.waitFor('tool_execution_completed');
      expect(toolDone).toMatchObject({ ok: true });
      // 어댑터는 turn_started 를 발행하지 않는다 — 데몬 소유 (FR-1.4)
      expect(types).not.toContain('turn_started');
      await session.close();
    });

    it('maps an unknown tool to other while preserving the native name (FR-1.2.5)', async () => {
      const { session, collector } = await openSession();
      await session.startTurn('[tool:quantum_flux] 미지 툴 실행');
      const started = await collector.waitFor('tool_execution_started');
      expect(started).toMatchObject({ kind: 'other', toolName: 'quantum_flux' });
      await collector.waitFor('turn_completed');
      await session.close();
    });

    it('surfaces a failing turn as turn_failed', async () => {
      const { session, collector } = await openSession();
      const { turnId } = await session.startTurn('[fail] 실패 시나리오');
      const failed = await collector.waitFor('turn_failed');
      expect(failed).toMatchObject({ turnId });
      await session.close();
    });

    it('interrupt is idempotent and cancels an active turn (FR-1.6)', async () => {
      const { session, collector } = await openSession();
      await session.interrupt(); // 활성 턴 없음 — 에러 없이 완료
      const { turnId } = await session.startTurn('[wait] 오래 걸리는 작업');
      await collector.waitFor('message_delta');
      await session.interrupt();
      expect(await collector.waitFor('turn_canceled')).toMatchObject({ turnId });
      await session.interrupt(); // 취소 후 재호출도 에러 없음
      await session.close();
    });

    it.runIf(permissionMediation)(
      'mediates a permission request and resumes on allow (FR-1.5)',
      async () => {
        const { session, collector } = await openSession();
        await session.startTurn('[approval] 승인이 필요한 작업');
        const requested = await collector.waitFor('permission_requested');
        if (requested.type !== 'permission_requested') throw new Error('unreachable');
        const request = requested.request;
        expect((await session.getPendingPermissions()).map((p) => p.requestId)).toContain(
          request.requestId,
        );

        const allow = request.options.find((o) => o.kind === 'allow_once');
        expect(allow).toBeDefined();
        await session.respondToPermission(request.requestId, { optionId: allow!.optionId });
        await collector.waitFor('permission_resolved');
        expect(await session.getPendingPermissions()).toEqual([]);
        await collector.waitFor('turn_completed');
        await session.close();
      },
    );

    it.runIf(permissionMediation)('resolves the turn when the permission is rejected', async () => {
      const { session, collector } = await openSession();
      await session.startTurn('[approval] 승인이 필요한 작업');
      const requested = await collector.waitFor('permission_requested');
      if (requested.type !== 'permission_requested') throw new Error('unreachable');
      const reject = requested.request.options.find((o) => o.kind === 'reject_once');
      expect(reject).toBeDefined();
      await session.respondToPermission(requested.request.requestId, {
        optionId: reject!.optionId,
      });
      // pi/mock: 거부 = 턴 취소. grok: 거부는 툴만 실패, 모델이 안고 턴 완결 (실측)
      await collector.waitFor(rejectionCancelsTurn ? 'turn_canceled' : 'turn_completed');
      await session.close();
    });

    it('switches models via the capability path (silent no-op 금지)', async () => {
      const { adapter, session } = await openSession();
      expect(adapter.capabilities.modelSwitch).toBe(true);
      expect(session.setModel).toBeDefined();
      await session.setModel!('prov/model-x');
      await session.close();
    });
  });
}
