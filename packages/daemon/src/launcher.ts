// 데몬 런처 (WBS 1.6.1/1.6.2, FR-1.1.5·FR-5.1·FR-5.2)
// 셸·CLI 가 공용으로 쓰는 detached 데몬 스폰·발견·정지. 데몬 프로세스는
// Electron 실행 파일 + ELECTRON_RUN_AS_NODE=1 로 Node 런타임을 겸한다 (FR-4.1.3).
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import type { DaemonPaths } from './paths.js';

export interface DaemonInfo {
  pid: number;
  port: number | null;
  managedBy: string;
  bundleVersion: string | null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * daemon.pid 를 읽고 생존 확인. stale(프로세스 부재) 파일은 정리하고 undefined (FR-5.2).
 */
export async function readDaemonInfo(paths: DaemonPaths): Promise<DaemonInfo | undefined> {
  let raw: string;
  try {
    raw = await readFile(paths.pidFile, 'utf8');
  } catch {
    return undefined;
  }
  let info: DaemonInfo;
  try {
    const parsed = JSON.parse(raw) as Partial<DaemonInfo>;
    if (typeof parsed.pid !== 'number') throw new Error('pid 없음');
    info = {
      pid: parsed.pid,
      port: typeof parsed.port === 'number' ? parsed.port : null,
      managedBy: typeof parsed.managedBy === 'string' ? parsed.managedBy : 'unknown',
      bundleVersion: typeof parsed.bundleVersion === 'string' ? parsed.bundleVersion : null,
    };
  } catch {
    await rm(paths.pidFile, { force: true }); // 파손 파일도 stale 취급
    return undefined;
  }
  if (!processAlive(info.pid)) {
    await rm(paths.pidFile, { force: true });
    return undefined;
  }
  return info;
}

export interface LaunchOptions {
  paths: DaemonPaths;
  /** 데몬 진입점 JS (packages/daemon dist/main.js 또는 번들 경로) */
  entryPath: string;
  /** app(셸) | cli — 소유 구분 (FR-5.2) */
  managedBy: 'app' | 'cli';
  /** 기본 process.execPath — 번들에선 Electron 바이너리 */
  execPath?: string;
  env?: Record<string, string>;
  waitTimeoutMs?: number;
}

export interface LaunchResult {
  info: DaemonInfo;
  token: string;
  alreadyRunning: boolean;
}

/** 이미 실행 중이면 no-op + 기존 정보 반환 (FR-5.1) */
export async function launchDetachedDaemon(options: LaunchOptions): Promise<LaunchResult> {
  const { paths } = options;
  const existing = await readDaemonInfo(paths);
  if (existing) {
    return {
      info: existing,
      token: (await readFile(paths.tokenFile, 'utf8')).trim(),
      alreadyRunning: true,
    };
  }

  await mkdir(paths.logsDir, { recursive: true });
  const log = await open(`${paths.logsDir}/daemon.log`, 'a');
  const child = spawn(options.execPath ?? process.execPath, [options.entryPath], {
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      CUSTOM_HARNESS_HOME: paths.root,
      CUSTOM_HARNESS_MANAGED_BY: options.managedBy,
      ...options.env,
    },
  });
  child.unref();
  await log.close();

  const deadline = Date.now() + (options.waitTimeoutMs ?? 10_000);
  for (;;) {
    const info = await readDaemonInfo(paths);
    if (info && info.port !== null) {
      try {
        const token = (await readFile(paths.tokenFile, 'utf8')).trim();
        if (token) return { info, token, alreadyRunning: false };
      } catch {
        // 토큰 파일이 아직 — 계속 대기
      }
    }
    if (child.exitCode !== null && !info) {
      throw new Error(
        `데몬 기동 실패 (exit=${child.exitCode}) — 로그: ${paths.logsDir}/daemon.log`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`데몬 기동 대기 타임아웃 — 로그: ${paths.logsDir}/daemon.log`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** 정상 종료(SIGTERM) → 대기 → 잔존 시 false 반환 (강제 종료는 호출자 판단) */
export async function stopDaemon(
  paths: DaemonPaths,
  options: { timeoutMs?: number } = {},
): Promise<{ stopped: boolean; wasRunning: boolean }> {
  const info = await readDaemonInfo(paths);
  if (!info) return { stopped: true, wasRunning: false };
  try {
    process.kill(info.pid, 'SIGTERM');
  } catch {
    await rm(paths.pidFile, { force: true });
    return { stopped: true, wasRunning: false };
  }
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    if (!processAlive(info.pid)) {
      await rm(paths.pidFile, { force: true });
      return { stopped: true, wasRunning: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { stopped: false, wasRunning: true };
}
