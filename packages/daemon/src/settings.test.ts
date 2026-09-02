import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsStore } from './settings.js';

async function makeStore(
  initial?: Record<string, unknown>,
  env: NodeJS.ProcessEnv = {},
): Promise<{ store: SettingsStore; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ch-settings-'));
  const file = join(dir, 'settings.json');
  if (initial) await writeFile(file, JSON.stringify(initial));
  const store = new SettingsStore(file, env);
  await store.load();
  return { store, file };
}

const opened: SettingsStore[] = [];
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});

describe('SettingsStore 우선순위 (WBS 5.0.1)', () => {
  it('파일도 env 도 없으면 기본값이고 출처가 default 다', async () => {
    const { store } = await makeStore();
    expect(store.resolve('maxSessions')).toEqual({
      value: 8,
      source: 'default',
      overriddenByEnv: false,
    });
  });

  it('파일 값이 기본값을 이긴다', async () => {
    const { store } = await makeStore({ maxSessions: 3 });
    expect(store.resolve('maxSessions')).toMatchObject({ value: 3, source: 'file' });
  });

  it('env 가 파일 값을 이기고, 덮었다는 사실을 보고한다', async () => {
    const { store } = await makeStore({ maxSessions: 3 }, { CUSTOM_HARNESS_MAX_SESSIONS: '12' });
    expect(store.resolve('maxSessions')).toEqual({
      value: 12,
      source: 'env',
      overriddenByEnv: true,
    });
  });

  it('부적합한 env 는 무시하고 파일 값으로 떨어진다 — 잘못된 환경 변수가 데몬을 막지 않는다', async () => {
    const { store } = await makeStore(
      { maxSessions: 3 },
      { CUSTOM_HARNESS_MAX_SESSIONS: '설정오류' },
    );
    expect(store.resolve('maxSessions')).toMatchObject({ value: 3, source: 'file' });
  });

  it('범위 밖 파일 값도 무시하고 기본값으로 떨어진다', async () => {
    const { store } = await makeStore({ maxSessions: 999 });
    expect(store.get('maxSessions')).toBe(8);
  });

  it('파손된 설정 파일은 빈 설정으로 취급한다 (관대 파싱)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-settings-'));
    const file = join(dir, 'settings.json');
    await writeFile(file, '{ 이건 JSON 이 아니다');
    const store = new SettingsStore(file, {});
    await store.load();
    expect(store.get('maxSessions')).toBe(8);
  });

  it('점 표기 중첩 키를 읽는다', async () => {
    const { store } = await makeStore({ workspace: { setupAutoRun: true } });
    expect(store.get('workspaceSetupAutoRun')).toBe(true);
  });

  it('불리언 키는 문자열 env 도 해석한다', async () => {
    const { store } = await makeStore({}, { CUSTOM_HARNESS_AUTO_APPROVE: 'true' });
    expect(store.get('autoApprove')).toBe(true);
  });
});

describe('역방향 툴 설정 (WBS 7.2.4)', () => {
  it('노출은 기본 off — 켜는 쪽이 위험한 설정이라 기본값이 홈 격리와 반대다', async () => {
    const { store } = await makeStore();
    expect(store.resolve('toolsReverseExposure').value).toBe(false);
    expect(store.resolve('harnessHomeIsolation').value).toBe(true);
  });

  it('재귀 깊이 상한은 기본 1 이고 0 도 유효한 값이다 (= 세션 생성 금지)', async () => {
    expect((await makeStore()).store.resolve('toolsMaxSessionDepth').value).toBe(1);
    const { store } = await makeStore({ tools: { maxSessionDepth: 0 } });
    expect(store.resolve('toolsMaxSessionDepth')).toMatchObject({ value: 0, source: 'file' });
  });

  it('음수·비정수 상한은 무시하고 기본값으로 떨어진다', async () => {
    const { store } = await makeStore({ tools: { maxSessionDepth: -1 } });
    expect(store.resolve('toolsMaxSessionDepth').value).toBe(1);
  });

  it('팬아웃 상한은 기본 1 — 위임은 되지만 병렬은 사용자가 연다', async () => {
    const { store } = await makeStore();
    expect(store.resolve('toolsMaxFanout').value).toBe(1);
    const opened = await makeStore({ tools: { maxFanout: 4 } });
    expect(opened.store.resolve('toolsMaxFanout')).toMatchObject({ value: 4, source: 'file' });
  });

  it('서브에이전트 토큰 상한은 기본 비활성(0)이며 양수로 설정한다', async () => {
    expect((await makeStore()).store.resolve('toolsMaxSubagentTokens').value).toBe(0);
    const { store } = await makeStore({ tools: { maxSubagentTokens: 12000 } });
    expect(store.resolve('toolsMaxSubagentTokens')).toMatchObject({ value: 12000, source: 'file' });
  });

  it('env 로도 켤 수 있다', async () => {
    const { store } = await makeStore({}, { CUSTOM_HARNESS_REVERSE_TOOLS: 'true' });
    expect(store.resolve('toolsReverseExposure')).toMatchObject({ value: true, source: 'env' });
  });
});

describe('SettingsStore 쓰기', () => {
  it('중첩 키를 파일에 원자적으로 기입한다', async () => {
    const { store, file } = await makeStore();
    const result = await store.set('workspaceSetupAutoRun', true);
    expect(result.effective).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      workspace: { setupAutoRun: true },
    });
  });

  it('무관한 기존 키를 보존한다', async () => {
    const { store, file } = await makeStore({ gateway: { baseUrl: 'http://gw' } });
    await store.set('maxSessions', 5);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      gateway: { baseUrl: 'http://gw' },
      maxSessions: 5,
    });
  });

  it('env 가 덮고 있으면 파일은 갱신하되 유효하지 않음을 알린다', async () => {
    const { store, file } = await makeStore({}, { CUSTOM_HARNESS_MAX_SESSIONS: '12' });
    const result = await store.set('maxSessions', 5);
    expect(result.effective).toBe(false);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ maxSessions: 5 });
    expect(store.get('maxSessions')).toBe(12); // env 가 계속 이긴다
  });

  it('유효하지 않은 값은 거부한다', async () => {
    const { store } = await makeStore();
    await expect(store.set('maxSessions', 0)).rejects.toThrow('유효하지 않음');
  });

  it('동시 set 이 서로를 지우지 않는다 (쓰기 직렬화)', async () => {
    const { store, file } = await makeStore();
    await Promise.all([
      store.set('maxSessions', 4),
      store.set('autoApprove', true),
      store.set('workspaceSetupAutoRun', true),
    ]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      maxSessions: 4,
      autoApprove: true,
      workspace: { setupAutoRun: true },
    });
  });
});

describe('SettingsStore 재적용', () => {
  it('reload 가 바뀐 키만 변경으로 보고한다', async () => {
    const { store, file } = await makeStore({ maxSessions: 3 });
    await writeFile(file, JSON.stringify({ maxSessions: 6, autoApprove: true }));
    const changes = await store.reload();
    expect(changes).toEqual([
      { key: 'maxSessions', previous: 3, next: 6, requiresRestart: false },
      { key: 'autoApprove', previous: false, next: true, requiresRestart: false },
    ]);
  });

  it('변경이 없으면 리스너를 부르지 않는다', async () => {
    const { store, file } = await makeStore({ maxSessions: 3 });
    let calls = 0;
    store.onChange(() => (calls += 1));
    await writeFile(file, JSON.stringify({ maxSessions: 3 }));
    expect(await store.reload()).toEqual([]);
    expect(calls).toBe(0);
  });

  it('env 로 고정된 키는 파일이 바뀌어도 변경으로 보고하지 않는다', async () => {
    const { store, file } = await makeStore(
      { maxSessions: 3 },
      { CUSTOM_HARNESS_MAX_SESSIONS: '12' },
    );
    await writeFile(file, JSON.stringify({ maxSessions: 6 }));
    expect(await store.reload()).toEqual([]);
    expect(store.get('maxSessions')).toBe(12);
  });

  it('파일 감시가 외부 편집을 반영한다', async () => {
    const { store, file } = await makeStore({ maxSessions: 3 });
    opened.push(store);
    let observed = false;
    store.onChange((changes) => {
      if (changes.some((c) => c.key === 'maxSessions' && c.next === 7)) observed = true;
    });
    store.watchFile();
    // fs.watch 등록은 플랫폼에 따라 비동기라 직후 변경을 놓칠 수 있다 — 관측될 때까지 재기입
    for (let attempt = 0; attempt < 40 && !observed; attempt += 1) {
      await writeFile(file, JSON.stringify({ maxSessions: 7, nonce: attempt }));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(observed).toBe(true);
    expect(store.get('maxSessions')).toBe(7);
  }, 10_000);
});
