import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { parse as parseYaml } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePaths, type DaemonPaths } from '../paths.js';
import { KeyStore } from './key-store.js';
import { GatewayService } from './service.js';

/** 목 게이트웨이 — OpenAI 호환 /v1/chat/completions (+선택적 /v1/models), Bearer 키 검사 */
function startMockGateway(
  validKey: string,
  options: { modelsEndpoint?: string[] } = {},
): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === '/v1/models' && options.modelsEndpoint) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ data: options.modelsEndpoint.map((id) => ({ id, object: 'model' })) }),
        );
        return;
      }
      if (req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      if (req.headers.authorization !== `Bearer ${validKey}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid key' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

describe('GatewayService (WBS 1.4)', () => {
  let paths: DaemonPaths;
  let keyStore: KeyStore;
  let service: GatewayService;
  let mock: { server: Server; baseUrl: string };

  beforeEach(async () => {
    paths = resolvePaths(await mkdtemp(join(tmpdir(), 'ch-gw-')));
    keyStore = new KeyStore(paths.credentialsFile);
    service = new GatewayService(paths, keyStore);
    mock = await startMockGateway('sk-valid');
  });

  afterEach(() => {
    mock.server.close();
  });

  async function configure(): Promise<void> {
    await service.setConfig({
      baseUrl: mock.baseUrl,
      models: [{ id: 'grok-4.6' }],
      defaultModel: 'grok-4.6',
    });
  }

  it('persists config with defaults and injects pi models.json on setConfig', async () => {
    await configure();
    expect(await service.getConfig()).toMatchObject({
      baseUrl: mock.baseUrl,
      providerName: 'gateway',
      apiKeyEnvVar: 'CUSTOM_HARNESS_GATEWAY_KEY',
      defaultModel: 'grok-4.6',
    });
    const injected = JSON.parse(await readFile(join(paths.piHomeDir, 'models.json'), 'utf8'));
    expect(injected.providers.gateway.baseUrl).toBe(mock.baseUrl);
  });

  it('returns undefined config before onboarding', async () => {
    expect(await service.getConfig()).toBeUndefined();
    expect(await service.ensurePiInjection()).toBeUndefined();
  });

  it('builds the pi spawn env overlay: 격리 홈 + 오프라인 + 키 (FR-2.1.4, FR-2.2)', async () => {
    await configure();
    await keyStore.set('sk-valid');
    expect(await service.buildEnv('pi')).toEqual({
      PI_CODING_AGENT_DIR: paths.piHomeDir,
      PI_OFFLINE: '1',
      CUSTOM_HARNESS_GATEWAY_KEY: 'sk-valid',
    });
    // 키 미저장 시 키 변수는 빠진다
    await keyStore.delete();
    expect(await service.buildEnv('pi')).toEqual({
      PI_CODING_AGENT_DIR: paths.piHomeDir,
      PI_OFFLINE: '1',
    });
    expect(await service.buildEnv('grok')).toEqual({ GROK_HOME: paths.grokHomeDir });
  });

  it('builds the omp spawn env overlay and injects models.yml·config.yml (WBS 2.1.3)', async () => {
    await configure();
    await keyStore.set('sk-valid');
    // omp 는 PI_OFFLINE 미지원(실측) — 오프라인 차단은 config.yml 프리셋 담당
    expect(await service.buildEnv('omp')).toEqual({
      PI_CODING_AGENT_DIR: paths.ompHomeDir,
      CUSTOM_HARNESS_GATEWAY_KEY: 'sk-valid',
    });
    const models = parseYaml(await readFile(join(paths.ompHomeDir, 'models.yml'), 'utf8')) as {
      providers: Record<string, { baseUrl: string; apiKey: string }>;
    };
    expect(models.providers.gateway).toMatchObject({
      baseUrl: mock.baseUrl,
      apiKey: 'CUSTOM_HARNESS_GATEWAY_KEY',
    });
    const cfg = parseYaml(await readFile(join(paths.ompHomeDir, 'config.yml'), 'utf8')) as {
      modelRoles: { default: string };
      startup: { checkUpdate: boolean };
    };
    expect(cfg.modelRoles.default).toBe('gateway/grok-4.6');
    expect(cfg.startup.checkUpdate).toBe(false);
  });

  it('builds the grok spawn env overlay and injects config.toml (WBS 2.2.2)', async () => {
    await configure();
    await keyStore.set('sk-valid');
    expect(await service.buildEnv('grok')).toEqual({
      GROK_HOME: paths.grokHomeDir,
      CUSTOM_HARNESS_GATEWAY_KEY: 'sk-valid',
    });
    const toml = parseToml(await readFile(join(paths.grokHomeDir, 'config.toml'), 'utf8')) as {
      features: { telemetry: boolean; remote_fetch: boolean };
      models: { default: string };
      model: Record<string, { base_url: string; env_key: string }>;
    };
    expect(toml.features.telemetry).toBe(false);
    expect(toml.features.remote_fetch).toBe(false);
    expect(toml.models.default).toBe('grok-4.6');
    expect(toml.model['grok-4.6']).toMatchObject({
      base_url: mock.baseUrl,
      env_key: 'CUSTOM_HARNESS_GATEWAY_KEY',
    });
  });

  it('falls back to the static catalog when /models is unsupported (FR-2.4, WBS 2.3.4)', async () => {
    await configure(); // 기본 mock 은 /models 미지원 (404)
    const models = await service.listModels();
    expect(models).toEqual([{ id: 'grok-4.6' }]);
  });

  it('queries the gateway /models when supported (FR-2.4)', async () => {
    const withModels = await startMockGateway('sk-valid', {
      modelsEndpoint: ['grok-4.6', 'grok-4.6-mini'],
    });
    try {
      await service.setConfig({
        baseUrl: withModels.baseUrl,
        models: [{ id: 'static-only' }],
        defaultModel: 'grok-4.6',
      });
      const models = await service.listModels();
      expect(models.map((m) => m.id)).toEqual(['grok-4.6', 'grok-4.6-mini']);
      // 60초 캐시 — 동일 인스턴스 재호출은 재조회 없이 동일 결과
      expect(await service.listModels()).toEqual(models);
    } finally {
      withModels.server.close();
    }
  });

  it('detects traffic-boundary violations across harness configs (FR-2.5, WBS 2.3.5)', async () => {
    await configure(); // 3 하네스 주입 완료 — 전부 게이트웨이 목적지
    expect(await service.checkTrafficBoundaries()).toEqual([]);

    // 사용자가 omp models.yml 에 외부 프로바이더를 추가한 상황
    const ompModels = join(paths.ompHomeDir, 'models.yml');
    const tampered = `${await readFile(ompModels, 'utf8')}  rogue:\n    baseUrl: https://api.openai.com/v1\n`;
    await writeFile(ompModels, tampered);
    const violations = await service.checkTrafficBoundaries();
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      harness: 'omp',
      url: 'https://api.openai.com/v1',
      location: 'omp-home/models.yml providers.rogue',
    });
    // 화이트리스트로 허용 가능
    expect(await service.checkTrafficBoundaries(['https://api.openai.com/v1'])).toEqual([]);
  });

  it('persists and validates maxSessions (FR-1.7, WBS 2.3.1)', async () => {
    expect(await service.getMaxSessions()).toBe(8); // 기본값
    await service.setMaxSessions(3);
    expect(await service.getMaxSessions()).toBe(3);
    await expect(service.setMaxSessions(0)).rejects.toThrow('1~64');
    await expect(service.setMaxSessions(1.5)).rejects.toThrow('1~64');
  });

  it('validates a correct key against the gateway (FR-2.3.1)', async () => {
    await configure();
    await keyStore.set('sk-valid');
    expect(await service.testKey()).toEqual({ valid: true });
  });

  it('reports auth failure for a wrong key', async () => {
    await configure();
    await keyStore.set('sk-wrong');
    const result = await service.testKey();
    expect(result.valid).toBe(false);
    expect(result.detail).toContain('401');
  });

  it('reports missing prerequisites and network failures with causes', async () => {
    expect((await service.testKey()).detail).toContain('gateway 미설정');
    await configure();
    expect((await service.testKey()).detail).toContain('저장된 키 없음');

    await keyStore.set('sk-valid');
    mock.server.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = await service.testKey();
    expect(result.valid).toBe(false);
    expect(result.detail).toContain('네트워크 오류');
  });
});
