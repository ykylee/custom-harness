// 워크스페이스 파일 접근 (WBS 6.4) — 경계가 이 모듈의 첫 번째 책임이다.
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_READ_BYTES,
  PathEscapeError,
  listDirectory,
  readWorkspaceFile,
  resolveInWorkspace,
} from './files.js';

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ch-files-'));
  await mkdir(join(dir, 'src', 'nested'), { recursive: true });
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await mkdir(join(dir, '.git'), { recursive: true });
  await writeFile(join(dir, 'README.md'), '# hello\n');
  await writeFile(join(dir, 'src', 'index.ts'), 'export const x = 1;\n');
  await writeFile(join(dir, 'src', 'nested', 'deep.txt'), 'deep\n');
  return dir;
}

describe('경로 경계 (workbench-tabs §3)', () => {
  it('상위로 올라가는 경로를 거절한다', async () => {
    const cwd = await makeWorkspace();
    await expect(resolveInWorkspace(cwd, '../etc/passwd')).rejects.toThrow(PathEscapeError);
    await expect(resolveInWorkspace(cwd, 'src/../../outside')).rejects.toThrow(PathEscapeError);
    await expect(resolveInWorkspace(cwd, '..')).rejects.toThrow(PathEscapeError);
  });

  it('절대 경로를 거절한다', async () => {
    const cwd = await makeWorkspace();
    await expect(resolveInWorkspace(cwd, '/etc/passwd')).rejects.toThrow(PathEscapeError);
  });

  it('밖을 가리키는 심링크를 거절한다 — lexical 검사만으로는 못 잡는다', async () => {
    const cwd = await makeWorkspace();
    const outside = await mkdtemp(join(tmpdir(), 'ch-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'top secret\n');
    await symlink(outside, join(cwd, 'escape'));

    await expect(resolveInWorkspace(cwd, 'escape/secret.txt')).rejects.toThrow(PathEscapeError);
    await expect(readWorkspaceFile(cwd, 'escape/secret.txt')).rejects.toThrow(PathEscapeError);
  });

  it('워크스페이스 안 경로는 통과한다', async () => {
    const cwd = await makeWorkspace();
    await expect(resolveInWorkspace(cwd, 'src/index.ts')).resolves.toContain('src');
    await expect(resolveInWorkspace(cwd, './README.md')).resolves.toContain('README.md');
  });
});

describe('디렉토리 목록 (WBS 6.4.1)', () => {
  it('디렉토리를 먼저, 이름순으로 준다', async () => {
    const cwd = await makeWorkspace();
    const { entries } = await listDirectory(cwd, '');
    expect(entries.map((entry) => entry.name)).toEqual(['src', 'README.md']);
    expect(entries[0]?.kind).toBe('directory');
  });

  it('.git·node_modules 는 감춘다', async () => {
    const cwd = await makeWorkspace();
    const { entries } = await listDirectory(cwd, '');
    expect(entries.some((entry) => entry.name === '.git')).toBe(false);
    expect(entries.some((entry) => entry.name === 'node_modules')).toBe(false);
  });

  it('하위 경로도 상대 경로로 돌려준다 (증분 로딩)', async () => {
    const cwd = await makeWorkspace();
    const { entries } = await listDirectory(cwd, 'src');
    expect(entries.map((entry) => entry.path).sort()).toEqual(['src/index.ts', 'src/nested']);
  });

  it('항목이 많으면 잘라서 알린다', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-files-'));
    for (let index = 0; index < 2100; index += 1) {
      await writeFile(join(cwd, `f${index}.txt`), 'x');
    }
    const { entries, truncated } = await listDirectory(cwd, '');
    expect(entries).toHaveLength(2000);
    expect(truncated).toBe(true);
  });
});

describe('파일 읽기 (WBS 6.4.2)', () => {
  it('텍스트를 돌려준다', async () => {
    const cwd = await makeWorkspace();
    const content = await readWorkspaceFile(cwd, 'README.md');
    expect(content).toMatchObject({ text: '# hello\n', binary: false, tooLarge: false });
  });

  it('널 바이트가 있으면 바이너리로 판정하고 내용을 싣지 않는다', async () => {
    const cwd = await makeWorkspace();
    await writeFile(join(cwd, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const content = await readWorkspaceFile(cwd, 'blob.bin');
    expect(content.binary).toBe(true);
    expect(content.text).toBeUndefined();
  });

  it('상한을 넘는 파일은 메타데이터만 준다', async () => {
    const cwd = await makeWorkspace();
    await writeFile(join(cwd, 'big.txt'), 'a'.repeat(MAX_READ_BYTES + 10));
    const content = await readWorkspaceFile(cwd, 'big.txt');
    expect(content.tooLarge).toBe(true);
    expect(content.text).toBeUndefined();
    expect(content.size).toBeGreaterThan(MAX_READ_BYTES);
  });

  it('디렉토리를 읽으려 하면 거절한다', async () => {
    const cwd = await makeWorkspace();
    await expect(readWorkspaceFile(cwd, 'src')).rejects.toThrow('파일이 아님');
  });
});
