import { spawn } from 'node:child_process';
import { mkdtemp, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { launchDetachedDaemon, readDaemonInfo, stopDaemon } from './launcher.js';
import { resolvePaths, type DaemonPaths } from './paths.js';

const fixture = fileURLToPath(new URL('./fake-daemon.fixture.cjs', import.meta.url));

describe('daemon launcher (WBS 1.6.1/1.6.2, FR-5.1/5.2)', () => {
  let paths: DaemonPaths;

  beforeEach(async () => {
    paths = resolvePaths(await mkdtemp(join(tmpdir(), 'ch-launch-')));
  });

  async function launch() {
    return launchDetachedDaemon({
      paths,
      entryPath: fixture,
      managedBy: 'cli',
      execPath: process.execPath, // 테스트는 node 직접 — 번들에선 Electron+RUN_AS_NODE
      waitTimeoutMs: 5000,
    });
  }

  it('spawns detached, waits for pid/port/token, and no-ops when already running', async () => {
    const first = await launch();
    try {
      expect(first.alreadyRunning).toBe(false);
      expect(first.info.port).toBe(43210);
      expect(first.info.managedBy).toBe('cli');
      expect(first.token).toBe('fixture-token');

      const second = await launch();
      expect(second.alreadyRunning).toBe(true);
      expect(second.info.pid).toBe(first.info.pid);
    } finally {
      await stopDaemon(paths);
    }
  });

  it('stops via SIGTERM and clears the pid file', async () => {
    const { info } = await launch();
    const result = await stopDaemon(paths);
    expect(result).toEqual({ stopped: true, wasRunning: true });
    expect(await readDaemonInfo(paths)).toBeUndefined();
    // 프로세스도 소멸
    expect(() => process.kill(info.pid, 0)).toThrow();
  });

  it('cleans a stale pid file (FR-5.2)', async () => {
    // 이미 죽은 프로세스의 pid 확보
    const dead = spawn(process.execPath, ['-e', '']);
    const deadPid = dead.pid!;
    await new Promise((resolve) => dead.once('exit', resolve));

    await mkdir(paths.dataDir, { recursive: true });
    await writeFile(
      paths.pidFile,
      JSON.stringify({ pid: deadPid, port: 1, managedBy: 'cli', bundleVersion: null }),
    );
    expect(await readDaemonInfo(paths)).toBeUndefined();
    await expect(stat(paths.pidFile)).rejects.toThrow(); // 정리됨
  });

  it('reports a startup failure with the log path', async () => {
    await expect(
      launchDetachedDaemon({
        paths,
        entryPath: fixture,
        managedBy: 'cli',
        execPath: process.execPath,
        env: { FAKE_DAEMON_FAIL: '1' },
        waitTimeoutMs: 3000,
      }),
    ).rejects.toThrow(/기동 실패|타임아웃/);
  });

  it('treats a corrupt pid file as stale', async () => {
    await mkdir(paths.dataDir, { recursive: true });
    await writeFile(paths.pidFile, 'not-json');
    expect(await readDaemonInfo(paths)).toBeUndefined();
  });
});
