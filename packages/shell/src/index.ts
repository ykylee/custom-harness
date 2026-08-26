// Electron 셸 (WBS 1.6.1·2.4.6, FR-1.1.5·FR-3.5) — 렌더러 코드 없음, 데몬·창·트레이 수명주기만.
// 데몬은 detached spawn — 창을 닫아도 세션 유지. 창 닫기 = 숨김(트레이 상주, FR-3.5.1),
// 앱 종료는 트레이 메뉴의 명시적 조작. 네이티브 알림은 렌더러의 Notification API 가 담당(FR-3.5.2).
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { BrowserWindow, Menu, Tray, app, nativeImage, safeStorage } from 'electron';
import { WebSocket } from 'ws';
import { launchDetachedDaemon, resolvePaths } from '@custom-harness/daemon';

const require = createRequire(import.meta.url);

/** 16x16 흑백 링 도트 — 폐쇄망 자산 없이 코드 내장 (macOS 템플릿 이미지) */
const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAANElEQVR4nGNgoC74D4V4JXEoQhfCUIJp7H9Uzn88LCQOsv3kKcBpBUFHEuFNggGFqoiqAACj/z/BBrKR5AAAAABJRU5ErkJggg==';

let daemonInfo: { port: number; token: string } | undefined;
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
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
  daemonInfo = { port: info.port, token };
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
  // 창 닫기 = 숨김 — 트레이 상주 (FR-3.5.1). 종료는 트레이 메뉴에서만
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  const search = `?port=${port}&token=${encodeURIComponent(token)}`;
  if (process.env.CUSTOM_HARNESS_DEV === '1') {
    await window.loadURL(`http://localhost:5180/${search}`); // vite dev 서버
  } else {
    await window.loadFile(rendererIndexPath(), { search });
  }
}

/** 트레이 메뉴용 세션 요약 — 데몬 WS 1회 질의 (hello → session.list) */
async function querySessions(): Promise<{ harness: string; cwd: string; status: string }[]> {
  if (!daemonInfo) return [];
  const { port, token } = daemonInfo;
  return new Promise((resolve) => {
    const sessions: { harness: string; cwd: string; status: string }[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, [token]);
    const finish = (): void => {
      try {
        ws.close();
      } catch {
        /* 무시 */
      }
      resolve(sessions);
    };
    const timer = setTimeout(finish, 1500);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1 })));
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as {
        type: string;
        result?: { sessions?: { harness: string; cwd: string; status: string }[] };
      };
      if (message.type === 'hello.response') {
        ws.send(JSON.stringify({ type: 'session.list.request', requestId: 'tray', params: {} }));
      } else if (message.type === 'session.list.response') {
        sessions.push(...(message.result?.sessions ?? []));
        clearTimeout(timer);
        finish();
      }
    });
    ws.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

async function rebuildTrayMenu(): Promise<void> {
  if (!tray) return;
  const sessions = await querySessions();
  const running = sessions.filter((s) => s.status === 'running');
  const summaryItems =
    running.length > 0
      ? running.slice(0, 5).map((s) => ({
          label: `● ${s.harness} · ${s.cwd.split('/').pop() ?? s.cwd}`,
          click: () => void showWindow(),
        }))
      : [{ label: '실행 중 세션 없음', enabled: false }];
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '열기', click: () => void showWindow() },
      { type: 'separator' },
      { label: `실행 중 ${running.length} / 전체 ${sessions.length}`, enabled: false },
      ...summaryItems,
      { type: 'separator' },
      {
        label: '종료',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray(): void {
  const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_BASE64, 'base64'));
  icon.setTemplateImage(true); // macOS 메뉴바 다크/라이트 자동 반전
  tray = new Tray(icon);
  tray.setToolTip('Custom Harness');
  // 메뉴를 열 때마다 세션 요약 갱신 (FR-3.5.1)
  tray.on('click', () => void rebuildTrayMenu().then(() => tray?.popUpContextMenu()));
  tray.on('right-click', () => void rebuildTrayMenu().then(() => tray?.popUpContextMenu()));
  void rebuildTrayMenu();
}

app.whenReady().then(async () => {
  // Windows/Linux 는 창 안에 기본 메뉴바(File/Edit…)가 그려진다 — 제품 UI 가 아니므로 제거.
  // macOS 는 시스템 메뉴바 소속이라 유지 (Cmd+C/V 등 표준 편집 단축키가 메뉴에 의존)
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  // safeStorage 실측 (credential-injection-design §1): 셸에선 가용, 데몬(RUN_AS_NODE)은 불가 —
  // M1 키 저장은 0600 폴백, safeStorage 위임(IPC)은 M2 개정 포인트.
  console.log('[shell] safeStorage available:', safeStorage.isEncryptionAvailable());
  createTray();
  await showWindow();

  app.on('activate', () => {
    void showWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
});

// 창 전부 닫혀도(숨김) 앱은 트레이에 상주 — 데몬은 detached 라 세션 유지 (FR-1.1.5/FR-3.5.1)
app.on('window-all-closed', () => {
  /* 종료하지 않는다 — 트레이 메뉴의 '종료'가 유일한 앱 종료 경로 */
});
