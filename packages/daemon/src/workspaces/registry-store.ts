// 레지스트리 파일 스토어 (workspace-model §5) — 원자성과 직렬화를 여기서만 소유한다.
//
// 호출자에게 read-modify-write 를 시키지 않는다: 그 형태의 코드는 WBS 2.7.3 부하 테스트에서
// PID 원장의 갱신 유실로 이미 한 번 터졌다. 한 메서드 = 한 트랜잭션.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { z } from 'zod';

export class RegistryStore<T extends { id: string }> {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly schema: z.ZodType<T>,
  ) {}

  /** 파손된 줄은 버리고 나머지를 살린다 (관대 파싱, NFR-5) — 레지스트리 하나가 데몬을 막지 않는다 */
  async readAll(): Promise<T[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      return [];
    }
    const rows = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' &&
          parsed !== null &&
          Array.isArray((parsed as { records?: unknown }).records)
        ? (parsed as { records: unknown[] }).records
        : [];
    const out: T[] = [];
    for (const row of rows) {
      const result = this.schema.safeParse(row);
      if (result.success) out.push(result.data);
    }
    return out;
  }

  async find(id: string): Promise<T | undefined> {
    return (await this.readAll()).find((record) => record.id === id);
  }

  /**
   * 전체 목록을 읽어 변환한 뒤 원자적으로 다시 쓴다. 변환 함수가 반환한 값이 곧 새 상태다.
   * 쓰기는 직렬화되므로 동시 호출이 서로를 덮지 않는다.
   */
  async mutate<R>(mutator: (records: T[]) => { records: T[]; result: R }): Promise<R> {
    let outcome!: R;
    await this.enqueue(async () => {
      const current = await this.readAll();
      const { records, result } = mutator(current);
      await this.writeAtomic(records);
      outcome = result;
    });
    return outcome;
  }

  private async writeAtomic(records: T[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = join(dirname(this.file), `${this.file.split(/[\\/]/).pop()}.${process.pid}.tmp`);
    await writeFile(tmp, `${JSON.stringify({ schemaVersion: 1, records }, null, 2)}\n`);
    await rename(tmp, this.file);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
