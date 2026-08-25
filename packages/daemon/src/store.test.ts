import { appendFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SessionStore, type SessionMeta } from './store.js';

const baseMeta: SessionMeta = {
  sessionId: 's-1',
  harness: 'mock',
  cwd: '/work',
  status: 'idle',
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
};

describe('SessionStore', () => {
  let store: SessionStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ch-store-'));
    store = new SessionStore(dir);
  });

  it('round-trips meta with native handle', async () => {
    const meta: SessionMeta = {
      ...baseMeta,
      handle: { harness: 'mock', nativeHandle: '/tmp/native.jsonl' },
    };
    await store.writeMeta(meta);
    expect(await store.readMeta('s-1')).toEqual(meta);
    expect(await store.listMetas()).toEqual([meta]);
  });

  it('returns undefined for a missing session', async () => {
    expect(await store.readMeta('nope')).toBeUndefined();
    expect(await store.readTimeline('nope')).toEqual([]);
    expect(await store.lastSeq('nope')).toBe(-1);
  });

  it('appends and reads timeline with fromSeq (inclusive)', async () => {
    await store.appendEvent({ type: 'turn_started', turnId: 't-1', sessionId: 's-1', seq: 0 });
    await store.appendEvent({
      type: 'message_delta',
      delta: 'hi',
      sessionId: 's-1',
      seq: 1,
    });
    await store.appendEvent({ type: 'turn_completed', turnId: 't-1', sessionId: 's-1', seq: 2 });

    expect(await store.readTimeline('s-1')).toHaveLength(3);
    const tail = await store.readTimeline('s-1', 2);
    expect(tail).toHaveLength(1);
    expect(tail[0]?.type).toBe('turn_completed');
    expect(await store.lastSeq('s-1')).toBe(2);
  });

  it('drops a truncated last line only (daemon-design §2 쓰기 실패 내성)', async () => {
    await store.appendEvent({ type: 'turn_started', turnId: 't-1', sessionId: 's-1', seq: 0 });
    await store.appendEvent({ type: 'turn_completed', turnId: 't-1', sessionId: 's-1', seq: 1 });
    await appendFile(join(dir, 's-1', 'timeline.jsonl'), '{"type":"message_del');

    const events = await store.readTimeline('s-1');
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
    expect(await store.lastSeq('s-1')).toBe(1);
  });
});
