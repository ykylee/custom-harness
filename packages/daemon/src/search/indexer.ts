// 검색 색인 유지 (M7 WBS 7.4.1, FR-9.4) — 두 경로가 같은 색인을 채운다.
//
// ① **따라잡기(catchUp)**: 기동 시 `timeline.jsonl` 의 마지막 seq 와 색인 워터마크를 비교해
//    밀린 세션만 통째로 다시 만든다. 색인 파일을 지워도, 데몬이 죽어 있는 동안 파일이
//    바뀌어도 여기서 복구된다 — 색인이 파생물이라는 성질이 실제로 성립하는 지점이다.
// ② **실행 중(handleEvent)**: 세션 매니저 이벤트를 받아 확정된 세그먼트만 덧붙인다.
//    이게 없으면 "방금 한 대화"가 다음 기동까지 검색되지 않는다.
//
// 쓰기는 직렬 큐를 탄다. `node:sqlite` 는 동기 API 이고 이벤트 리스너도 동기지만, 메타
// 조회가 비동기라 그 사이에 다른 이벤트가 끼어들 수 있다 — 순서가 뒤집히면 워터마크가
// 뒤로 간다.
import type { SessionEvent } from '@custom-harness/protocol';
import type { SessionStore, SessionMeta } from '../store.js';
import type { SearchIndex, SearchSessionMeta } from './index-store.js';
import { SegmentAccumulator, segmentTimeline } from './segments.js';

export interface SearchIndexerOptions {
  index: SearchIndex;
  store: SessionStore;
}

export class SearchIndexer {
  private readonly accumulators = new Map<string, SegmentAccumulator>();
  /** 확정된 세그먼트가 마지막으로 덮은 seq — 워터마크는 여기까지만 전진한다 */
  private readonly watermarks = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly options: SearchIndexerOptions) {}

  /**
   * 색인과 타임라인 파일을 맞춘다. 사라진 세션의 색인 행도 여기서 걷어낸다 —
   * 남겨 두면 열 수 없는 세션이 검색 결과에 계속 나온다.
   */
  async catchUp(): Promise<{ reindexed: number; removed: number }> {
    const { index, store } = this.options;
    const metas = await store.listMetas();
    const alive = new Set(metas.map((meta) => meta.sessionId));
    let reindexed = 0;
    for (const meta of metas) {
      const events = await store.readTimeline(meta.sessionId);
      const lastSeq = events[events.length - 1]?.seq ?? -1;
      // 메타(제목·워크스페이스·시각)는 타임라인과 무관하게 바뀌므로 항상 최신화한다
      index.upsertSessionMeta(toSearchMeta(meta));
      if (lastSeq <= index.indexedSeq(meta.sessionId)) continue;
      index.replaceSession(toSearchMeta(meta), segmentTimeline(events), lastSeq);
      this.watermarks.set(meta.sessionId, lastSeq);
      reindexed += 1;
    }
    let removed = 0;
    for (const sessionId of index.indexedSessionIds()) {
      if (alive.has(sessionId)) continue;
      index.removeSession(sessionId);
      removed += 1;
    }
    return { reindexed, removed };
  }

  /** 세션 매니저 이벤트 진입점 — 동기 리스너에서 부르고 실제 쓰기는 큐가 처리한다 */
  handleEvent(event: SessionEvent): void {
    if (this.stopped) return;
    const accumulator = this.accumulate(event.sessionId);
    const segments = accumulator.push(event);
    const previous = this.watermarks.get(event.sessionId) ?? -1;
    // 세그먼트가 확정되지 않았어도 워터마크는 따라간다 — 미확정 버퍼는 재기동 시
    // catchUp 이 어차피 세션을 통째로 다시 만든다.
    this.watermarks.set(event.sessionId, Math.max(previous, event.seq));
    if (segments.length === 0) return;
    this.enqueue(async () => {
      const meta = await this.options.store.readMeta(event.sessionId);
      if (meta !== undefined) this.options.index.upsertSessionMeta(toSearchMeta(meta));
      this.options.index.appendSegments(event.sessionId, segments, event.seq);
    });
  }

  /** 대기 중인 쓰기가 끝날 때까지 — 테스트와 종료 절차용 */
  async drain(): Promise<void> {
    await this.queue;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.drain();
    this.accumulators.clear();
  }

  private accumulate(sessionId: string): SegmentAccumulator {
    let accumulator = this.accumulators.get(sessionId);
    if (accumulator === undefined) {
      accumulator = new SegmentAccumulator();
      this.accumulators.set(sessionId, accumulator);
    }
    return accumulator;
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      // 색인 실패가 대화를 막을 이유는 없다 — 다음 기동의 catchUp 이 메운다
      console.warn('[daemon] 검색 색인 갱신 실패:', error);
    });
  }
}

function toSearchMeta(meta: SessionMeta): SearchSessionMeta {
  return {
    sessionId: meta.sessionId,
    harness: meta.harness,
    workspaceId: meta.workspaceId,
    title: meta.title,
    cwd: meta.cwd,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}
