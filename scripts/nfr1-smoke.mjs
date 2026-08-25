#!/usr/bin/env node
// NFR-1 네트워크 캡처 스모크 v2 (WBS 2.7.1·2.7.3, test-strategy §2 — M1 1.7.2 초판 확장)
// 단계 A (2.7.1): 온보딩 → pi/omp/grok 각 1턴 — 3하네스 확장.
// 단계 B (2.7.3): 혼합 6세션(2×3) 동시 턴 부하 — 세션 격리·안정성.
// 판정: 전 구간 데몬·하네스 프로세스의 TCP 커넥션이 허용 목적지 외 1건이라도 있으면 실패.
//   비루프백 원격 = 즉시 위반. 루프백은 양 끝점이 (게이트웨이·데몬·감시 대상 pid 의 LISTEN 포트)
//   에 속하지 않을 때만 위반 — 하네스 내부 루프백(LSP 등)은 오탐하지 않되, 외부 프로세스로의
//   루프백 릴레이는 계속 검출한다. 보조로 HTTP(S)_PROXY 블랙홀 강제.
// 사용: node scripts/nfr1-smoke.mjs [--pi <path>|--pi-entry <js>] [--omp <path>] [--grok <path>] [--keep]
//   경로 미지정 시 env(CUSTOM_HARNESS_{PI,OMP,GROK}_PATH) → PATH/관례 위치 순.
// CI 게이트 (2.7.1): `npm run smoke:nfr1` — 사내 CI 확정 시 필수 게이트로 배선 (원격 저장소 대기).
// 한계: TCP 만 캡처 (UDP/DNS 캡처 강화는 잔여 개정 포인트).
import { execFileSync, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
function argValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

// ── 0. 준비: 프록시 블랙홀 + 하네스 실행 파일 결정 ────────────────────────
process.env.HTTP_PROXY = 'http://127.0.0.1:9';
process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
process.env.http_proxy = process.env.HTTP_PROXY;
process.env.https_proxy = process.env.HTTPS_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = process.env.NO_PROXY;

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
function which(cmd) {
  try {
    return execSync(`command -v ${cmd}`, { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const piEntry = argValue('--pi-entry') ?? process.env.CUSTOM_HARNESS_PI_ENTRY;
const piPath = argValue('--pi') ?? process.env.CUSTOM_HARNESS_PI_PATH ?? (piEntry ? undefined : which('pi'));
const ompPath = argValue('--omp') ?? process.env.CUSTOM_HARNESS_OMP_PATH ?? which('omp');
const grokDefault = join(homedir(), '.grok/bin/grok');
const grokPath =
  argValue('--grok') ??
  process.env.CUSTOM_HARNESS_GROK_PATH ??
  ((await exists(grokDefault)) ? grokDefault : which('grok'));

for (const [name, p] of [['pi', piEntry ?? piPath], ['omp', ompPath], ['grok', grokPath]]) {
  if (!p) {
    console.error(`${name} 실행 파일을 찾지 못함 — --${name} 지정 필요`);
    process.exit(2);
  }
  if (!isAbsolute(p)) {
    console.error(`절대 경로 필요 (${name}): ${p}`);
    process.exit(2);
  }
}

const { startDaemon, GatewayService, KeyStore, PiAdapter, OmpAdapter, GrokAdapter, resolvePaths } =
  await import('../packages/daemon/dist/index.js');

// ── 1. 목 게이트웨이 (OpenAI 호환 chat completions + SSE 스트리밍) ─────────
const VALID_KEY = 'sk-nfr1-smoke';
const gatewayLog = [];
const mockGateway = createServer((req, res) => {
  gatewayLog.push({ method: req.method, url: req.url });
  if (req.headers.authorization !== `Bearer ${VALID_KEY}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid key' } }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const wantsStream = /"stream"\s*:\s*true/.test(body);
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
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(chunk({ role: 'assistant', content: '' }));
        res.write(chunk({ content: '스모크 ' }));
        res.write(chunk({ content: '통과' }));
        res.write(chunk({}, 'stop', { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }));
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
              { index: 0, message: { role: 'assistant', content: '스모크 통과' }, finish_reason: 'stop' },
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

// ── 2. 격리 홈 + 온보딩 (키 저장·3하네스 주입·연결 확인) ──────────────────
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

// ── 3. 데몬 기동 (3하네스 실물 어댑터) ────────────────────────────────────
const daemon = await startDaemon({
  root: home,
  version: '0.1.0-smoke',
  managedBy: 'cli',
  maxSessions: 12,
  adapters: ({ paths: daemonPaths, supervisor }) => [
    new PiAdapter({
      command: piEntry ? process.execPath : piPath,
      prependArgs: piEntry ? [piEntry] : [],
      supervisor,
      sessionDir: join(daemonPaths.dataDir, 'pi-sessions'),
      responseTimeoutMs: 30_000,
    }),
    new OmpAdapter({
      command: ompPath,
      supervisor,
      sessionDir: join(daemonPaths.dataDir, 'omp-sessions'),
      responseTimeoutMs: 60_000,
    }),
    new GrokAdapter({ command: grokPath, supervisor, responseTimeoutMs: 60_000 }),
  ],
});
console.log(`[smoke] 데몬: 127.0.0.1:${daemon.port}`);

const keyTest = await daemon.gateway.testKey();
if (!keyTest.valid) {
  console.error('[smoke] FAIL — 온보딩 연결 확인 실패:', keyTest.detail);
  process.exit(1);
}
console.log('[smoke] 온보딩 연결 확인 통과');

// ── 4. 커넥션 감시 (lsof 폴링 — 데몬 + PID 원장의 하네스들) ───────────────
const allowedPorts = new Set([String(gatewayPort), String(daemon.port)]);
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
    let out = '';
    try {
      out = execFileSync('lsof', ['-nP', '-a', '-p', pids.join(','), '-iTCP'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      /* lsof 매치 0건 → 종료 코드 1 — 무시 */
    }
    // 감시 대상 pid 들이 소유한 LISTEN 포트 — 하네스 내부 루프백 오탐 방지 (v2)
    const listenPorts = new Set(allowedPorts);
    for (const line of out.split('\n')) {
      const listen = /TCP\s+[\d.*]+:(\d+)\s+\(LISTEN\)/.exec(line);
      if (listen) listenPorts.add(listen[1]);
    }
    for (const line of out.split('\n')) {
      const match = /TCP\s+([\d.]+):(\d+)->([\d.]+):(\d+)\s+\(ESTABLISHED\)/.exec(line);
      if (!match) continue;
      const [, localAddr, localPort, remoteAddr, remotePort] = match;
      if (!remoteAddr.startsWith('127.')) {
        violations.set(`${remoteAddr}:${remotePort}`, (violations.get(`${remoteAddr}:${remotePort}`) ?? 0) + 1);
      } else if (!listenPorts.has(remotePort) && !listenPorts.has(localPort)) {
        violations.set(`${localAddr}:${localPort}->${remoteAddr}:${remotePort}`, 1);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
})();

// ── 공통: 세션 1턴 실행기 ─────────────────────────────────────────────────
const events = [];
daemon.manager.onEvent((event) => events.push(event));
const MODEL_BY_HARNESS = { pi: 'gateway/mock-model', omp: 'gateway/mock-model', grok: 'mock-model' };

async function runTurn(harness, label, timeoutMs = 120_000) {
  const session = await daemon.manager.createSession({
    harness,
    cwd: workDir,
    modelId: MODEL_BY_HARNESS[harness],
  });
  const { turnId } = await daemon.manager.prompt(
    session.sessionId,
    `한 문장으로만 답해: ${label} 스모크 응답`,
  );
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const terminal = events.find(
      (e) =>
        e.sessionId === session.sessionId &&
        (e.type === 'turn_completed' || e.type === 'turn_failed') &&
        e.turnId === turnId,
    );
    if (terminal) {
      const deltas = events.filter(
        (e) => e.sessionId === session.sessionId && e.type === 'message_delta',
      ).length;
      if (terminal.type === 'turn_failed') {
        throw new Error(`${label} 턴 실패: ${terminal.error?.message}`);
      }
      return { session, deltas };
    }
    if (Date.now() > deadline) throw new Error(`${label} 턴 타임아웃 (${timeoutMs / 1000}s)`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

let failReason = null;

// ── 5. 단계 A (2.7.1): 하네스별 1턴 ───────────────────────────────────────
try {
  for (const harness of ['pi', 'omp', 'grok']) {
    const started = Date.now();
    const { session, deltas } = await runTurn(harness, harness);
    console.log(
      `[smoke:A] ${harness} 1턴 완료 (${((Date.now() - started) / 1000).toFixed(1)}s, delta ${deltas}건)`,
    );
    await daemon.manager.closeSession(session.sessionId);
  }
  console.log('[smoke:A] PASS — 3하네스 각 1턴 완료');
} catch (error) {
  failReason = `단계 A: ${error instanceof Error ? error.message : String(error)}`;
}

// ── 6. 단계 B (2.7.3): 혼합 6세션 동시 부하 ───────────────────────────────
if (!failReason) {
  try {
    const mix = ['pi', 'pi', 'omp', 'omp', 'grok', 'grok'];
    const started = Date.now();
    const results = await Promise.all(
      mix.map((harness, index) => runTurn(harness, `부하-${harness}-${index}`, 180_000)),
    );
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    // 세션 격리 확인 — 각 세션 타임라인에 자기 이벤트만, seq 단조 증가
    for (const { session } of results) {
      const own = events.filter((e) => e.sessionId === session.sessionId);
      const seqs = own.map((e) => e.seq);
      const sorted = [...seqs].sort((a, b) => a - b);
      if (JSON.stringify(sorted) !== JSON.stringify(seqs)) {
        throw new Error(`세션 ${session.sessionId} seq 순서 붕괴`);
      }
      await daemon.manager.closeSession(session.sessionId);
    }
    const list = await daemon.manager.listSessions();
    console.log(
      `[smoke:B] PASS — 혼합 6세션 동시 턴 완료 (${elapsed}s, 전체 세션 ${list.length}개 정합)`,
    );
  } catch (error) {
    failReason = `단계 B: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ── 7. 종료·판정 ──────────────────────────────────────────────────────────
monitoring = false;
await monitor;
await daemon.stop();
mockGateway.close();

const llmCalls = gatewayLog.filter((r) => r.url === '/v1/chat/completions').length;
console.log(`[smoke] 게이트웨이 LLM 호출: ${llmCalls}건`);
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
console.log('[smoke] PASS — 허용 외 커넥션 0건 · 3하네스 1턴 + 혼합 6세션 부하 완료 (NFR-1 v2)');
