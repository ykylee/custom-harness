// 데몬 실행 진입점 (WBS 1.6.2, FR-4.1.3) — 셸/CLI 가 detached 로 spawn 한다.
// 환경변수 계약:
//   CUSTOM_HARNESS_HOME        데이터 루트 (기본 ~/.custom-harness)
//   CUSTOM_HARNESS_MANAGED_BY  app | cli (FR-5.2)
//   CUSTOM_HARNESS_PORT        고정 포트 (기본 임의 포트)
//   CUSTOM_HARNESS_PI_PATH     pi 실행 파일 절대 경로 (dev — 시스템 설치본)
//   CUSTOM_HARNESS_PI_ENTRY    pi JS 진입점 절대 경로 (번들 — process.execPath+RUN_AS_NODE 로 실행)
//   둘 다 없으면 mock 만 등록
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { MockAdapter } from './adapters/mock.js';
import { PiAdapter } from './adapters/jsonl-rpc/pi.js';
import { startDaemon } from './index.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version: string };

async function main(): Promise<void> {
  const piPath = process.env.CUSTOM_HARNESS_PI_PATH;
  const piEntry = process.env.CUSTOM_HARNESS_PI_ENTRY;
  for (const [name, value] of [
    ['CUSTOM_HARNESS_PI_PATH', piPath],
    ['CUSTOM_HARNESS_PI_ENTRY', piEntry],
  ] as const) {
    if (value !== undefined && !isAbsolute(value)) {
      throw new Error(`${name} 는 절대 경로여야 함: ${value}`); // FR-1.1.1
    }
  }
  const portEnv = process.env.CUSTOM_HARNESS_PORT;

  const daemon = await startDaemon({
    ...(process.env.CUSTOM_HARNESS_HOME !== undefined
      ? { root: process.env.CUSTOM_HARNESS_HOME }
      : {}),
    ...(portEnv !== undefined ? { port: Number(portEnv) } : {}),
    version: packageJson.version,
    managedBy: process.env.CUSTOM_HARNESS_MANAGED_BY ?? 'cli',
    adapters: ({ paths, supervisor }) => {
      const piSpawn =
        piEntry !== undefined
          ? // 번들: Electron 내장 Node 겸용 (FR-4.1.3) — 데몬의 ELECTRON_RUN_AS_NODE 가 상속됨
            { command: process.execPath, prependArgs: [piEntry] }
          : piPath !== undefined
            ? { command: piPath, prependArgs: [] }
            : undefined;
      return [
        new MockAdapter(),
        ...(piSpawn !== undefined
          ? [
              new PiAdapter({
                ...piSpawn,
                supervisor,
                sessionDir: join(paths.dataDir, 'pi-sessions'),
              }),
            ]
          : []),
      ];
    },
  });
  console.log(`[daemon] listening on 127.0.0.1:${daemon.port} (pid=${process.pid})`);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[daemon] ${signal} — 종료 절차 시작`);
    void daemon.stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error('[daemon] 기동 실패:', error);
  process.exit(1);
});
