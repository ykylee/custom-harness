// WBS 7.2.0a — 하네스 HOME 격리. 보안 속성(사용자 홈 불가시)과 편의(allowlist 반입)를 분리해 검증한다.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureHarnessHome, harnessHomeDir, harnessHomeEnv } from './home-isolation.js';

let root: string;
let realHome: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ch-home-iso-'));
  realHome = join(root, 'real-home');
  await mkdir(realHome, { recursive: true });
  await writeFile(join(realHome, '.gitconfig'), '[user]\n  name = tester\n');
  // 누수 대상 — 격리 홈에 보이면 안 된다 (harness-mcp-support §3.1)
  await writeFile(join(realHome, '.claude.json'), '{"mcpServers":{"x":{"url":"https://evil"}}}');
  await mkdir(join(realHome, '.cursor'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ensureHarnessHome', () => {
  it('격리 홈에는 allowlist 항목만 존재한다 — 외부 MCP 설정은 보이지 않는다', async () => {
    const dir = harnessHomeDir(join(root, 'harness-home'), 'omp');
    const result = await ensureHarnessHome(dir, ['.gitconfig'], realHome);

    expect(result.linked).toEqual(['.gitconfig']);
    const entries = await readdir(dir);
    expect(entries).toContain('.gitconfig');
    expect(entries).not.toContain('.claude.json');
    expect(entries).not.toContain('.cursor');
  });

  it('반입 항목은 실제 홈을 가리키는 심볼릭 링크다 (git 신원 유지)', async () => {
    const dir = join(root, 'h1');
    await ensureHarnessHome(dir, ['.gitconfig'], realHome);
    expect(await readlink(join(dir, '.gitconfig'))).toBe(join(realHome, '.gitconfig'));
  });

  it('멱등 — 두 번 호출해도 같은 결과이고 경고가 늘지 않는다', async () => {
    const dir = join(root, 'h2');
    const first = await ensureHarnessHome(dir, ['.gitconfig', '.ssh'], realHome);
    const second = await ensureHarnessHome(dir, ['.gitconfig', '.ssh'], realHome);
    expect(second.linked).toEqual(first.linked);
    expect(second.warnings).toEqual([]);
  });

  it('원본 없는 항목은 조용히 건너뛴다 (경고 아님)', async () => {
    const result = await ensureHarnessHome(join(root, 'h3'), ['.ssh'], realHome);
    expect(result.linked).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('경로가 섞인 반입 항목은 거부한다 — allowlist 는 홈 직속 이름만 지칭한다', async () => {
    const result = await ensureHarnessHome(join(root, 'h4'), ['../../etc', '.a/b'], realHome);
    expect(result.linked).toEqual([]);
    expect(result.warnings).toHaveLength(2);
  });

  it('XDG 하위 디렉토리를 함께 만든다', async () => {
    const dir = join(root, 'h5');
    await ensureHarnessHome(dir, [], realHome);
    await expect(readdir(join(dir, '.local'))).resolves.toEqual(
      expect.arrayContaining(['share', 'state']),
    );
  });
});

describe('harnessHomeEnv', () => {
  it('HOME 과 XDG 4종을 격리 홈 안으로 고정한다', () => {
    const env = harnessHomeEnv('/iso', 'darwin');
    expect(env.HOME).toBe('/iso');
    expect(env.XDG_CONFIG_HOME).toBe('/iso/.config');
    expect(env.XDG_DATA_HOME).toBe('/iso/.local/share');
    expect(env.XDG_STATE_HOME).toBe('/iso/.local/state');
    expect(env.XDG_CACHE_HOME).toBe('/iso/.cache');
    expect(env.USERPROFILE).toBeUndefined();
  });

  it('win32 에서는 USERPROFILE 도 덮는다 (node 의 홈 해석 기준)', () => {
    expect(harnessHomeEnv('C:\\iso', 'win32').USERPROFILE).toBe('C:\\iso');
  });
});
