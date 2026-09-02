// 렌더러 진입점 — 셸(1.6)이 ?port=&token= 쿼리로 로드한다. 개발·비상용 브라우저 접속도 동일 경로.
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { AppController } from './store/app-store.js';
import { DaemonClient } from './ws/client.js';
import { DesignPreview } from './views/DesignPreview.js';
import './styles.css';

const params = new URLSearchParams(location.search);
if (params.get('preview') === 'work-queue') {
  createRoot(document.getElementById('root')!).render(<DesignPreview />);
} else {
  const port = params.get('port') ?? '9700';
  const token = params.get('token') ?? '';

  const client = new DaemonClient({
    url: `ws://127.0.0.1:${port}`,
    token,
    clientInfo: { name: 'custom-harness-renderer', version: '0.1.0' },
  });
  const controller = new AppController(client);
  controller.start();

  createRoot(document.getElementById('root')!).render(<App controller={controller} />);
}
