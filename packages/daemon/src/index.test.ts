import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@custom-harness/protocol';
import { startDaemon } from './index.js';

describe('startDaemon', () => {
  it('boots, authenticates via the token file, and cleans up on stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ch-daemon-'));
    const daemon = await startDaemon({ root, version: '0.1.0', managedBy: 'test' });

    // 토큰 파일 0600 (protocol-design §4)
    const mode = (await stat(daemon.paths.tokenFile)).mode & 0o777;
    expect(mode).toBe(0o600);
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
