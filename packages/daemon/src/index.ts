// @custom-harness/daemon — 데몬 조립 진입점 (daemon-design, WBS 1.2)
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { AgentAdapter } from './adapters/contract.js';
import { KeyStore, type SecretCipher } from './gateway/key-store.js';
import { GatewayService } from './gateway/service.js';
import { resolvePaths, type DaemonPaths } from './paths.js';
import { ProcessSupervisor } from './processes.js';
import { DaemonServer } from './server.js';
import { SessionManager } from './session-manager.js';
import { SessionStore } from './store.js';
import { generateToken, removeTokenFile, writeTokenFile } from './token.js';

export * from './adapters/contract.js';
export * from './adapters/mock.js';
export * from './adapters/jsonl-rpc/transport.js';
export * from './adapters/jsonl-rpc/pi.js';
export * from './errors.js';
export * from './gateway/key-store.js';
export * from './gateway/pi-injection.js';
export * from './gateway/service.js';
export * from './launcher.js';
export * from './paths.js';
export * from './processes.js';
export * from './server.js';
export * from './session-manager.js';
export * from './store.js';
export * from './token.js';

export interface AdapterFactoryContext {
  paths: DaemonPaths;
  supervisor: ProcessSupervisor;
}

export interface StartDaemonOptions {
  /** 데이터 루트 — 기본 ~/.custom-harness (CUSTOM_HARNESS_HOME 오버라이드 가능) */
  root?: string;
  /** 배열 또는 팩토리 — 팩토리는 데몬의 paths·supervisor 를 받아 어댑터를 조립 */
  adapters?: AgentAdapter[] | ((ctx: AdapterFactoryContext) => AgentAdapter[]);
  port?: number;
  version?: string;
  /** daemon.pid 의 소유 구분 (FR-5.2) */
  managedBy?: string;
  bundleVersion?: string;
  maxSessions?: number;
  /** 키 암호화 공급자 — 셸이 Electron safeStorage 를 주입 (미공급 시 0600 폴백) */
  secretCipher?: SecretCipher;
}

export interface DaemonHandle {
  port: number;
  token: string;
  paths: DaemonPaths;
  manager: SessionManager;
  supervisor: ProcessSupervisor;
  gateway: GatewayService;
  keyStore: KeyStore;
  stop(): Promise<void>;
}

export async function startDaemon(options: StartDaemonOptions = {}): Promise<DaemonHandle> {
  const paths = resolvePaths(options.root);
  await mkdir(paths.sessionsDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });

  // 토큰은 기동 시 회전 (protocol-design §4)
  const token = generateToken();
  await writeTokenFile(paths.tokenFile, token);

  const store = new SessionStore(paths.sessionsDir);
  const supervisor = new ProcessSupervisor({
    ledgerPath: paths.processesFile,
    ...(options.bundleVersion !== undefined ? { bundleVersion: options.bundleVersion } : {}),
  });
  const keyStore = new KeyStore(paths.credentialsFile, options.secretCipher);
  const gateway = new GatewayService(paths, keyStore);
  const adapters =
    typeof options.adapters === 'function'
      ? options.adapters({ paths, supervisor })
      : (options.adapters ?? []);
  const manager = new SessionManager({
    store,
    adapters,
    buildEnv: (harness) => gateway.buildEnv(harness),
    ...(options.maxSessions !== undefined ? { maxSessions: options.maxSessions } : {}),
  });
  await manager.init();

  // 기동 시 주입 검증·복구 — 드리프트는 자동 덮어쓰기 금지, 경고만 (credential-injection-design §2)
  const injection = await gateway.ensurePiInjection();
  if (injection?.status === 'drift') {
    console.warn(
      `[daemon] pi models.json 관리 블록 드리프트 감지 — 자동 복구 안 함 (${injection.modelsPath})`,
    );
  }

  const server = new DaemonServer({
    manager,
    token,
    serverVersion: options.version ?? '0.0.0',
    gateway,
    keyStore,
    ...(options.port !== undefined ? { port: options.port } : {}),
    onShutdownRequest: () => void stop(),
  });
  const { port } = await server.start();

  // port 는 additive 확장 — 셸·CLI 가 접속 지점을 발견하는 경로 (daemon.pid + daemon.token 페어)
  await writeFile(
    paths.pidFile,
    JSON.stringify({
      pid: process.pid,
      port,
      managedBy: options.managedBy ?? 'standalone',
      bundleVersion: options.bundleVersion ?? null,
    }),
  );

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // 셧다운 순서: 서버 → 세션 정리 → 프로세스 정리 → 원장·토큰·pid 정리 (daemon-design §3)
    await server.stop();
    await manager.shutdown();
    await supervisor.terminateAll();
    await removeTokenFile(paths.tokenFile);
    await rm(paths.pidFile, { force: true });
  };

  return { port, token, paths, manager, supervisor, gateway, keyStore, stop };
}
