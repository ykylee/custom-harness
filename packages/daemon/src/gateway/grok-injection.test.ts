import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { beforeEach, describe, expect, it } from 'vitest';
import { injectGrokGateway, type GrokInjectionConfig } from './grok-injection.js';

const config: GrokInjectionConfig = {
  baseUrl: 'http://gateway.internal/v1',
  apiKeyEnvVar: 'CUSTOM_HARNESS_GATEWAY_KEY',
  models: [{ id: 'grok-4.6', name: 'Grok 4.6 (사내)' }],
};

const readConfig = async (path: string): Promise<Record<string, unknown>> =>
  parseToml(await readFile(path, 'utf8')) as Record<string, unknown>;

describe('injectGrokGateway (WBS 2.2.2, FR-2.1.3/FR-2.2)', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ch-grokhome-'));
  });

  it('creates config.toml with 오프라인 스위치·모델 고정·env_key (평문 금지)', async () => {
    const result = await injectGrokGateway(home, config);
    expect(result.status).toBe('created');
    const written = await readConfig(result.configPath);
    expect(written.cli).toEqual({ auto_update: false });
    expect(written.features).toEqual({
      telemetry: false,
      remote_fetch: false,
      managed_config: false,
    });
    // 보조 호출(제목 생성·web_search)도 게이트웨이 모델로 고정 (M0 실측 발견)
    expect(written.models).toEqual({ default: 'grok-4.6', web_search: 'grok-4.6' });
    expect((written.model as Record<string, unknown>)['grok-4.6']).toEqual({
      model: 'grok-4.6',
      name: 'Grok 4.6 (사내)',
      base_url: 'http://gateway.internal/v1',
      api_backend: 'chat_completions',
      env_key: 'CUSTOM_HARNESS_GATEWAY_KEY',
    });
  });

  it('is idempotent when managed entries are unchanged', async () => {
    await injectGrokGateway(home, config);
    const result = await injectGrokGateway(home, config);
    expect(result.status).toBe('unchanged');
    expect(result.backupPath).toBeUndefined();
  });

  it('preserves runtime-added sections and backs up before updating (재작성 내성)', async () => {
    // grok 가 런타임에 추가하는 블록 흉내 (M0 실측: [marketplace] 자동 추가)
    await writeFile(join(home, 'config.toml'), '[marketplace]\nsources = ["official"]\n');
    const result = await injectGrokGateway(home, config);
    expect(result.status).toBe('updated');
    expect(result.backupPath).toBe(`${result.configPath}.bak`);
    const written = await readConfig(result.configPath);
    expect(written.marketplace).toEqual({ sources: ['official'] });
    expect(written.cli).toEqual({ auto_update: false });
  });

  it('reports drift without overwriting unless forced — 자동 덮어쓰기 금지', async () => {
    await injectGrokGateway(home, config);
    const changed = { ...config, baseUrl: 'http://new-gateway.internal/v1' };
    const drift = await injectGrokGateway(home, changed);
    expect(drift.status).toBe('drift');
    const untouched = await readConfig(drift.configPath);
    expect(
      ((untouched.model as Record<string, Record<string, unknown>>)['grok-4.6'] ?? {}).base_url,
    ).toBe('http://gateway.internal/v1');

    const forced = await injectGrokGateway(home, changed, { force: true });
    expect(forced.status).toBe('updated');
    const updated = await readConfig(forced.configPath);
    expect(
      ((updated.model as Record<string, Record<string, unknown>>)['grok-4.6'] ?? {}).base_url,
    ).toBe('http://new-gateway.internal/v1');
  });

  it('uses defaultModel for [models] pinning when provided', async () => {
    const result = await injectGrokGateway(home, {
      ...config,
      models: [{ id: 'a' }, { id: 'b' }],
      defaultModel: 'b',
    });
    const written = await readConfig(result.configPath);
    expect(written.models).toEqual({ default: 'b', web_search: 'b' });
    expect(Object.keys(written.model as Record<string, unknown>)).toEqual(['a', 'b']);
  });
});
