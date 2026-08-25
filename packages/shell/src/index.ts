// Electron 셸 (WBS 1.6.1, FR-1.1.5·ui-form §4) — 렌더러 코드 없음, 데몬·창 수명주기만.
// 데몬은 detached spawn — 창을 닫아도 세션 유지 (트레이 상주는 M2 FR-3.5).
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { BrowserWindow, app, safeStorage } from 'electron';
import { launchDetachedDaemon, resolvePaths } from '@custom-harness/daemon';

const require = createRequire(import.meta.url);

function rendererIndexPath(): string {
  const rendererPackage = require.resolve('@custom-harness/renderer/package.json');
  return join(dirname(rendererPackage), 'dist-web', 'index.html');
}

async function createWindow(): Promise<void> {
  const paths = resolvePaths();
  const { info, token } = await launchDetachedDaemon({
    paths,
    entryPath:
      process.env.CUSTOM_HARNESS_DAEMON_ENTRY ?? require.resolve('@custom-harness/daemon/main'),
    managedBy: 'app',
  });

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
  const search = `?port=${info.port}&token=${encodeURIComponent(token)}`;
  if (process.env.CUSTOM_HARNESS_DEV === '1') {
    await window.loadURL(`http://localhost:5180/${search}`); // vite dev 서버
  } else {
    await window.loadFile(rendererIndexPath(), { search });
  }
}

app.whenReady().then(async () => {
  // safeStorage 실측 (credential-injection-design §1 M1 첫 구현 태스크):
  // 셸(Electron 앱 컨텍스트)에선 가용하나, 데몬은 ELECTRON_RUN_AS_NODE(순수 Node)라
  // Electron API 자체가 없다 → M1 키 저장은 0600 폴백, safeStorage 위임(IPC)은 M2 개정 포인트.
  console.log('[shell] safeStorage available:', safeStorage.isEncryptionAvailable());
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

// 창 전부 닫히면 앱 종료 — 데몬은 detached 라 세션 유지 (FR-1.1.5)
app.on('window-all-closed', () => {
  app.quit();
});
