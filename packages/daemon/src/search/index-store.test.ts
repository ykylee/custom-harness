import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SearchIndex, buildSnippet, tokenizeQuery, type SearchSessionMeta } from './index-store.js';
import type { SearchSegment } from './segments.js';

const meta = (overrides: Partial<SearchSessionMeta> = {}): SearchSessionMeta => ({
  sessionId: 's-1',
  harness: 'mock',
  workspaceId: 'ws-1',
  cwd: '/repo',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T01:00:00.000Z',
  ...overrides,
});

const segment = (text: string, overrides: Partial<SearchSegment> = {}): SearchSegment => ({
  sessionId: 's-1',
  seq: 0,
  kind: 'assistant',
  text,
  ...overrides,
});

describe('SearchIndex', () => {
  let dir: string;
  let index: SearchIndex;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ch-search-'));
    index = new SearchIndex(join(dir, 'nested', 'search-index.db'));
    index.open();
  });

  afterEach(async () => {
    index.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('한국어 부분일치를 찾는다 — 어미가 붙어도 걸린다', () => {
    // 기본 unicode61 토크나이저였다면 '전략을' 이 한 토큰이라 0건이 나온다
    index.replaceSession(meta(), [segment('타임라인 전문 검색의 인덱스 전략을 정한다')], 0);
    expect(index.search({ query: '전략' })).toHaveLength(1);
    expect(index.search({ query: '검색' })).toHaveLength(1);
  });

  it('여러 항은 AND 로 묶는다 — 순서와 인접은 요구하지 않는다', () => {
    index.replaceSession(meta(), [segment('인덱스 전략을 먼저 정하고 팬아웃 상한을 본다')], 0);
    expect(index.search({ query: '팬아웃 인덱스' })).toHaveLength(1);
    expect(index.search({ query: '인덱스 서브에이전트' })).toHaveLength(0);
  });

  it('3자 미만 질의도 빈손으로 돌려주지 않는다', () => {
    // trigram 이 성립하지 않는 길이 — LIKE 경로로 떨어진다
    index.replaceSession(meta(), [segment('pi 어댑터를 손봤다')], 0);
    expect(index.search({ query: 'pi' })).toHaveLength(1);
    expect(index.search({ query: 'pi 어댑터' })).toHaveLength(1);
    expect(index.search({ query: 'pi 없는말' })).toHaveLength(0);
  });

  it('LIKE 와일드카드를 리터럴로 다룬다', () => {
    index.replaceSession(meta(), [segment('a_b'), segment('axb', { seq: 1 })], 1);
    expect(index.search({ query: 'a_' }).map((hit) => hit.snippet)).toEqual(['a_b']);
  });

  it('워크스페이스·하네스·종류·세션으로 좁힌다', () => {
    index.replaceSession(meta(), [segment('공통 검색어')], 0);
    index.replaceSession(
      meta({ sessionId: 's-2', harness: 'pi', workspaceId: 'ws-2' }),
      [segment('공통 검색어', { sessionId: 's-2', kind: 'tool', toolName: 'grep' })],
      0,
    );
    expect(index.search({ query: '공통' })).toHaveLength(2);
    expect(index.search({ query: '공통', workspaceId: 'ws-2' }).map((h) => h.sessionId)).toEqual([
      's-2',
    ]);
    expect(index.search({ query: '공통', harness: 'pi' }).map((h) => h.sessionId)).toEqual(['s-2']);
    expect(index.search({ query: '공통', sessionId: 's-1' }).map((h) => h.sessionId)).toEqual([
      's-1',
    ]);
    expect(index.search({ query: '공통', kinds: ['tool'] }).map((h) => h.toolName)).toEqual([
      'grep',
    ]);
  });

  it('기간은 세션 수명과 겹치는지로 거른다', () => {
    index.replaceSession(
      meta({ createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z' }),
      [segment('오래된 대화')],
      0,
    );
    expect(index.search({ query: '오래된', from: '2026-08-30T00:00:00.000Z' })).toHaveLength(0);
    expect(index.search({ query: '오래된', to: '2026-07-01T00:00:00.000Z' })).toHaveLength(0);
    expect(
      index.search({
        query: '오래된',
        from: '2026-08-01T12:00:00.000Z',
        to: '2026-08-05T00:00:00.000Z',
      }),
    ).toHaveLength(1);
  });

  it('최근 세션을 먼저 준다', () => {
    index.replaceSession(meta({ updatedAt: '2026-08-01T00:00:00.000Z' }), [segment('정렬')], 0);
    index.replaceSession(
      meta({ sessionId: 's-2', updatedAt: '2026-09-01T00:00:00.000Z' }),
      [segment('정렬', { sessionId: 's-2' })],
      0,
    );
    expect(index.search({ query: '정렬' }).map((hit) => hit.sessionId)).toEqual(['s-2', 's-1']);
  });

  it('결과에 세션 메타와 점프 앵커를 함께 싣는다', () => {
    index.replaceSession(meta({ title: '검색 붙이기' }), [segment('앵커', { seq: 42 })], 42);
    expect(index.search({ query: '앵커' })[0]).toMatchObject({
      sessionId: 's-1',
      seq: 42,
      kind: 'assistant',
      harness: 'mock',
      workspaceId: 'ws-1',
      title: '검색 붙이기',
      cwd: '/repo',
    });
  });

  it('재색인은 이전 행을 남기지 않는다', () => {
    index.replaceSession(meta(), [segment('예전 내용')], 0);
    index.replaceSession(meta(), [segment('새 내용')], 1);
    expect(index.search({ query: '예전' })).toHaveLength(0);
    expect(index.search({ query: '새' })).toHaveLength(1);
    expect(index.indexedSeq('s-1')).toBe(1);
  });

  it('워터마크는 뒤로 가지 않는다', () => {
    index.replaceSession(meta(), [segment('기준')], 5);
    index.appendSegments('s-1', [segment('늦게 온 것', { seq: 3 })], 3);
    expect(index.indexedSeq('s-1')).toBe(5);
  });

  it('세션을 지우면 결과에서 사라진다', () => {
    index.replaceSession(meta(), [segment('삭제 대상')], 0);
    index.removeSession('s-1');
    expect(index.search({ query: '삭제' })).toHaveLength(0);
    expect(index.indexedSessionIds()).toEqual([]);
  });

  it('빈 질의는 전체를 쏟지 않는다', () => {
    index.replaceSession(meta(), [segment('아무거나')], 0);
    expect(index.search({ query: '   ' })).toEqual([]);
  });

  it('limit 을 지킨다', () => {
    const many = Array.from({ length: 10 }, (_, i) => segment('반복 검색어', { seq: i }));
    index.replaceSession(meta(), many, 9);
    expect(index.search({ query: '반복', limit: 3 })).toHaveLength(3);
  });

  it('스키마 버전이 다르면 마이그레이션 대신 버리고 다시 만든다', async () => {
    const path = join(dir, 'stale.db');
    const stale = new SearchIndex(path);
    stale.open();
    stale.replaceSession(meta(), [segment('과거 스키마')], 0);
    stale.close();
    // 다음 버전이 열었다고 가정 — 알 수 없는 버전이면 폐기 대상이다
    const { DatabaseSync } = createRequire(import.meta.url)(
      'node:sqlite',
    ) as typeof import('node:sqlite');
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA user_version = 999');
    raw.close();

    const reopened = new SearchIndex(path);
    reopened.open();
    expect(reopened.indexedSessionIds()).toEqual([]);
    expect(reopened.search({ query: '과거' })).toEqual([]);
    reopened.close();
  });

  it('열지 않은 색인은 조용히 실패하지 않는다', () => {
    const closed = new SearchIndex(join(dir, 'unopened.db'));
    expect(() => closed.search({ query: '무엇이든' })).toThrow(/열려 있지 않다/);
  });

  it('파손된 색인 파일도 기동을 막지 않는다', async () => {
    const path = join(dir, 'broken.db');
    await writeFile(path, 'not a database');
    const broken = new SearchIndex(path);
    // 파생물이므로 호출자(startDaemon)가 경고만 남기고 검색을 끄면 된다
    expect(() => broken.open()).toThrow();
  });
});

describe('tokenizeQuery', () => {
  it('공백으로 끊고 중복을 없앤다', () => {
    expect(tokenizeQuery('  인덱스   전략 인덱스 ')).toEqual(['인덱스', '전략']);
    expect(tokenizeQuery('   ')).toEqual([]);
  });
});

describe('buildSnippet', () => {
  it('첫 매치 주변만 잘라낸다', () => {
    const text = `${'가'.repeat(200)}인덱스${'나'.repeat(200)}`;
    const snippet = buildSnippet(text, ['인덱스']);
    expect(snippet).toContain('인덱스');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThan(text.length);
  });

  it('대소문자를 가리지 않는다', () => {
    expect(buildSnippet('Full Text Search', ['search'])).toContain('Search');
  });
});
