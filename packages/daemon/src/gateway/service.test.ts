import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePaths, type DaemonPaths } from '../paths.js';
import { KeyStore } from './key-store.js';
import { GatewayService } from './service.js';

/** 목 게이트웨이 — OpenAI 호환 /v1/chat/completions, Bearer 키 검사 */
function startMockGateway(validKey: string): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
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
