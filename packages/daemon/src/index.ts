// @custom-harness/daemon — 데몬 조립 진입점 (daemon-design, WBS 1.2)
import { access, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentAdapter } from './adapters/contract.js';
import { KeyStore, type SecretCipher } from './gateway/key-store.js';
import { GatewayService } from './gateway/service.js';
import { loadBundleManifest } from './manifest.js';
import {
  piExtensionEnv,
  registerGrokMcpServer,
  registerOmpMcpServer,
  registerPiExtension,
  resolveMcpServerSpec,
} from './mcp/registration.js';
import { resolvePaths, type DaemonPaths } from './paths.js';
import { ProcessSupervisor } from './processes.js';
import { DaemonServer } from './server.js';
import { SessionManager } from './session-manager.js';
import { SettingsStore } from './settings.js';
import { TerminalManager } from './terminals.js';
import { WorkspaceProvisioning } from './workspaces/registry.js';
import { SessionStore } from './store.js';
import { generateToken, removeTokenFile, writeTokenFile } from './token.js';

export * from './adapters/contract.js';
export * from './adapters/mock.js';
export * from './adapters/jsonl-rpc/transport.js';
export * from './adapters/jsonl-rpc/session-core.js';
export * from './adapters/jsonl-rpc/pi.js';
export * from './adapters/jsonl-rpc/omp.js';
export * from './adapters/acp/client.js';
export * from './adapters/acp/grok.js';
export * from './errors.js';
export * from './gateway/key-store.js';
export * from './gateway/pi-injection.js';
export * from './gateway/omp-injection.js';
export * from './gateway/grok-injection.js';
export * from './gateway/home-isolation.js';
export * from './mcp/server.js';
export * from './mcp/tools.js';
export * from './mcp/registration.js';
export * from './gateway/service.js';
export * from './launcher.js';
export * from './manifest.js';
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
  /** 번들 manifest.json 경로 — 버전 검증(FR-1.8, WBS 2.3.3). 미공급·미존재 시 검증 생략 */
  manifestPath?: string;
  /**
   * 하네스 실행 파일 경로 — 역방향 MCP 등록에 쓴다 (WBS 7.2.3).
   * grok 등록은 `grok mcp add` 위임이라 바이너리가 필요하다. 미공급이면 그 하네스는 등록을 건너뛴다.
   */
  harnessExecPaths?: { grok?: string };
}

export interface DaemonHandle {
  port: number;
  token: string;
  paths: DaemonPaths;
  manager: SessionManager;
  supervisor: ProcessSupervisor;
  gateway: GatewayService;
  keyStore: KeyStore;
  /** 프로젝트·워크스페이스 레지스트리 (WBS 5.2·5.3) */
  provisioning: WorkspaceProvisioning;
  /** 데몬 소유 터미널 (WBS 6.3) */
  terminals: TerminalManager;
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
    // 하네스 stderr 로그 (WBS 2.6.2) — logs/<harness>-<sessionId>.log
    harnessLogDir: paths.logsDir,
    ...(options.bundleVersion !== undefined ? { bundleVersion: options.bundleVersion } : {}),
  });
  // 이전 실행 잔존 프로세스 회수 (FR-1.1.4, WBS 2.3.2) — spawn 시작 전에 수행
  const reaped = await supervisor.reapStale();
  if (reaped.terminated.length > 0 || reaped.removed.length > 0) {
    console.warn(
      `[daemon] stale 프로세스 회수: 종료 ${reaped.terminated.length}건, 원장 정리 ${reaped.removed.length}건`,
    );
  }
  const keyStore = new KeyStore(paths.credentialsFile, options.secretCipher);
  // 설정 우선순위·핫 리로드의 단일 지점 (WBS 5.0.1) — 게이트웨이 서비스와 데몬이 같은 인스턴스를 본다
  const settings = new SettingsStore(paths.settingsFile);
  await settings.load();
  const gateway = new GatewayService(paths, keyStore, settings);
  const manifest =
    options.manifestPath !== undefined ? await loadBundleManifest(options.manifestPath) : undefined;
  const adapters =
    typeof options.adapters === 'function'
      ? options.adapters({ paths, supervisor })
      : (options.adapters ?? []);
  // 프로젝트·워크스페이스 레지스트리 (WBS 5.2·5.3) — 레코드 생성의 단일 창구
  const provisioning = new WorkspaceProvisioning(paths);
  // 데몬 소유 터미널 (WBS 6.3) — 클라이언트가 끊겨도 pty 는 살아 있다
  const terminals = new TerminalManager();
  // pi 확장이 쓸 spawn 사양 — 아래 등록 단계에서 채워지고, buildEnv 클로저가 **호출 시점에**
  // 읽는다(세션 생성은 등록 뒤에 일어난다). 선언을 여기 두어 그 의존을 눈에 보이게 한다.
  let piReverseToolsEnv: Record<string, string> | undefined;
  const manager = new SessionManager({
    store,
    adapters,
    buildEnv: async (harness) => {
      const env = await gateway.buildEnv(harness);
      // pi 확장은 MCP 서버 spawn 사양을 env 로 받는다 (7.2.3b) — 게이트웨이 관심사가
      // 아니므로 여기서 얹는다
      return harness === 'pi' && piReverseToolsEnv !== undefined
        ? { ...env, ...piReverseToolsEnv }
        : env;
    },
    // 우선순위: 명시 옵션 > settings.json (WBS 2.3.1)
    maxSessions: options.maxSessions ?? (await gateway.getMaxSessions()),
    ...(manifest !== undefined ? { manifest } : {}),
  });
  await manager.init();

  // 세션 워크스페이스 백필 (WBS 5.4.2, workspace-model §9) — 1회만 실행하고 마커를 남긴다.
  // cwd → workspaceId 매핑이 존재하는 유일한 지점이며, 실패한 세션은 건너뛰고 기동을 막지 않는다.
  await runWorkspaceBackfill(paths, manager, provisioning);

  // 기동 시 주입 검증·복구 — 드리프트는 자동 덮어쓰기 금지, 경고만 (credential-injection-design §2)
  const injection = await gateway.ensurePiInjection();
  if (injection?.status === 'drift') {
    console.warn(
      `[daemon] pi models.json 관리 블록 드리프트 감지 — 자동 복구 안 함 (${injection.modelsPath})`,
    );
  }
  const ompInjection = await gateway.ensureOmpInjection();
  if (ompInjection?.status === 'drift') {
    console.warn(
      `[daemon] omp 관리 항목 드리프트 감지 — 자동 복구 안 함 (${ompInjection.modelsPath}, ${ompInjection.configPath})`,
    );
  }
  const grokInjection = await gateway.ensureGrokInjection();
  if (grokInjection?.status === 'drift') {
    console.warn(
      `[daemon] grok config.toml 관리 항목 드리프트 감지 — 자동 복구 안 함 (${grokInjection.configPath})`,
    );
  }
  // 하네스 HOME 격리 준비 (WBS 7.2.0a, NFR-1) — 사용자 홈의 외부 MCP 설정 유입을 끊는다.
  // 준비 실패는 기동을 막는다(격리 없이 spawn 하면 NFR-1 우회 통로가 열린 채로 동작한다).
  for (const harness of ['pi', 'omp', 'grok'] as const) {
    const isolated = await gateway.ensureHarnessHome(harness);
    if (isolated === undefined) {
      console.warn(
        `[daemon] ${harness}: HOME 격리 꺼짐 (harness.homeIsolation=false) — 사용자 홈의 외부 MCP 설정이 유입될 수 있음 (NFR-1)`,
      );
      continue;
    }
    for (const warning of isolated.warnings)
      console.warn(`[daemon] ${harness} 홈 격리: ${warning}`);
  }

  // 역방향 툴 MCP 등록 (WBS 7.2.3, FR-9.2) — 홈 격리 뒤에 온다(등록 대상이 격리 홈이다).
  // 실패는 기동을 막지 않는다: 격리와 달리 이건 보안 경계가 아니라 기능이고, 못 붙으면
  // 역방향 툴이 안 보일 뿐 하네스는 정상 동작한다.
  const registeredHarnesses = new Set(adapters.map((adapter) => adapter.id));
  const mcpSpec = resolveMcpServerSpec({ root: paths.root });
  if (registeredHarnesses.has('omp')) {
    try {
      const result = await registerOmpMcpServer(paths.ompHomeDir, mcpSpec);
      if (result.status !== 'unchanged') {
        console.warn(`[daemon] omp 역방향 MCP 등록 ${result.status}: ${result.configPath}`);
      }
    } catch (error) {
      console.warn('[daemon] omp 역방향 MCP 등록 실패 — 역방향 툴 미노출:', error);
    }
  }
  // pi 는 MCP 를 배제하므로 같은 카탈로그를 확장으로 노출한다 (7.2.3b).
  // 확장이 MCP 서버를 자식으로 띄우므로 카탈로그·승인 게이트·바인딩이 그대로 재사용된다.
  if (registeredHarnesses.has('pi')) {
    try {
      const installed = await registerPiExtension(paths.piHomeDir);
      piReverseToolsEnv = piExtensionEnv(mcpSpec);
      console.warn(`[daemon] pi 역방향 툴 확장 설치: ${installed.path}`);
    } catch (error) {
      console.warn('[daemon] pi 역방향 툴 확장 설치 실패 — 역방향 툴 미노출:', error);
    }
  }
  if (registeredHarnesses.has('grok') && options.harnessExecPaths?.grok !== undefined) {
    try {
      await registerGrokMcpServer({
        execPath: options.harnessExecPaths.grok,
        grokHome: paths.grokHomeDir,
        spec: mcpSpec,
        env: await gateway.buildEnv('grok'),
      });
      console.warn('[daemon] grok 역방향 MCP 등록 완료 (grok mcp add 위임)');
    } catch (error) {
      console.warn('[daemon] grok 역방향 MCP 등록 실패 — 역방향 툴 미노출:', error);
    }
  }

  // 트래픽 경계 검사 (FR-2.5, WBS 2.3.5) — 수동 변경으로 통제가 깨진 경우의 탐지 장치
  for (const violation of await gateway.checkTrafficBoundaries()) {
    console.warn(
      `[daemon] 트래픽 경계 위반: ${violation.harness} → ${violation.url} (${violation.location})`,
    );
  }

  const server = new DaemonServer({
    manager,
    token,
    serverVersion: options.version ?? '0.0.0',
    gateway,
    keyStore,
    provisioning,
    terminals,
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

  // 핫 리로드 — 설정 파일 외부 편집(사용자가 직접 연 에디터)도 즉시 반영한다.
  // 옵션으로 상한이 고정된 기동에서는 파일이 이겨서는 안 되므로 감시하지 않는다.
  if (options.maxSessions === undefined) {
    settings.onChange((changes) => {
      for (const change of changes) {
        if (change.requiresRestart) {
          console.warn(`[daemon] 설정 ${change.key} 변경은 재기동 후 반영된다`);
          continue;
        }
        if (change.key === 'maxSessions' && typeof change.next === 'number') {
          manager.setMaxSessions(change.next);
          console.warn(`[daemon] maxSessions 재적용: ${change.next}`);
        }
      }
    });
    settings.watchFile();
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // 셧다운 순서: 서버 → 세션 정리 → 프로세스 정리 → 원장·토큰·pid 정리 (daemon-design §3)
    await server.stop();
    terminals.shutdown();
    await manager.shutdown();
    await supervisor.terminateAll();
    settings.close();
    await removeTokenFile(paths.tokenFile);
    await rm(paths.pidFile, { force: true });
  };

  return {
    port,
    token,
    paths,
    manager,
    supervisor,
    gateway,
    keyStore,
    provisioning,
    terminals,
    stop,
  };
}

/**
 * 워크스페이스 백필 (WBS 5.4.2) — `workspaceId` 없는 기존 세션을 프로젝트·기본 워크스페이스에 귀속시킨다.
 * 마커 파일이 있으면 건너뛴다. 사라진 디렉토리의 세션은 건너뛰고 기록만 남긴다.
 */
async function runWorkspaceBackfill(
  paths: DaemonPaths,
  manager: SessionManager,
  provisioning: WorkspaceProvisioning,
): Promise<void> {
  const marker = join(paths.migrationsDir, 'backfill-workspace-id.done');
  try {
    await access(marker);
    return; // 이미 수행됨
  } catch {
    // 마커 없음 — 진행
  }
  const outcome = await manager.backfillWorkspaceIds(async (cwd) => {
    try {
      await stat(cwd);
    } catch {
      return undefined; // 디렉토리가 사라진 세션은 귀속시키지 않는다
    }
    return (await provisioning.openProject(cwd)).workspace.id;
  });
  if (outcome.mapped > 0 || outcome.skipped > 0) {
    console.warn(
      `[daemon] 워크스페이스 백필: 귀속 ${outcome.mapped}건, 건너뜀 ${outcome.skipped}건`,
    );
  }
  await mkdir(paths.migrationsDir, { recursive: true });
  await writeFile(marker, `${new Date().toISOString()}\n`);
}
