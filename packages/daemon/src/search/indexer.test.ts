import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionEvent } from '@custom-harness/protocol';
import { SessionStore, type SessionMeta } from '../store.js';
import { SearchIndex } from './index-store.js';
import { SearchIndexer } from './indexer.js';

const meta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  sessionId: 's-1',
  harness: 'mock',
  cwd: '/repo',
  status: 'idle',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T01:00:00.000Z',
  workspaceId: 'ws-1',
  ...overrides,
});

const turn = (sessionId: string, from: number, text: string): SessionEvent[] =>
  [
    { type: 'turn_started', turnId: 't', sessionId, seq: from },
    { type: 'message_delta', turnId: 't', delta: text, sessionId, seq: from + 1 },
    { type: 'turn_completed', turnId: 't', sessionId, seq: from + 2 },
  ] as SessionEvent[];

describe('SearchIndexer', () => {
  let dir: string;
  let store: SessionStore;
  let index: SearchIndex;
  let indexer: SearchIndexer;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ch-indexer-'));
    store = new SessionStore(join(dir, 'sessions'));
    index = new SearchIndex(join(dir, 'search-index.db'));
    index.open();
    indexer = new SearchIndexer({ index, store });
  });

  afterEach(async () => {
    await indexer.stop();
    index.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('빈 색인을 타임라인 파일에서 통째로 되살린다', async () => {
    await store.writeMeta(meta());
    for (const event of turn('s-1', 0, '인덱스 전략을 정한다')) await store.appendEvent(event);

    expect(await indexer.catchUp()).toEqual({ reindexed: 1, removed: 0 });
    expect(index.search({ query: '전략' }).map((hit) => hit.sessionId)).toEqual(['s-1']);
    expect(index.indexedSeq('s-1')).toBe(2);
  });

  it('이미 따라잡은 세션은 다시 만들지 않는다', async () => {
    await store.writeMeta(meta());
    for (const event of turn('s-1', 0, '한 번만')) await store.appendEvent(event);
    await indexer.catchUp();

    expect(await indexer.catchUp()).toEqual({ reindexed: 0, removed: 0 });
  });

  it('데몬이 꺼진 사이 늘어난 타임라인을 따라잡는다', async () => {
    await store.writeMeta(meta());
    for (const event of turn('s-1', 0, '첫 턴')) await store.appendEvent(event);
    await indexer.catchUp();

    for (const event of turn('s-1', 3, '나중에 붙은 턴')) await store.appendEvent(event);
    expect(await indexer.catchUp()).toEqual({ reindexed: 1, removed: 0 });
    expect(index.search({ query: '나중에' })).toHaveLength(1);
    // 재색인은 전량 교체 — 앞 턴이 사라지면 안 된다
    expect(index.search({ query: '첫 턴' })).toHaveLength(1);
  });

  it('사라진 세션의 색인 행을 걷어낸다', async () => {
    await store.writeMeta(meta());
    for (const event of turn('s-1', 0, '지워질 세션')) await store.appendEvent(event);
    await indexer.catchUp();

    await store.deleteSession('s-1');
    expect(await indexer.catchUp()).toEqual({ reindexed: 0, removed: 1 });
    // 열 수 없는 세션이 결과에 남아 있으면 안 된다
    expect(index.search({ query: '지워질' })).toEqual([]);
  });

  it('타임라인이 그대로여도 세션 메타 변화는 반영한다', async () => {
    await store.writeMeta(meta());
    for (const event of turn('s-1', 0, '제목 붙기 전')) await store.appendEvent(event);
    await indexer.catchUp();

    await store.writeMeta(meta({ title: '검색 붙이기' }));
    await indexer.catchUp();
    expect(index.search({ query: '제목' })[0]?.title).toBe('검색 붙이기');
  });

  it('실행 중 이벤트를 확정 시점에 색인한다', async () => {
    await store.writeMeta(meta());
    const events = turn('s-1', 0, '방금 한 대화');
    for (const event of events) {
      await store.appendEvent(event);
      indexer.handleEvent(event);
    }
    await indexer.drain();

    // 다음 기동을 기다리지 않고 바로 잡혀야 한다
    expect(index.search({ query: '방금' })).toHaveLength(1);
    expect(index.indexedSeq('s-1')).toBe(2);
  });

  it('실행 중 색인은 델타 경계에 걸친 문자열도 잡는다', async () => {
    await store.writeMeta(meta());
    const events = [
      { type: 'message_delta', turnId: 't', delta: '인덱', sessionId: 's-1', seq: 0 },
      { type: 'message_delta', turnId: 't', delta: '스 전략', sessionId: 's-1', seq: 1 },
      { type: 'turn_completed', turnId: 't', sessionId: 's-1', seq: 2 },
    ] as SessionEvent[];
    for (const event of events) {
      await store.appendEvent(event);
      indexer.handleEvent(event);
    }
    await indexer.drain();

    expect(index.search({ query: '인덱스 전략' })).toHaveLength(1);
  });

  it('중단된 턴의 미확정 버퍼는 다음 따라잡기가 메운다', async () => {
    await store.writeMeta(meta());
    // turn_completed 없이 데몬이 죽은 모양
    const dangling = {
      type: 'message_delta',
      turnId: 't',
      delta: '확정되지 않은 말',
      sessionId: 's-1',
      seq: 0,
    } as SessionEvent;
    await store.appendEvent(dangling);
    indexer.handleEvent(dangling);
    await indexer.drain();
    expect(index.search({ query: '확정되지' })).toHaveLength(0);

    const restarted = new SearchIndexer({ index, store });
    expect(await restarted.catchUp()).toEqual({ reindexed: 1, removed: 0 });
    expect(index.search({ query: '확정되지' })).toHaveLength(1);
  });

  it('색인 쓰기 실패가 이벤트 처리를 무너뜨리지 않는다', async () => {
    await store.writeMeta(meta());
    index.close(); // 쓰기가 던지는 상황

    const events = turn('s-1', 0, '색인은 실패해도');
    for (const event of events) indexer.handleEvent(event);
    await expect(indexer.drain()).resolves.toBeUndefined();

    index.open();
  });

  it('멈춘 뒤에는 더 색인하지 않는다', async () => {
    await store.writeMeta(meta());
    await indexer.stop();
    for (const event of turn('s-1', 0, '멈춘 뒤')) indexer.handleEvent(event);
    await indexer.drain();
    expect(index.search({ query: '멈춘' })).toEqual([]);
  });
});
