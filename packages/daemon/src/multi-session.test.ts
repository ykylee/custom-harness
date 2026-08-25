// 멀티 세션 통합 테스트 (WBS 2.3.1, FR-1.7) — 하네스 혼합 동시 세션 5개,
// 이벤트 스트림·영속화의 세션 스코프 격리를 검증한다.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent, SessionSummary } from '@custom-harness/protocol';
import { MockAdapter } from './adapters/mock.js';
import { PiAdapter } from './adapters/jsonl-rpc/pi.js';
import { OmpAdapter } from './adapters/jsonl-rpc/omp.js';
import { ProcessSupervisor } from './processes.js';
import { SessionManager } from './session-manager.js';
import { SessionStore } from './store.js';

const fakePi = fileURLToPath(new URL('./adapters/jsonl-rpc/fake-pi.fixture.cjs', import.meta.url));
const fakeOmp = fileURLToPath(
  new URL('./adapters/jsonl-rpc/fake-omp.fixture.cjs', import.meta.url),
);

describe('멀티 세션 (혼합 하네스)', () => {
  let store: SessionStore;
  let manager: SessionManager;
  let events: SessionEvent[];
  let cwd: string;

  beforeEach(async () => {
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'ch-multi-')));
    cwd = await mkdtemp(join(tmpdir(), 'ch-multi-cwd-'));
    const supervisor = new ProcessSupervisor({ gracePeriodMs: 500 });
    manager = new SessionManager({
      store,
      adapters: [
        new MockAdapter(),
        new PiAdapter({
          command: process.execPath,
          prependArgs: [fakePi],
          supervisor,
          responseTimeoutMs: 3000,
        }),
        new OmpAdapter({
          command: process.execPath,
          prependArgs: [fakeOmp],
          supervisor,
          responseTimeoutMs: 3000,
          readyTimeoutMs: 2000,
        }),
      ],
      maxSessions: 8,
    });
    await manager.init();
    events = [];
    manager.onEvent((event) => events.push(event));
  });

  it('runs 5 concurrent sessions across mock/pi/omp without interference (FR-1.7)', async () => {
    // 혼합 5개 동시 생성
    const sessions: SessionSummary[] = await Promise.all([
      manager.createSession({ harness: 'mock', cwd }),
      manager.createSession({ harness: 'mock', cwd }),
      manager.createSession({ harness: 'pi', cwd }),
      manager.createSession({ harness: 'pi', cwd }),
      manager.createSession({ harness: 'omp', cwd }),
    ]);
    expect(new Set(sessions.map((s) => s.sessionId)).size).toBe(5);

    // 동시 턴 실행
    await Promise.all(sessions.map((s) => manager.prompt(s.sessionId, `세션 ${s.sessionId} 작업`)));
    await vi.waitFor(
      () => {
        for (const s of sessions) {
          expect(
            events.some((e) => e.sessionId === s.sessionId && e.type === 'turn_completed'),
          ).toBe(true);
        }
      },
      { timeout: 10_000 },
    );

    for (const s of sessions) {
      // 이벤트 스트림 스코프: 각 세션 이벤트의 sessionId 일치 + seq 단조 증가
      const own = events.filter((e) => e.sessionId === s.sessionId);
      expect(own.length).toBeGreaterThan(0);
      const seqs = own.map((e) => e.seq);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

      // 영속화 스코프: 타임라인에 자기 세션 이벤트만 (user_message 원문 격리 확인)
      const timeline = await manager.timeline(s.sessionId);
      expect(timeline.every((e) => e.sessionId === s.sessionId)).toBe(true);
      expect(
        timeline.some(
          (e) => e.type === 'user_message' && (e as { text?: string }).text?.includes(s.sessionId),
        ),
      ).toBe(true);
      await manager.closeSession(s.sessionId);
    }
  });

  it('enforces and hot-updates the session limit (WBS 2.3.1)', async () => {
    manager.setMaxSessions(2);
    await manager.createSession({ harness: 'mock', cwd });
    await manager.createSession({ harness: 'mock', cwd });
    await expect(manager.createSession({ harness: 'mock', cwd })).rejects.toMatchObject({
      code: 'session_limit',
    });
    manager.setMaxSessions(3);
    await expect(manager.createSession({ harness: 'mock', cwd })).resolves.toBeDefined();
    expect(manager.getMaxSessions()).toBe(3);
  });
});
