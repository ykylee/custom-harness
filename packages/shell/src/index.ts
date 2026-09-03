// Electron 셸 (WBS 1.6.1·2.4.6, FR-1.1.5·FR-3.5) — 렌더러 코드 없음, 데몬·창 수명주기만.
// 창을 닫으면 앱도 종료한다. 셸이 기동한 detached 데몬도 함께 정리하며, CLI 소유 데몬은 건드리지 않는다.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { BrowserWindow, Menu, app, safeStorage } from 'electron';
import { launchDetachedDaemon, resolvePaths, stopDaemon } from '@custom-harness/daemon';

const require = createRequire(import.meta.url);

let daemonInfo: { port: number; token: string; managedBy: 'app' | 'cli' | string } | undefined;
let mainWindow: BrowserWindow | undefined;
let quitting = false;

function rendererIndexPath(): string {
  const rendererPackage = require.resolve('@custom-harness/renderer/package.json');
  return join(dirname(rendererPackage), 'dist-web', 'index.html');
}

async function ensureDaemon(): Promise<{ port: number; token: string }> {
  if (daemonInfo) return daemonInfo;
  const paths = resolvePaths();
  const { info, token } = await launchDetachedDaemon({
    paths,
    entryPath:
      process.env.CUSTOM_HARNESS_DAEMON_ENTRY ?? require.resolve('@custom-harness/daemon/main'),
    managedBy: 'app',
  });
  if (info.port === null) throw new Error('데몬 포트 미확인 — daemon.pid 에 port 없음');
  daemonInfo = { port: info.port, token, managedBy: info.managedBy };
  return daemonInfo;
}

async function showWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  const { port, token } = await ensureDaemon();
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    webPreferences: {
      // 렌더러는 WS 클라이언트일 뿐 — Node 통합 불요, 격리 유지 (NFR-3 표면 최소화)
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  // 창 닫기는 곧 앱 종료다. 숨김·트레이 상주로 바꾸지 않는다.
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    void shutdown();
  });
  const search = `?port=${port}&token=${encodeURIComponent(token)}`;
  if (process.env.CUSTOM_HARNESS_DEV === '1') {
    await window.loadURL(`http://localhost:5180/${search}`); // vite dev 서버
  } else {
    await window.loadFile(rendererIndexPath(), { search });
  }
}

async function shutdown(): Promise<void> {
  if (quitting) return;
  quitting = true;
  if (daemonInfo?.managedBy === 'app') {
    const result = await stopDaemon(resolvePaths());
    if (!result.stopped) console.warn('[shell] 앱 소유 데몬을 정상 종료하지 못했습니다.');
  }
  app.quit();
}

app.whenReady().then(async () => {
  // Windows/Linux 는 창 안에 기본 메뉴바(File/Edit…)가 그려진다 — 제품 UI 가 아니므로 제거.
  // macOS 는 시스템 메뉴바 소속이라 유지 (Cmd+C/V 등 표준 편집 단축키가 메뉴에 의존)
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  // safeStorage 실측 (credential-injection-design §1): 셸에선 가용, 데몬(RUN_AS_NODE)은 불가 —
  // M1 키 저장은 0600 폴백, safeStorage 위임(IPC)은 M2 개정 포인트.
  console.log('[shell] safeStorage available:', safeStorage.isEncryptionAvailable());
  await showWindow();

  app.on('activate', () => {
    void showWindow();
  });
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  void shutdown();
});
