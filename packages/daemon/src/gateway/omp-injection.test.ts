import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { beforeEach, describe, expect, it } from 'vitest';
import { injectOmpGateway, type OmpInjectionConfig } from './omp-injection.js';

const config: OmpInjectionConfig = {
  baseUrl: 'http://gateway.internal/v1',
  providerName: 'gateway',
  apiKeyEnvVar: 'CUSTOM_HARNESS_GATEWAY_KEY',
  models: [{ id: 'grok-4.6', name: 'Grok 4.6 (사내)' }],
};

const readYaml = async (path: string): Promise<Record<string, unknown>> =>
  parseYaml(await readFile(path, 'utf8')) as Record<string, unknown>;

describe('injectOmpGateway (WBS 2.1.3, FR-2.1.2/FR-2.2)', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ch-omphome-'));
  });

  it('creates models.yml (bare env apiKey) + config.yml (modelRoles·오프라인 프리셋)', async () => {
    const result = await injectOmpGateway(home, config);
    expect(result.status).toBe('created');

    const models = await readYaml(result.modelsPath);
    expect(models.providers).toEqual({
      gateway: {
        baseUrl: 'http://gateway.internal/v1',
        api: 'openai-completions',
        // omp 는 값을 env 변수명으로 우선 해석 (17.3.8 실측) — pi 의 "$VAR" 표기와 다름
        apiKey: 'CUSTOM_HARNESS_GATEWAY_KEY',
        authHeader: true,
        models: [{ id: 'grok-4.6', name: 'Grok 4.6 (사내)' }],
      },
    });

    const cfg = await readYaml(result.configPath);
    expect(cfg).toEqual({
      modelRoles: { default: 'gateway/grok-4.6' },
      startup: { checkUpdate: false },
      marketplace: { autoUpdate: false },
      dev: { autoqa: false, autoqaConsent: 'denied' },
    });
  });

  it('uses defaultModel for modelRoles.default when provided', async () => {
    const result = await injectOmpGateway(home, {
      ...config,
      models: [{ id: 'a' }, { id: 'b' }],
      defaultModel: 'b',
    });
    const cfg = await readYaml(result.configPath);
    expect(cfg.modelRoles).toEqual({ default: 'gateway/b' });
  });

  it('is idempotent when managed entries are unchanged', async () => {
    await injectOmpGateway(home, config);
    const result = await injectOmpGateway(home, config);
    expect(result.status).toBe('unchanged');
    expect(result.backupPaths).toEqual([]);
  });

  it('preserves user entries and backs up before updating', async () => {
    await writeFile(
      join(home, 'models.yml'),
      'providers:\n  ollama:\n    baseUrl: http://localhost:11434/v1\n',
    );
    await writeFile(join(home, 'config.yml'), 'theme:\n  dark: titanium\n');
    const result = await injectOmpGateway(home, config);
    expect(result.status).toBe('updated');
    expect(result.backupPaths).toEqual([`${result.modelsPath}.bak`, `${result.configPath}.bak`]);

    const models = await readYaml(result.modelsPath);
    expect((models.providers as Record<string, unknown>).ollama).toEqual({
      baseUrl: 'http://localhost:11434/v1',
    });
    expect((models.providers as Record<string, unknown>).gateway).toBeDefined();

    const cfg = await readYaml(result.configPath);
    expect(cfg.theme).toEqual({ dark: 'titanium' });
    expect(cfg.startup).toEqual({ checkUpdate: false });
  });

  it('reports drift without touching either file unless forced — 자동 덮어쓰기 금지', async () => {
    await injectOmpGateway(home, config);
    const changed = { ...config, baseUrl: 'http://new-gateway.internal/v1' };
    const drift = await injectOmpGateway(home, changed);
    expect(drift.status).toBe('drift');
    const untouched = await readYaml(drift.modelsPath);
    expect((untouched.providers as Record<string, Record<string, unknown>>).gateway!.baseUrl).toBe(
      'http://gateway.internal/v1',
    );

    const forced = await injectOmpGateway(home, changed, { force: true });
    expect(forced.status).toBe('updated');
    const updated = await readYaml(forced.modelsPath);
    expect((updated.providers as Record<string, Record<string, unknown>>).gateway!.baseUrl).toBe(
      'http://new-gateway.internal/v1',
    );
  });

  it('treats a user-modified managed config key as drift (config.yml 측)', async () => {
    await injectOmpGateway(home, config);
    // 사용자가 오프라인 프리셋을 되돌린 상황
    const configPath = join(home, 'config.yml');
    const cfg = await readYaml(configPath);
    (cfg.startup as Record<string, unknown>).checkUpdate = true;
    await writeFile(
      configPath,
      `startup:\n  checkUpdate: true\nmodelRoles:\n  default: gateway/grok-4.6\nmarketplace:\n  autoUpdate: false\ndev:\n  autoqa: false\n  autoqaConsent: denied\n`,
    );
    const drift = await injectOmpGateway(home, config);
    expect(drift.status).toBe('drift');
  });

  it('includes compat flags when configured (FR-2.1.1)', async () => {
    const result = await injectOmpGateway(home, {
      ...config,
      compat: { supportsDeveloperRole: false },
    });
    const models = await readYaml(result.modelsPath);
    expect((models.providers as Record<string, Record<string, unknown>>).gateway!.compat).toEqual({
      supportsDeveloperRole: false,
    });
  });
});
