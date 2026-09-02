// 라이선스 고지 열람 (WBS 3.3.2, FR-4.5·NFR-4)
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { PathEscapeError } from './safe-path.js';
import {
  LICENSE_CHUNK_MAX,
  readLicenseChunk,
  readLicenseIndex,
  resolveLicensesDir,
} from './licenses.js';

let bundleRoot: string;
let licensesDir: string;

beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), 'ch-licenses-'));
  licensesDir = join(bundleRoot, 'licenses');
  await mkdir(join(licensesDir, 'deps', 'zod'), { recursive: true });
  await mkdir(join(licensesDir, 'pi'), { recursive: true });
  await writeFile(join(licensesDir, 'NOTICE.md'), '# NOTICE\n\n동봉물 목록\n');
  await writeFile(join(licensesDir, 'PROVENANCE.md'), '# PROVENANCE\n');
  await writeFile(
    join(licensesDir, 'notices.json'),
    JSON.stringify({
      schemaVersion: 1,
      components: [
        { name: 'pi', version: '0.84.1', license: 'MIT', paths: ['pi/LICENSE'] },
        { name: 'zod', version: '4.4.3', license: 'MIT', paths: ['deps/zod/LICENSE'] },
        { name: '형이깨진줄', version: 7 }, // 나쁜 필드만 버리고 항목은 남긴다 (NFR-5)
        { version: '1.0.0' }, // 이름이 없으면 표에 세울 수 없다 — 버린다
      ],
    }),
  );
  await writeFile(join(licensesDir, 'pi', 'LICENSE'), 'MIT License — pi\n');
  await writeFile(join(licensesDir, 'deps', 'zod', 'LICENSE'), 'MIT License — zod\n');
  // 봉쇄 밖 파일 + 그것을 가리키는 심링크
  await writeFile(join(bundleRoot, 'secret.txt'), 'manifest 옆의 비밀\n');
  await symlink(join(bundleRoot, 'secret.txt'), join(licensesDir, 'escape'));
});

describe('고지 색인', () => {
  it('manifest 경로에서 licenses/ 를 유도한다', () => {
    expect(resolveLicensesDir('/opt/ch/manifest.json')).toBe('/opt/ch/licenses');
    expect(resolveLicensesDir(undefined)).toBeUndefined();
  });

  it('NOTICE·PROVENANCE·동봉물 표·파일 목록을 함께 준다', async () => {
    const index = await readLicenseIndex(licensesDir);
    expect(index.available).toBe(true);
    expect(index.notice).toContain('# NOTICE');
    expect(index.provenance).toContain('# PROVENANCE');
    expect(index.components.map((c) => c.name)).toEqual(['pi', 'zod', '형이깨진줄']);
    // 관대한 파싱 — 형이 어긋난 필드만 비우고 항목 자체는 살린다 (NFR-5)
    expect(index.components[2]).toEqual({ name: '형이깨진줄', paths: [] });
    expect(index.components[0]?.paths).toEqual(['pi/LICENSE']);
    expect(index.files.map((f) => f.path)).toContain('deps/zod/LICENSE');
    expect(index.files.every((f) => f.size > 0)).toBe(true);
  });

  it('심링크는 목록에 올리지 않는다 — 봉쇄 밖을 가리킬 수 있다', async () => {
    const index = await readLicenseIndex(licensesDir);
    expect(index.files.map((f) => f.path)).not.toContain('escape');
  });

  it('번들이 아니면 available=false 로 성립한다', async () => {
    expect(await readLicenseIndex(undefined)).toEqual({
      available: false,
      components: [],
      files: [],
    });
    expect((await readLicenseIndex(join(bundleRoot, 'nonexistent'))).available).toBe(false);
  });

  it('notices.json 이 훼손돼도 원문 열람은 계속된다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ch-licenses-bad-'));
    await mkdir(join(root, 'licenses'), { recursive: true });
    await writeFile(join(root, 'licenses', 'notices.json'), '{ 이건 JSON 이 아니다');
    await writeFile(join(root, 'licenses', 'LICENSE'), 'MIT\n');
    const index = await readLicenseIndex(join(root, 'licenses'));
    expect(index.available).toBe(true);
    expect(index.components).toEqual([]);
    expect(index.files.map((f) => f.path)).toEqual(['LICENSE', 'notices.json']);
  });
});

describe('원문 열람 봉쇄', () => {
  it('licenses/ 밖 경로는 거절한다', async () => {
    await expect(readLicenseChunk(licensesDir, '../manifest.json')).rejects.toThrow(
      PathEscapeError,
    );
    await expect(readLicenseChunk(licensesDir, '/etc/passwd')).rejects.toThrow(PathEscapeError);
    await expect(readLicenseChunk(licensesDir, 'pi/../../secret.txt')).rejects.toThrow(
      PathEscapeError,
    );
  });

  it('밖을 가리키는 심링크도 거절한다', async () => {
    await expect(readLicenseChunk(licensesDir, 'escape')).rejects.toThrow(PathEscapeError);
  });

  it('번들이 아니면 열람 자체가 없다', async () => {
    await expect(readLicenseChunk(undefined, 'pi/LICENSE')).rejects.toThrow(PathEscapeError);
  });

  it('오류 메시지가 라이선스 맥락으로 나온다 — 워크스페이스 가드와 같은 코드지만 문구는 다르다', async () => {
    await expect(readLicenseChunk(licensesDir, '../manifest.json')).rejects.toThrow(
      /라이선스 디렉토리 밖/,
    );
  });
});

describe('조각 읽기', () => {
  it('작은 파일은 한 번에 끝난다', async () => {
    const chunk = await readLicenseChunk(licensesDir, 'pi/LICENSE');
    expect(chunk.text).toBe('MIT License — pi\n');
    expect(chunk.eof).toBe(true);
    expect(chunk.nextOffset).toBe(chunk.size);
  });

  it('nextOffset 으로 이어 읽으면 원문이 복원된다', async () => {
    const big = await mkdtemp(join(tmpdir(), 'ch-licenses-big-'));
    await mkdir(join(big, 'licenses'), { recursive: true });
    // 다중바이트 문자를 섞어 조각 경계가 문자를 자르게 만든다
    const original = '가나다라마바사아자차'.repeat(500);
    await writeFile(join(big, 'licenses', 'BIG.txt'), original);
    const root = join(big, 'licenses');

    let offset = 0;
    let text = '';
    let guard = 0;
    for (;;) {
      const chunk = await readLicenseChunk(root, 'BIG.txt', offset, 101); // 3의 배수가 아닌 크기
      expect(chunk.text).not.toContain('�'); // 잘린 문자가 새어 나오지 않는다
      text += chunk.text;
      expect(chunk.nextOffset).toBeGreaterThan(offset);
      offset = chunk.nextOffset;
      if (chunk.eof) break;
      if (++guard > 1000) throw new Error('조각 읽기가 끝나지 않음');
    }
    expect(text).toBe(original);
  });

  it('요청 크기는 상한으로 잘린다 — 20MB 고지를 한 번에 밀어 넣지 않는다', async () => {
    const chunk = await readLicenseChunk(licensesDir, 'pi/LICENSE', 0, LICENSE_CHUNK_MAX * 10);
    expect(chunk.nextOffset - chunk.offset).toBeLessThanOrEqual(LICENSE_CHUNK_MAX);
  });

  it('파일 끝을 넘긴 오프셋은 빈 조각 + eof', async () => {
    const chunk = await readLicenseChunk(licensesDir, 'pi/LICENSE', 9999);
    expect(chunk.text).toBe('');
    expect(chunk.eof).toBe(true);
  });
});
