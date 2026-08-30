// 라벨 카탈로그 (WBS 5.3.4) — 호스트 로컬 공용 라벨 목록.
//
// 할당(어느 워크스페이스가 어떤 라벨을 갖는지)은 워크스페이스 레코드가 소유하고,
// 카탈로그는 "이 호스트에서 쓰인 적 있는 라벨"만 모은다. 둘을 한 번에 바꿔야 할 때는
// **카탈로그를 먼저 쓴다** — 뒤 단계가 실패해도 남는 것은 쓰이지 않는 항목 하나뿐이라
// 복구가 필요 없다. 반대 순서였다면 할당은 됐는데 카탈로그에 없는 라벨이 생긴다.
import { z } from 'zod';
import { join } from 'node:path';
import { RegistryStore } from './registry-store.js';

export const LabelEntrySchema = z.looseObject({
  /** `key=value` — 카탈로그 안에서 유일 */
  id: z.string(),
  key: z.string(),
  value: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
});
export type LabelEntry = z.infer<typeof LabelEntrySchema>;

export function labelId(key: string, value: string): string {
  return `${key}=${value}`;
}

export class LabelCatalog {
  private readonly store: RegistryStore<LabelEntry>;

  constructor(projectsDir: string) {
    this.store = new RegistryStore(join(projectsDir, 'labels.json'), LabelEntrySchema);
  }

  async list(): Promise<LabelEntry[]> {
    return this.store.readAll();
  }

  /** 라벨 묶음을 카탈로그에 반영한다 — 이미 있으면 사용 시각만 갱신(멱등) */
  async remember(labels: Record<string, string>): Promise<LabelEntry[]> {
    const pairs = Object.entries(labels);
    if (pairs.length === 0) return [];
    const timestamp = new Date().toISOString();
    return this.store.mutate((records) => {
      const byId = new Map(records.map((record) => [record.id, record]));
      for (const [key, value] of pairs) {
        const id = labelId(key, value);
        const existing = byId.get(id);
        byId.set(
          id,
          existing
            ? { ...existing, lastUsedAt: timestamp }
            : { id, key, value, createdAt: timestamp, lastUsedAt: timestamp },
        );
      }
      const next = [...byId.values()];
      return { records: next, result: next };
    });
  }

  /** 어떤 워크스페이스도 쓰지 않는 항목 정리 — 호출자가 현재 할당 전체를 넘긴다 */
  async prune(assignedLabelIds: Set<string>): Promise<number> {
    return this.store.mutate((records) => {
      const kept = records.filter((record) => assignedLabelIds.has(record.id));
      return { records: kept, result: records.length - kept.length };
    });
  }
}
