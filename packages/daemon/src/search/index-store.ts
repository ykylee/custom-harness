// 타임라인 검색 색인 (M7 WBS 7.4.1, FR-9.4) — SQLite FTS5 기반.
//
// **엔진**: `node:sqlite`(Node 내장) + FTS5. 새 의존성도, 네이티브 프리빌드도 늘지 않는다 —
// 폐쇄망 3-OS 아카이브(G2)에 얹을 것이 없다는 뜻이다. 데몬은 번들 Node 위에서 돌므로
// (`ELECTRON_RUN_AS_NODE`) 런타임 버전은 우리가 통제한다.
//
// **토크나이저는 `trigram`**: 한국어 때문이다. 기본 `unicode61` 은 "전략을" 을 한 토큰으로
// 끊어 "전략" 질의가 0건이고, "인덱스 전략" 같은 구 검색도 어미가 붙는 순간 어긋난다.
// `trigram` 은 부분일치가 되고 구 검색도 맞는다. 대가는 **3자 미만 질의를 못 쓴다**는 것 —
// 그건 LIKE 로 떨어뜨린다(느리지만 코퍼스가 작고, 틀린 답을 주는 것보다 낫다).
//
// **색인은 파생물이다.** SSOT 는 `timeline.jsonl` 이고 이 DB 는 언제든 버려도 된다.
// 그래서 일관성을 "고치는" 장치를 두지 않았다 — 어긋나면 그 세션을 통째로 다시 만든다.
// 스키마가 바뀌어도 마이그레이션 대신 전량 재생성이다(`SCHEMA_VERSION`).
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite';
import type { HarnessId } from '@custom-harness/protocol';
import { SEARCH_SEGMENT_KINDS, type SearchSegment, type SearchSegmentKind } from './segments.js';

// `node:sqlite` 는 정적 import 로 못 가져온다: Node 는 이 모듈을 **접두사 붙은 이름으로만**
// 노출하는데(`builtinModules` 에 `sqlite` 는 없고 `node:sqlite` 만 있다) Vite 5 는 접두사를
// 떼고 찾아서 `sqlite` 패키지를 해석하려다 실패한다. 런타임 require 는 그 해석 단계를 지나간다.
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');

/** 스키마가 바뀌면 올린다 — 파생물이므로 마이그레이션 없이 전량 재생성한다 */
const SCHEMA_VERSION = 1;

/** trigram 이 성립하는 최소 질의 길이. 이보다 짧은 항은 LIKE 로 간다 */
const TRIGRAM_MIN = 3;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
/** 결과 한 건이 물고 오는 본문 길이 — 팔레트 한 줄에 들어갈 만큼만 */
const SNIPPET_RADIUS = 60;

export interface SearchSessionMeta {
  sessionId: string;
  harness: HarnessId;
  workspaceId?: string | undefined;
  title?: string | undefined;
  cwd?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface SearchQuery {
  query: string;
  workspaceId?: string | undefined;
  harness?: HarnessId | undefined;
  sessionId?: string | undefined;
  kinds?: readonly SearchSegmentKind[] | undefined;
  /** 기간 필터 (ISO) — **세션 시각** 기준이다. 아래 주석 참고 */
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
}

export interface SearchHit {
  sessionId: string;
  seq: number;
  kind: SearchSegmentKind;
  toolName?: string;
  /** 매치 주변을 잘라낸 본문 */
  snippet: string;
  harness: HarnessId;
  workspaceId?: string;
  title?: string;
  cwd?: string;
  updatedAt?: string;
}

interface SegmentRow {
  session_id: string;
  seq: number;
  kind: string;
  tool_name: string | null;
  text: string;
  harness: string;
  workspace_id: string | null;
  title: string | null;
  cwd: string | null;
  updated_at: string | null;
}

export class SearchIndex {
  private db: SqliteDatabase | undefined;

  constructor(private readonly dbPath: string) {}

  open(): void {
    if (this.db !== undefined) return;
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = this.openAt(this.dbPath);
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private openAt(path: string): SqliteDatabase {
    const db = new DatabaseSync(path);
    // 색인은 크래시 때 통째로 다시 만들면 되는 파생물이다 — 내구성보다 쓰기 비용을 줄인다
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    const version = (db.prepare('PRAGMA user_version').get() as { user_version?: number })
      .user_version;
    if (version !== undefined && version !== 0 && version !== SCHEMA_VERSION) {
      db.close();
      // 마이그레이션 대신 폐기 — 재색인 경로가 이미 있으므로 이쪽이 더 안전하다
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
      return this.openAt(path);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_meta (
        session_id   TEXT PRIMARY KEY,
        harness      TEXT NOT NULL,
        workspace_id TEXT,
        title        TEXT,
        cwd          TEXT,
        created_at   TEXT,
        updated_at   TEXT,
        indexed_seq  INTEGER NOT NULL DEFAULT -1
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS segments USING fts5(
        text,
        session_id UNINDEXED,
        seq        UNINDEXED,
        kind       UNINDEXED,
        tool_name  UNINDEXED,
        tokenize = 'trigram'
      );
    `);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return db;
  }

  private handle(): SqliteDatabase {
    if (this.db === undefined) throw new Error('SearchIndex 가 열려 있지 않다');
    return this.db;
  }

  /** 이 세션에 대해 색인이 따라잡은 마지막 seq. 없으면 -1 */
  indexedSeq(sessionId: string): number {
    const row = this.handle()
      .prepare('SELECT indexed_seq FROM session_meta WHERE session_id = ?')
      .get(sessionId) as { indexed_seq?: number } | undefined;
    return row?.indexed_seq ?? -1;
  }

  /** 세션 목록에 색인이 아는 세션 전부 */
  indexedSessionIds(): string[] {
    return (
      this.handle().prepare('SELECT session_id FROM session_meta').all() as {
        session_id: string;
      }[]
    ).map((row) => row.session_id);
  }

  upsertSessionMeta(meta: SearchSessionMeta): void {
    this.handle()
      .prepare(
        `INSERT INTO session_meta (session_id, harness, workspace_id, title, cwd, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           harness = excluded.harness, workspace_id = excluded.workspace_id,
           title = excluded.title, cwd = excluded.cwd,
           created_at = excluded.created_at, updated_at = excluded.updated_at`,
      )
      .run(
        meta.sessionId,
        meta.harness,
        meta.workspaceId ?? null,
        meta.title ?? null,
        meta.cwd ?? null,
        meta.createdAt ?? null,
        meta.updatedAt ?? null,
      );
  }

  /**
   * 한 세션을 통째로 다시 색인한다 — 기동 시 따라잡기 경로.
   *
   * 증분이 아니라 전량인 이유: 세그먼트는 여러 이벤트에 걸쳐 있어서 워터마크가 그 중간에
   * 떨어지면 잘린 세그먼트가 색인에 남는다. 세션 단위 재생성은 비용이 세션 하나 크기라
   * (전체가 아니다) 그 경계 문제를 아예 없애는 편이 싸다.
   */
  replaceSession(
    meta: SearchSessionMeta,
    segments: readonly SearchSegment[],
    lastSeq: number,
  ): void {
    const db = this.handle();
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM segments WHERE session_id = ?').run(meta.sessionId);
      this.upsertSessionMeta(meta);
      this.insertSegments(segments);
      db.prepare('UPDATE session_meta SET indexed_seq = ? WHERE session_id = ?').run(
        lastSeq,
        meta.sessionId,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 실행 중 색인 — 이미 확정된 세그먼트만 온다 */
  appendSegments(sessionId: string, segments: readonly SearchSegment[], lastSeq: number): void {
    const db = this.handle();
    db.exec('BEGIN');
    try {
      this.insertSegments(segments);
      db.prepare(
        'UPDATE session_meta SET indexed_seq = ? WHERE session_id = ? AND indexed_seq < ?',
      ).run(lastSeq, sessionId, lastSeq);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  removeSession(sessionId: string): void {
    const db = this.handle();
    db.prepare('DELETE FROM segments WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM session_meta WHERE session_id = ?').run(sessionId);
  }

  private insertSegments(segments: readonly SearchSegment[]): void {
    const insert = this.handle().prepare(
      'INSERT INTO segments (text, session_id, seq, kind, tool_name) VALUES (?, ?, ?, ?, ?)',
    );
    for (const segment of segments) {
      insert.run(
        segment.text,
        segment.sessionId,
        segment.seq,
        segment.kind,
        segment.toolName ?? null,
      );
    }
  }

  search(query: SearchQuery): SearchHit[] {
    const terms = tokenizeQuery(query.query);
    if (terms.length === 0) return [];
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    const where: string[] = [];
    const params: (string | number)[] = [];

    // trigram 이 감당하는 항은 MATCH 로, 짧은 항은 LIKE 로. 섞어도 결과는 AND 로 같다 —
    // 다른 것은 속도뿐이고, 짧은 질의에서 빈손으로 돌려주지 않는 편이 낫다.
    const matchTerms = terms.filter((term) => term.length >= TRIGRAM_MIN);
    const likeTerms = terms.filter((term) => term.length < TRIGRAM_MIN);
    if (matchTerms.length > 0) {
      where.push('segments MATCH ?');
      params.push(matchTerms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' AND '));
    }
    for (const term of likeTerms) {
      where.push("s.text LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(term)}%`);
    }

    if (query.sessionId !== undefined) {
      where.push('s.session_id = ?');
      params.push(query.sessionId);
    }
    if (query.workspaceId !== undefined) {
      where.push('m.workspace_id = ?');
      params.push(query.workspaceId);
    }
    if (query.harness !== undefined) {
      where.push('m.harness = ?');
      params.push(query.harness);
    }
    const kinds = query.kinds?.filter((kind) => SEARCH_SEGMENT_KINDS.includes(kind)) ?? [];
    if (kinds.length > 0) {
      where.push(`s.kind IN (${kinds.map(() => '?').join(', ')})`);
      params.push(...kinds);
    }
    // 기간은 **세션 시각**으로 거른다. 이벤트 봉투에 타임스탬프가 없기 때문이다
    // (sessionId + seq 뿐). 이벤트별 시각은 프로토콜 변경이고 과거 데이터에 소급되지도
    // 않는다. 세션 타임라인은 그 세션의 수명 안에 갇혀 있으므로 겹침 판정으로 충분하다.
    if (query.from !== undefined) {
      where.push('COALESCE(m.updated_at, m.created_at, ?) >= ?');
      params.push(query.from, query.from);
    }
    if (query.to !== undefined) {
      where.push('COALESCE(m.created_at, m.updated_at, ?) <= ?');
      params.push(query.to, query.to);
    }

    // 정렬은 **최근 우선**이다. bm25 랭킹은 MATCH 가 있을 때만 성립하는데 짧은 질의는
    // LIKE 로 가므로, 랭킹을 쓰면 질의 길이에 따라 정렬 규칙이 조용히 바뀐다.
    // 이력 검색에서 "최근 것부터"는 두 경로에서 똑같이 성립하는 유일한 기준이다.
    const rows = this.handle()
      .prepare(
        `SELECT s.session_id, s.seq, s.kind, s.tool_name, s.text,
                m.harness, m.workspace_id, m.title, m.cwd, m.updated_at
         FROM segments s JOIN session_meta m ON m.session_id = s.session_id
         WHERE ${where.join(' AND ')}
         ORDER BY COALESCE(m.updated_at, m.created_at, '') DESC, s.seq DESC
         LIMIT ?`,
      )
      .all(...params, limit) as unknown as SegmentRow[];

    return rows.map((row) => ({
      sessionId: row.session_id,
      seq: row.seq,
      kind: row.kind as SearchSegmentKind,
      ...(row.tool_name !== null ? { toolName: row.tool_name } : {}),
      snippet: buildSnippet(row.text, terms),
      harness: row.harness as HarnessId,
      ...(row.workspace_id !== null ? { workspaceId: row.workspace_id } : {}),
      ...(row.title !== null ? { title: row.title } : {}),
      ...(row.cwd !== null ? { cwd: row.cwd } : {}),
      ...(row.updated_at !== null ? { updatedAt: row.updated_at } : {}),
    }));
  }
}

/** 공백으로 끊고 중복을 없앤다 — 항끼리는 AND(전부 어딘가에 나타나야 한다) */
export function tokenizeQuery(query: string): string[] {
  return [
    ...new Set(
      query
        .trim()
        .split(/\s+/)
        .filter((term) => term !== ''),
    ),
  ];
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * 매치 주변만 잘라낸다. FTS5 `snippet()` 을 쓰지 않는 이유는 그것이 MATCH 질의에서만
 * 동작하기 때문 — LIKE 경로에서는 못 쓴다. 두 경로가 같은 모양의 결과를 내야 한다.
 */
export function buildSnippet(text: string, terms: readonly string[]): string {
  const haystack = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = haystack.indexOf(term.toLowerCase());
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  if (at === -1) return text.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
