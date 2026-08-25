#!/usr/bin/env node
// NFR-1 네트워크 캡처 스모크 초판 (WBS 1.7.2, test-strategy §2)
// 시나리오: 온보딩(목 게이트웨이 키) → pi 세션 1턴 → 종료.
// 판정: 실행 중 프로세스(데몬·pi)의 TCP 커넥션이 허용 목적지(127.0.0.1 목 게이트웨이·데몬 포트)
// 외에 1건이라도 있으면 실패. 보조로 HTTP(S)_PROXY 블랙홀 강제 (프록시 우회 자체가 검출 대상).
// 사용: node scripts/nfr1-smoke.mjs [--pi <절대경로>] [--pi-entry <JS 진입점>] [--keep]
// 한계(초판): TCP 만 캡처 (UDP/DNS 는 M2 강화 — 개정 포인트 기록됨).
import { execFileSync, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
function argValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

// ── 0. 준비: 프록시 블랙홀 + 대상 pi 결정 ─────────────────────────────────
process.env.HTTP_PROXY = 'http://127.0.0.1:9';
process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
process.env.http_proxy = process.env.HTTP_PROXY;
process.env.https_proxy = process.env.HTTPS_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = process.env.NO_PROXY;

const piEntry = argValue('--pi-entry') ?? process.env.CUSTOM_HARNESS_PI_ENTRY;
let piPath = argValue('--pi') ?? process.env.CUSTOM_HARNESS_PI_PATH;
if (!piEntry && !piPath) {
  try {
    piPath = execSync('command -v pi', { encoding: 'utf8' }).trim();
  } catch {
    console.error('pi 실행 파일을 찾지 못함 — --pi 또는 --pi-entry 지정 필요');
    process.exit(2);
  }
}
for (const p of [piEntry, piPath]) {
  if (p && !isAbsolute(p)) {
    console.error(`절대 경로 필요: ${p}`);
    process.exit(2);
  }
}

const { startDaemon, GatewayService, KeyStore, PiAdapter, resolvePaths } = await import(
  '../packages/daemon/dist/index.js'
);

// ── 1. 목 게이트웨이 (OpenAI 호환 chat completions + SSE 스트리밍) ─────────
const VALID_KEY = 'sk-nfr1-smoke';
const gatewayLog = [];
const mockGateway = createServer((req, res) => {
  gatewayLog.push({ method: req.method, url: req.url, auth: req.headers.authorization });
  if (req.headers.authorization !== `Bearer ${VALID_KEY}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid key' } }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const wantsStream = body.includes('"stream":true') || body.includes('"stream": true');
      const chunk = (delta, finish = null, usage) =>
        `data: ${JSON.stringify({
          id: 'chatcmpl-smoke',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'mock-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(usage ? { usage } : {}),
        })}\n\n`;
      if (wantsStream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        res.write(chunk({ role: 'assistant', content: '' }));
        res.write(chunk({ content: '스모크 ' }));
        res.write(chunk({ content: '통과' }));
        res.write(
          chunk({}, 'stop', { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }),
        );
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-smoke',
            object: 'chat.completion',
            created: 0,
            model: 'mock-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '스모크 통과' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
          }),
        );
      }
    });
    return;
  }
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => mockGateway.listen(0, '127.0.0.1', resolve));
const gatewayPort = mockGateway.address().port;
console.log(`[smoke] 목 게이트웨이: 127.0.0.1:${gatewayPort}`);

// ── 2. 격리 홈 + 온보딩 (키 저장·주입·연결 확인) ──────────────────────────
const home = await mkdtemp(join(tmpdir(), 'ch-nfr1-'));
const workDir = await mkdtemp(join(tmpdir(), 'ch-nfr1-work-'));
await writeFile(join(workDir, 'hello.txt'), 'smoke fixture\n');
const paths = resolvePaths(home);
const keyStore = new KeyStore(paths.credentialsFile);
const gatewayService = new GatewayService(paths, keyStore);
await gatewayService.setConfig({
  baseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
  models: [{ id: 'mock-model' }],
  defaultModel: 'mock-model',
});
await keyStore.set(VALID_KEY);

// ── 3. 데몬 기동 (pi 어댑터 실물) ─────────────────────────────────────────
const daemon = await startDaemon({
  root: home,
  version: '0.1.0-smoke',
  managedBy: 'cli',
  adapters: ({ paths: daemonPaths, supervisor }) => [
    new PiAdapter({
      command: piEntry ? process.execPath : piPath,
      prependArgs: piEntry ? [piEntry] : [],
      supervisor,
      sessionDir: join(daemonPaths.dataDir, 'pi-sessions'),
      responseTimeoutMs: 30_000,
    }),
  ],
});
console.log(`[smoke] 데몬: 127.0.0.1:${daemon.port}`);

const keyTest = await daemon.gateway.testKey();
if (!keyTest.valid) {
  console.error('[smoke] FAIL — 온보딩 연결 확인 실패:', keyTest.detail);
  process.exit(1);
}
console.log('[smoke] 온보딩 연결 확인 통과');

// ── 4. 커넥션 감시 (lsof 폴링 — 데몬 프로세스 + PID 원장의 하네스들) ──────
const allowedRemotes = new Set([`127.0.0.1:${gatewayPort}`, `127.0.0.1:${daemon.port}`]);
const violations = new Map();
let monitoring = true;
async function monitoredPids() {
  const pids = [process.pid];
  try {
    const ledger = JSON.parse(await readFile(paths.processesFile, 'utf8'));
    for (const entry of ledger) pids.push(entry.pid);
  } catch {
    /* 원장 없음 — 데몬만 감시 */
  }
  return pids;
}
const monitor = (async () => {
  while (monitoring) {
    const pids = await monitoredPids();
    try {
      const out = execFileSync(
        'lsof',
        ['-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:ESTABLISHED'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      for (const line of out.split('\n')) {
        const match = /TCP\s+([\d.]+):(\d+)->([\d.]+):(\d+)/.exec(line);
        if (!match) continue;
        const [, localAddr, localPort, remoteAddr, remotePort] = match;
        const remote = `${remoteAddr}:${remotePort}`;
        // 비루프백 원격 = 즉시 위반. 루프백은 양 끝점 어느 쪽도 허용 서비스 포트가
        // 아닐 때만 위반 (서버 소켓의 accept 연결은 원격이 클라이언트 임시 포트라서)
        if (!remoteAddr.startsWith('127.')) {
          violations.set(remote, (violations.get(remote) ?? 0) + 1);
        } else if (
          !allowedRemotes.has(remote) &&
          !allowedRemotes.has(`${localAddr}:${localPort}`)
        ) {
          violations.set(`${localAddr}:${localPort}->${remote}`, 1);
        }
      }
    } catch {
      /* lsof 는 매치 0건이면 종료 코드 1 — 무시 */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
})();

// ── 5. pi 세션 1턴 ────────────────────────────────────────────────────────
const events = [];
daemon.manager.onEvent((event) => {
  events.push(event);
  if (event.type === 'message_delta') process.stdout.write(event.delta);
  if (event.type === 'turn_completed' || event.type === 'turn_failed') process.stdout.write('\n');
});

let failReason = null;
try {
  const session = await daemon.manager.createSession({
    harness: 'pi',
    cwd: workDir,
    modelId: 'gateway/mock-model',
  });
  console.log(`[smoke] pi 세션 생성: ${session.sessionId} (status=${session.status})`);
  await daemon.manager.prompt(session.sessionId, '한 문장으로만 답해: 스모크 테스트 응답');

  const deadline = Date.now() + 90_000;
  for (;;) {
    const terminal = events.find((e) => e.type === 'turn_completed' || e.type === 'turn_failed');
    if (terminal) {
      if (terminal.type === 'turn_failed') {
        failReason = `턴 실패: ${terminal.error?.message}`;
      }
      break;
    }
    if (Date.now() > deadline) {
      failReason = '턴 타임아웃 (90s)';
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await daemon.manager.closeSession(session.sessionId);
} catch (error) {
  failReason = `시나리오 오류: ${error instanceof Error ? error.message : String(error)}`;
}

// ── 6. 종료·판정 ──────────────────────────────────────────────────────────
monitoring = false;
await monitor;
await daemon.stop();
mockGateway.close();

const llmCalls = gatewayLog.filter((r) => r.url === '/v1/chat/completions').length;
const deltas = events.filter((e) => e.type === 'message_delta').length;
console.log(`[smoke] 게이트웨이 LLM 호출: ${llmCalls}건 · message_delta: ${deltas}건`);

if (!failReason && llmCalls === 0) failReason = '게이트웨이 LLM 호출이 관측되지 않음';
if (violations.size > 0) {
  failReason = `허용 외 커넥션 검출: ${[...violations.keys()].join(', ')}`;
}

if (!args.includes('--keep')) {
  await rm(home, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
}

if (failReason) {
  console.error(`[smoke] FAIL — ${failReason}`);
  process.exit(1);
}
console.log('[smoke] PASS — 허용 외 커넥션 0건, pi 1턴 완료 (NFR-1 초판 기준)');
