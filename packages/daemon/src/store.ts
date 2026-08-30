// 세션 영속화 (daemon-design §2) — meta.json + append-only timeline.jsonl
// 삭제는 명시 조작만. closed 는 상태 필드일 뿐 데이터 유지 (FR-1.3).
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  HarnessIdSchema,
  SessionEventSchema,
  SessionStatusSchema,
  type SessionEvent,
} from '@custom-harness/protocol';

export const SessionMetaSchema = z.looseObject({
  sessionId: z.string(),
  harness: HarnessIdSchema,
  cwd: z.string(),
  modelId: z.string().optional(),
  status: SessionStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  approvalPolicy: z.enum(['mediate', 'auto']).optional(),
  // ── 워크스페이스 모델 선반영 (WBS 5.0.2, workspace-model §3.3) — 전부 optional additive ──
  workspaceId: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  archivedAt: z.string().optional(),
  requiresAttention: z.boolean().optional(),
  attentionReason: z.enum(['finished', 'error', 'permission']).optional(),
  title: z.string().optional(),
  /** 세션 누적 토큰 (FR-3.7, WBS 2.4.5) — 턴 종료 usage 를 합산 (additive) */
  usageTotals: z
    .looseObject({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      totalTokens: z.number().optional(),
    })
    .optional(),
  handle: z
    .looseObject({
      harness: HarnessIdSchema,
      nativeHandle: z.unknown(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

export class SessionStore {
  constructor(private readonly sessionsDir: string) {}

  private sessionDir(sessionId: string): string {
    return join(this.sessionsDir, sessionId);
  }

  private metaPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'meta.json');
  }

  private timelinePath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'timeline.jsonl');
  }

  async writeMeta(meta: SessionMeta): Promise<void> {
    const dir = this.sessionDir(meta.sessionId);
    await mkdir(dir, { recursive: true });
    // tmp + rename — 쓰기 도중 중단으로 meta 가 파손되지 않게
    const tmp = join(dir, 'meta.json.tmp');
    await writeFile(tmp, JSON.stringify(meta, null, 2));
    await rename(tmp, this.metaPath(meta.sessionId));
  }

  async readMeta(sessionId: string): Promise<SessionMeta | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.metaPath(sessionId), 'utf8');
    } catch {
      return undefined;
    }
    const parsed = SessionMetaSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  }

  async listMetas(): Promise<SessionMeta[]> {
    let entries: string[];
    try {
      entries = await readdir(this.sessionsDir);
    } catch {
      return [];
    }
    const metas: SessionMeta[] = [];
    for (const sessionId of entries) {
      const meta = await this.readMeta(sessionId);
      if (meta) metas.push(meta);
    }
    return metas;
  }

  async appendEvent(event: SessionEvent): Promise<void> {
    const dir = this.sessionDir(event.sessionId);
    await mkdir(dir, { recursive: true });
    await appendFile(this.timelinePath(event.sessionId), `${JSON.stringify(event)}\n`);
  }

  /**
   * 타임라인 읽기 — 파손 줄(쓰기 중단으로 잘린 마지막 줄 등)은 그 줄만 드롭한다.
   * fromSeq 는 포함 시작점: 재동기화 클라이언트는 (마지막 보유 seq + 1) 을 넘긴다.
   */
  async readTimeline(sessionId: string, fromSeq = 0): Promise<SessionEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.timelinePath(sessionId), 'utf8');
    } catch {
      return [];
    }
    const events: SessionEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        continue; // 파손 줄 드롭 (daemon-design §2)
      }
      const parsed = SessionEventSchema.safeParse(json);
      if (parsed.success && parsed.data.seq >= fromSeq) events.push(parsed.data);
    }
    return events;
  }

  /** 마지막 부여 seq — 없으면 -1 (다음 이벤트가 0 부터 시작) */
  async lastSeq(sessionId: string): Promise<number> {
    const events = await this.readTimeline(sessionId);
    const last = events[events.length - 1];
    return last ? last.seq : -1;
  }

  /** 명시 삭제만 — 상태 전이(closed)와 무관 (daemon-design §2) */
  async deleteSession(sessionId: string): Promise<void> {
    await rm(this.sessionDir(sessionId), { recursive: true, force: true });
  }
}
