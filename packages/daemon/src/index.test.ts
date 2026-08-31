import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@custom-harness/protocol';
import type { AgentAdapter } from './adapters/contract.js';
import { FakeAdapter } from './adapters/testing.js';
import { startDaemon } from './index.js';

describe('startDaemon', () => {
  it('설정 우선순위를 기동에 적용한다 — env > settings.json > 기본값 (WBS 5.0.1)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ch-daemon-'));
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({ maxSessions: 3 }));

    const fromFile = await startDaemon({ root, version: '0.1.0', managedBy: 'test' });
    expect(fromFile.manager.getMaxSessions()).toBe(3);
    await fromFile.stop();

    process.env.CUSTOM_HARNESS_MAX_SESSIONS = '11';
    try {
      const fromEnv = await startDaemon({ root, version: '0.1.0', managedBy: 'test' });
      expect(fromEnv.manager.getMaxSessions()).toBe(11); // env 가 파일을 이긴다
      await fromEnv.stop();
    } finally {
      delete process.env.CUSTOM_HARNESS_MAX_SESSIONS;
    }
  });

  it('역방향 툴 등록은 opt-in 이고, 끄면 이전 등록을 지운다 (WBS 7.2.4)', async () => {
    // 어댑터 id 로 등록 대상이 정해지므로 omp 로 위장한다 — 실물 omp 없이 배선만 본다
    const ompAdapter: AgentAdapter = Object.assign(new FakeAdapter(), { id: 'omp' as const });
    const root = await mkdtemp(join(tmpdir(), 'ch-daemon-'));
    await mkdir(join(root, 'data'), { recursive: true });
    const settingsFile = join(root, 'data', 'settings.json');
    const mcpConfig = join(root, 'data', 'omp-home', 'mcp.json');

    // 기본값(off) — 등록이 생기지 않는다
    const off = await startDaemon({
      root,
      version: '0.1.0',
      managedBy: 'test',
      adapters: () => [ompAdapter],
    });
    await off.stop();
    await expect(stat(mcpConfig)).rejects.toThrow();

    // 켜면 등록된다
    await writeFile(settingsFile, JSON.stringify({ tools: { reverseExposure: true } }));
    const on = await startDaemon({
      root,
      version: '0.1.0',
      managedBy: 'test',
      adapters: () => [ompAdapter],
    });
    await on.stop();
    const registered = JSON.parse(await readFile(mcpConfig, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(registered.mcpServers.ch).toBeDefined();

    // 다시 끄면 남아 있던 등록이 사라진다 — 안 지우면 부를 때마다 거부되는 툴이 계속 보인다
    await writeFile(settingsFile, JSON.stringify({ tools: { reverseExposure: false } }));
    const offAgain = await startDaemon({
      root,
      version: '0.1.0',
      managedBy: 'test',
      adapters: () => [ompAdapter],
    });
    await offAgain.stop();
    const cleaned = JSON.parse(await readFile(mcpConfig, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(cleaned.mcpServers.ch).toBeUndefined();
  });

  it('boots, authenticates via the token file, and cleans up on stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ch-daemon-'));
    const daemon = await startDaemon({ root, version: '0.1.0', managedBy: 'test' });

    // 토큰 파일 0600 (protocol-design §4) — Windows 는 POSIX 모드 무의미(ACL 기반), 검사 제외
    if (process.platform !== 'win32') {
      const mode = (await stat(daemon.paths.tokenFile)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    const token = await readFile(daemon.paths.tokenFile, 'utf8');
    expect(token).toBe(daemon.token);

    const pid = JSON.parse(await readFile(daemon.paths.pidFile, 'utf8'));
    expect(pid).toMatchObject({ pid: process.pid, managedBy: 'test' });

    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'test', version: '0.0.0' },
        capabilities: {},
      }),
    );
    const helloResponse = await new Promise<unknown>((resolve) =>
      ws.once('message', (data) => resolve(JSON.parse(String(data)))),
    );
    expect(helloResponse).toMatchObject({ type: 'hello.response' });
    ws.close();

    await daemon.stop();
    // 셧다운 정리 — 토큰·pid 파일 삭제 (daemon-design §3)
    await expect(stat(daemon.paths.tokenFile)).rejects.toThrow();
    await expect(stat(daemon.paths.pidFile)).rejects.toThrow();
  });
});
