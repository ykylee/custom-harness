import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { injectPiGateway, type PiInjectionConfig } from './pi-injection.js';

const config: PiInjectionConfig = {
  baseUrl: 'http://gateway.internal/v1',
  providerName: 'gateway',
  apiKeyEnvVar: 'CUSTOM_HARNESS_GATEWAY_KEY',
  models: [{ id: 'grok-4.6', name: 'Grok 4.6 (사내)' }],
};

describe('injectPiGateway (FR-2.1.1/2.1.4)', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ch-pihome-'));
  });

  it('creates models.json with an env-interpolated apiKey — 평문 키 금지', async () => {
    const result = await injectPiGateway(home, config);
    expect(result.status).toBe('created');
    const written = JSON.parse(await readFile(result.modelsPath, 'utf8'));
    expect(written.providers.gateway).toEqual({
      baseUrl: 'http://gateway.internal/v1',
      api: 'openai-completions',
      apiKey: '$CUSTOM_HARNESS_GATEWAY_KEY',
      authHeader: true,
      models: [{ id: 'grok-4.6', name: 'Grok 4.6 (사내)' }],
    });
  });

  it('is idempotent when the managed block is unchanged', async () => {
    await injectPiGateway(home, config);
    const result = await injectPiGateway(home, config);
    expect(result.status).toBe('unchanged');
    expect(result.backupPath).toBeUndefined();
  });

  it('preserves user-added providers and backs up before updating', async () => {
    const modelsPath = join(home, 'models.json');
    await writeFile(
      modelsPath,
      JSON.stringify({ providers: { ollama: { baseUrl: 'http://localhost:11434/v1' } } }),
    );
    const result = await injectPiGateway(home, config);
    expect(result.status).toBe('updated');
    expect(result.backupPath).toBe(`${modelsPath}.bak`);

    const written = JSON.parse(await readFile(modelsPath, 'utf8'));
    expect(written.providers.ollama).toEqual({ baseUrl: 'http://localhost:11434/v1' });
    expect(written.providers.gateway.apiKey).toBe('$CUSTOM_HARNESS_GATEWAY_KEY');

    const backup = JSON.parse(await readFile(result.backupPath!, 'utf8'));
    expect(backup.providers.gateway).toBeUndefined();
  });

  it('reports drift without overwriting unless forced — 자동 덮어쓰기 금지', async () => {
    await injectPiGateway(home, config);
    const changed = { ...config, baseUrl: 'http://new-gateway.internal/v1' };
    const drift = await injectPiGateway(home, changed);
    expect(drift.status).toBe('drift');
    // 파일은 그대로
    const untouched = JSON.parse(await readFile(drift.modelsPath, 'utf8'));
    expect(untouched.providers.gateway.baseUrl).toBe('http://gateway.internal/v1');

    const forced = await injectPiGateway(home, changed, { force: true });
    expect(forced.status).toBe('updated');
    const updated = JSON.parse(await readFile(forced.modelsPath, 'utf8'));
    expect(updated.providers.gateway.baseUrl).toBe('http://new-gateway.internal/v1');
  });

  it('includes compat flags when configured (FR-2.1.1)', async () => {
    const result = await injectPiGateway(home, {
      ...config,
      compat: { supportsDeveloperRole: false },
    });
    const written = JSON.parse(await readFile(result.modelsPath, 'utf8'));
    expect(written.providers.gateway.compat).toEqual({ supportsDeveloperRole: false });
  });
});
