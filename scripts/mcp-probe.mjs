#!/usr/bin/env node
// M7 7.2.1 — 하네스 MCP 지원 실측 (선행 게이트)
//
// 목적: pi / omp / grok 실물 바이너리가 MCP 서버를 실제로 띄우고, 툴을 모델에게
// 노출하고, 모델의 호출을 실행해 결과를 대화에 되돌리는지를 **왕복까지** 확인한다.
//
// 구성:
//   목 게이트웨이(OpenAI 호환) — 요청 body 의 tools[] 를 기록하고, 프로브 툴이 보이면
//     tool_calls 로 응답한다. 다음 턴에 tool 결과가 되돌아오는지까지 관측한다.
//   목 MCP stdio 서버 — scripts/mcp-probe/mock-mcp-server.mjs. 수신 메시지를 JSONL 로 남긴다.
//
// 판정(하네스별):
//   registered  : MCP 서버 프로세스가 뜨고 tools/list 를 응답했는가
//   advertised  : 그 툴이 게이트웨이 요청의 tools[] 에 실렸는가 (= 모델에게 노출)
//   invoked     : 모델의 tool_call 을 하네스가 MCP tools/call 로 실행했는가
//   returned    : 그 결과가 다음 턴 요청 메시지에 실렸는가 (= 왕복 완결)
//
// 사용: node scripts/mcp-probe.mjs [--omp <path>] [--grok <path>] [--pi-entry <js>] [--keep]
//   경로 미지정 시 번들(bundle/out/…)의 실물 → env → PATH 순.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
/**
 * `--real-server`: 목 MCP 서버 대신 **데몬이 실제로 등록하는 우리 서버**를 띄운다 (WBS 7.2.3).
 * 목 서버로는 "하네스가 MCP 를 지원하는가"까지만 재고, 이 모드에서 "우리 카탈로그가 실제로
 * 노출·호출되는가"를 잰다. 우리 서버는 데몬에 되붙으므로 데몬 경로에서만 의미가 있다.
 */
const realServer = process.argv.includes('--real-server');
const MCP_SERVER = realServer
  ? join(repoRoot, 'packages/daemon/dist/mcp/main.js')
  : join(here, 'mcp-probe', 'mock-mcp-server.mjs');
/** 등록 서버명 — 실서버는 데몬이 쓰는 이름과 같아야 재접두사 결과가 실제와 같다 */
const SERVER_NAME = realServer ? 'ch' : 'ch-probe';
const TOOL_NAME = realServer ? 'ws_list' : 'ch_probe_echo';
/** 왕복 완결 판정 마커 — 실서버 read 툴은 JSON 을 되돌린다 */
const RESULT_MARKER = realServer ? '"workspaces"' : 'CH_MCP_PROBE_OK';
const VALID_KEY = 'sk-mcp-probe';
const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const keep = args.includes('--keep');
const dumpToolsPath = argValue('--dump-tools');
const dumpMessagesPath = argValue('--dump-messages');
const grokPermissionMode = argValue('--grok-permission-mode');
/**
 * write 툴 왕복까지 잰다 (WBS 7.2.4). read 툴과 전송은 같지만 **승인 대기**가 추가되고,
 * 그 대기를 하네스가 견디는지는 read 경로로 알 수 없다 — 하네스 자신의 툴 타임아웃이
 * 우리 승인 만료보다 짧으면 여기서만 드러난다.
 */
const writeProbe = args.includes('--write-probe');

/**
 * 목 모델이 부를 툴. 단계마다 바뀐다 — read 왕복 뒤 write 왕복을 재려면 같은 세션에서
 * 다른 툴을 부르게 해야 한다. 목이 프롬프트를 읽지 않으므로(스크립트된 응답) 여기서 지정한다.
 */
let targetTool = { name: TOOL_NAME, args: realServer ? {} : { text: 'ping' } };
// 7.2.0a 대조군 — 홈 격리를 끄면 사용자 홈의 외부 MCP 설정이 그대로 유입된다 (§3.1 재현용)
if (args.includes('--no-home-isolation')) process.env.CUSTOM_HARNESS_HOME_ISOLATION = 'false';

// 외부 접속 차단 (NFR-1 과 동일 전제)
process.env.HTTP_PROXY = 'http://127.0.0.1:9';
process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
process.env.http_proxy = process.env.HTTP_PROXY;
process.env.https_proxy = process.env.HTTPS_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = process.env.NO_PROXY;

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};
const bundleRoot = join(repoRoot, 'bundle/out/custom-harness-0.1.0-darwin-arm64');
async function resolveBin(flag, envVar, bundleRel, fallback) {
  const explicit = argValue(flag) ?? process.env[envVar];
  if (explicit) return explicit;
  const bundled = join(bundleRoot, bundleRel);
  if (await exists(bundled)) return bundled;
  return (await exists(fallback)) ? fallback : undefined;
}
const ompPath = await resolveBin(
  '--omp',
  'CUSTOM_HARNESS_OMP_PATH',
  'harnesses/omp/omp',
  '/opt/homebrew/bin/omp',
);
const grokPath = await resolveBin(
  '--grok',
  'CUSTOM_HARNESS_GROK_PATH',
  'harnesses/grok/grok',
  join(homedir(), '.grok/bin/grok'),
);
const piEntry = await resolveBin(
  '--pi-entry',
  'CUSTOM_HARNESS_PI_ENTRY',
  'harnesses/pi/dist/cli.js',
  '',
);

const { GatewayService, KeyStore, resolvePaths } = await import(
  join(repoRoot, 'packages/daemon/dist/index.js')
);

// ── 목 게이트웨이 ─────────────────────────────────────────────────────────
/** 하네스별 관측 기록 */
let obs = null;
function resetObservations(harness) {
  obs = {
    harness,
    requests: 0,
    toolNamesSeen: new Set(),
    toolCallIssued: false,
    searchIssued: false,
    requestTimes: [],
    toolResultSeen: null,
    lastError: null,
  };
  return obs;
}

/** 요청 body 에서 tools[] 이름을 뽑는다 — OpenAI chat completions 형식 */
function collectToolNames(body) {
  const names = [];
  for (const t of body?.tools ?? []) {
    const n = t?.function?.name ?? t?.name;
    if (typeof n === 'string') names.push(n);
  }
  return names;
}

/** 메시지 배열에서 프로브 툴 결과가 되돌아왔는지 찾는다 */
function findToolResult(body) {
  for (const m of body?.messages ?? []) {
    const content =
      typeof m?.content === 'string'
        ? m.content
        : Array.isArray(m?.content)
          ? m.content.map((c) => c?.text ?? '').join('')
          : '';
    if (content.includes(RESULT_MARKER)) return { role: m.role, content };
  }
  return null;
}

let toolCallSeq = 0;
function toolCallMessage(callName, callArgs) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: `call_ch_probe_${toolCallSeq}`,
        type: 'function',
        function: { name: callName, arguments: JSON.stringify(callArgs) },
      },
    ],
  };
}

const mockGateway = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${VALID_KEY}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid key' } }));
    return;
  }
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* 비정형 — tools 관측만 포기 */
      }
      if (obs) {
        obs.requests += 1;
        obs.requestTimes.push(Date.now());
        if (dumpMessagesPath) {
          appendFileSync(
            dumpMessagesPath,
            `${JSON.stringify({ harness: obs.harness, req: obs.requests, messages: body?.messages ?? [] })}\n`,
          );
        }
        if (dumpToolsPath) {
          appendFileSync(
            dumpToolsPath,
            `${JSON.stringify({ harness: obs.harness, req: obs.requests, tools: body?.tools ?? [] })}\n`,
          );
        }
        for (const n of collectToolNames(body)) obs.toolNamesSeen.add(n);
        const found = findToolResult(body);
        if (found && !obs.toolResultSeen) obs.toolResultSeen = found;
      }

      const exposure = obs ? resolveExposure(obs) : null;
      // grok 은 `use_tool` 앞에 `search_tool` 선행을 요구한다(시스템 리마인더 실측) —
      // 그 계약을 지켜야 왕복이 결정적으로 재현된다.
      const needsSearchFirst =
        exposure?.kind === 'meta' &&
        obs &&
        !obs.searchIssued &&
        obs.toolNamesSeen.has('search_tool');
      const issueToolCall = Boolean(exposure) && obs && (needsSearchFirst || !obs.toolCallIssued);
      if (issueToolCall) {
        toolCallSeq += 1;
        if (needsSearchFirst) obs.searchIssued = true;
        else obs.toolCallIssued = true;
      }
      const callName = needsSearchFirst ? 'search_tool' : (exposure?.callName ?? targetTool.name);
      const toolInput = targetTool.args;
      const callArgs = needsSearchFirst
        ? { query: `${SERVER_NAME} ${targetTool.name}` }
        : exposure?.kind === 'meta'
          ? { tool_name: `${SERVER_NAME}__${targetTool.name}`, tool_input: toolInput }
          : toolInput;

      const wantsStream = body?.stream === true || /"stream"\s*:\s*true/.test(raw);
      const usage = { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 };

      if (wantsStream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const chunk = (delta, finish = null, extra) =>
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-mcp-probe',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'mock-model',
              choices: [{ index: 0, delta, finish_reason: finish }],
              ...(extra ?? {}),
            })}\n\n`,
          );
        chunk({ role: 'assistant', content: '' });
        if (issueToolCall) {
          chunk({
            tool_calls: [
              {
                index: 0,
                id: `call_ch_probe_${toolCallSeq}`,
                type: 'function',
                function: { name: callName, arguments: '' },
              },
            ],
          });
          chunk({
            tool_calls: [{ index: 0, function: { arguments: JSON.stringify(callArgs) } }],
          });
          chunk({}, 'tool_calls', { usage });
        } else {
          chunk({ content: 'MCP probe done' });
          chunk({}, 'stop', { usage });
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-mcp-probe',
          object: 'chat.completion',
          created: 0,
          model: 'mock-model',
          choices: [
            issueToolCall
              ? {
                  index: 0,
                  message: toolCallMessage(callName, callArgs),
                  finish_reason: 'tool_calls',
                }
              : {
                  index: 0,
                  message: { role: 'assistant', content: 'MCP probe done' },
                  finish_reason: 'stop',
                },
          ],
          usage,
        }),
      );
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => mockGateway.listen(0, '127.0.0.1', r));
const gatewayPort = mockGateway.address().port;
const baseUrl = `http://127.0.0.1:${gatewayPort}/v1`;
console.log(`[probe] 목 게이트웨이: ${baseUrl}`);

// ── 격리 홈 + 게이트웨이 주입 (실물 주입 모듈 사용) ───────────────────────
const home = await mkdtemp(join(tmpdir(), 'ch-mcp-probe-'));
const workDir = await mkdtemp(join(tmpdir(), 'ch-mcp-work-'));
await writeFile(join(workDir, 'hello.txt'), 'mcp probe fixture\n');
const paths = resolvePaths(home);
const keyStore = new KeyStore(paths.credentialsFile);
const gateway = new GatewayService(paths, keyStore);
await gateway.setConfig({ baseUrl, models: [{ id: 'mock-model' }], defaultModel: 'mock-model' });
await keyStore.set(VALID_KEY);
console.log(`[probe] 격리 홈: ${home}`);

const PROMPT =
  `Use the ${TOOL_NAME} tool with text="ping". ` +
  `You must call the tool. After the tool returns, reply with DONE and nothing else.`;

function run(command, argv, env, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    const child = spawn(command, argv, {
      cwd: workDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(error) });
    });
  });
}

async function readMcpLog(logPath) {
  try {
    const raw = await readFile(logPath, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/**
 * 툴 노출 방식은 하네스마다 다르다 — 이름만 찾으면 "미노출"로 오판한다.
 *  - direct   : `mcp__<server>_<tool>` 처럼 tools[] 에 그대로 실린다 (omp, tools.xdev=false)
 *  - meta     : 메타 툴 뒤에 숨는다 (grok `use_tool`, omp 기본값의 `xd://` 디바이스)
 */
const META_TOOLS = { use_tool: 'grok use_tool' };
function resolveExposure(observations) {
  for (const n of observations.toolNamesSeen) {
    if (n === targetTool.name || n.endsWith(targetTool.name) || n.includes('ch_probe')) {
      return { kind: 'direct', callName: n };
    }
  }
  for (const meta of Object.keys(META_TOOLS)) {
    if (observations.toolNamesSeen.has(meta)) return { kind: 'meta', callName: meta };
  }
  return null;
}

/**
 * 외부 유입 MCP 툴 (WBS 7.2.0a 판정축) — 하네스는 MCP 툴을 `mcp__<server>_<tool>`(omp) /
 * `<server>__<tool>`(grok) 로 재접두사한다. 우리 프로브 서버 것을 뺀 나머지는 전부
 * 사용자 홈에서 새어 들어온 서버의 툴이다. 홈 격리가 성립하면 0이어야 한다.
 */
function foreignMcpTools(observations) {
  return [...observations.toolNamesSeen].filter(
    (n) =>
      n.includes('__') &&
      !n.includes('ch_probe') &&
      !n.includes('ch-probe') &&
      !n.includes(TOOL_NAME),
  );
}

function verdictFrom(log, observations) {
  const methods = log.filter((e) => e.kind === 'in').map((e) => e.payload?.method);
  const exposure = resolveExposure(observations);
  return {
    initialized: methods.includes('initialize'),
    registered: methods.includes('tools/list'),
    exposure: exposure ? `${exposure.kind}:${exposure.callName}` : null,
    invoked: log.some((e) => e.kind === 'tool_called'),
    returned: Boolean(observations.toolResultSeen),
  };
}

// ── MCP 등록 (하네스별 관례 경로) ────────────────────────────────────────
/** 서버 프로세스 env — 실서버는 데이터 루트를 찾아야 한다(홈이 격리돼 homedir() 로는 못 찾음) */
function serverEnv(logPath) {
  return realServer
    ? { CUSTOM_HARNESS_HOME: home, CUSTOM_HARNESS_MCP_LOG: logPath }
    : { CH_MCP_PROBE_LOG: logPath, CH_MCP_PROBE_TOOL: TOOL_NAME };
}

function serverBlock(logPath, name = SERVER_NAME) {
  return {
    mcpServers: {
      [name]: { command: process.execPath, args: [MCP_SERVER], env: serverEnv(logPath) },
    },
  };
}

/**
 * omp 17.3.8 — 사용자 스코프는 <configDir>/mcp.json (바이너리 문자열 실측).
 *
 * xdev: omp 는 기본값 `tools.xdev = true` 로 **MCP·확장 툴 스키마를 매 요청에 싣지 않고**
 * `xd://` 디바이스로 마운트해 read/write 로 구동한다(설정 설명 실측). 그래서 tools[] 만
 * 보면 MCP 툴이 없는 것처럼 보인다. false 로 내리면 전 툴이 top-level 로 노출된다.
 */
async function installOmpMcp(logPath, { xdev = true } = {}) {
  await mkdir(paths.ompHomeDir, { recursive: true });
  await writeFile(
    join(paths.ompHomeDir, 'mcp.json'),
    JSON.stringify(serverBlock(logPath), null, 2),
  );
  const configPath = join(paths.ompHomeDir, 'config.yml');
  const raw = await readFile(configPath, 'utf8').catch(() => '');
  const stripped = raw
    .split('\n')
    .filter((l) => !/^\s*xdev:/.test(l))
    .join('\n')
    .replace(/\ntools:\s*(?=\n\S|$)/g, '\n');
  await writeFile(configPath, `${stripped.trimEnd()}\ntools:\n  xdev: ${xdev}\n`);
}

/** grok — 하네스 자신의 CLI 로 등록한다 (config.toml 스키마를 추측하지 않는다) */
async function installGrokMcp(logPath, env) {
  await run(grokPath, ['mcp', 'remove', SERVER_NAME], env, 30_000);
  const envArgs = Object.entries(serverEnv(logPath)).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return run(
    grokPath,
    ['mcp', 'add', SERVER_NAME, '--scope', 'user', ...envArgs, '--', process.execPath, MCP_SERVER],
    env,
    60_000,
  );
}

/**
 * pi — 실서버 모드(7.2.3b)에서는 **확장**으로 간다. pi 는 MCP 를 설계상 배제하므로
 * 같은 카탈로그를 `pi.registerTool` 로 노출하고, 확장이 우리 MCP 서버를 자식으로 띄운다.
 * 진단 로그는 데몬이 spawn 사양에 물려주므로(`CUSTOM_HARNESS_MCP_LOG`) 데몬 기동 **전에** 심는다.
 */
async function installPiExtension() {
  const { registerPiExtension } = await import(join(repoRoot, 'packages/daemon/dist/index.js'));
  return registerPiExtension(paths.piHomeDir);
}

/** pi — MCP 를 의도적으로 넣지 않았다. 관례 경로를 모두 깔아 두고 무반응을 확인한다 */
async function installPiMcp(logPath) {
  // 서버명을 분리한다 — 프로젝트 스코프 .mcp.json 은 grok 도 읽으므로 같은 이름을 쓰면
  // grok 의 사용자 스코프 등록과 충돌해 다른 하네스 측정이 오염된다 (실측)
  const block = JSON.stringify(serverBlock(logPath, `${SERVER_NAME}-pi`), null, 2);
  for (const rel of ['mcp.json', '.mcp.json', 'agent/mcp.json']) {
    const p = join(paths.piHomeDir, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, block);
  }
  await writeFile(join(workDir, '.mcp.json'), block);
}

const results = [];

// ── omp ───────────────────────────────────────────────────────────────────
async function probeOmp({ xdev = true } = {}) {
  if (!ompPath) return { harness: 'omp', skipped: '실행 파일 없음' };
  const o = resetObservations(`omp(xdev=${xdev})`);
  const logPath = join(home, `mcp-omp-xdev-${xdev}.jsonl`);
  await rm(logPath, { force: true });
  await installOmpMcp(logPath, { xdev });
  const env = await gateway.buildEnv('omp');
  const r = await run(
    ompPath,
    ['-p', PROMPT, '--auto-approve', '--no-lsp', '--no-title'],
    env,
    120_000,
  );
  const log = await readMcpLog(logPath);
  return {
    harness: `omp (tools.xdev=${xdev})`,
    version: '17.3.8 (번들)',
    exit: r.code,
    verdict: verdictFrom(log, o),
    requests: o.requests,
    requestTimes: o.requestTimes,
    mcpTimeline: log.map((e) => ({ at: e.at, kind: e.kind, method: e.payload?.method })),
    toolsSeen: [...o.toolNamesSeen].filter((n) => n.includes('ch_probe')),
    foreignMcpTools: foreignMcpTools(o),
    toolResult: o.toolResultSeen?.content?.slice(0, 200) ?? null,
    stdoutTail: r.stdout.slice(-600),
    stderrTail: r.stderr.slice(-600),
  };
}

// ── grok ──────────────────────────────────────────────────────────────────
async function probeGrok() {
  if (!grokPath) return { harness: 'grok', skipped: '실행 파일 없음' };
  const o = resetObservations('grok');
  const logPath = join(home, 'mcp-grok.jsonl');
  const env = await gateway.buildEnv('grok');
  const add = await installGrokMcp(logPath, env);
  const list = await run(grokPath, ['mcp', 'list'], env, 60_000);
  const doctor = await run(grokPath, ['mcp', 'doctor'], env, 90_000);
  // grok 헤드리스 단일 턴: `-p/--single` (`grok agent` 은 stdio/serve 서버 모드다)
  const r = await run(
    grokPath,
    ['-p', PROMPT, '--permission-mode', 'bypassPermissions', '--output-format', 'plain'],
    env,
    150_000,
  );
  const log = await readMcpLog(logPath);
  return {
    harness: 'grok',
    version: '1.0.x (번들)',
    exit: r.code,
    verdict: verdictFrom(log, o),
    requests: o.requests,
    toolsSeen: [...o.toolNamesSeen].filter((n) => n.includes('ch_probe') || n.includes('ch-probe')),
    foreignMcpTools: foreignMcpTools(o),
    allToolsSeen: [...o.toolNamesSeen],
    toolResult: o.toolResultSeen?.content?.slice(0, 200) ?? null,
    addOut: `${add.stdout}${add.stderr}`.slice(-400),
    listOut: `${list.stdout}${list.stderr}`.slice(-600),
    doctorOut: `${doctor.stdout}${doctor.stderr}`.slice(-800),
    stdoutTail: r.stdout.slice(-600),
    stderrTail: r.stderr.slice(-600),
  };
}

// ── pi ────────────────────────────────────────────────────────────────────
// pi 는 MCP 를 의도적으로 넣지 않는다(README "No MCP"). 설정 경로가 정말 없는지
// 실측으로 확인한다 — mcp.json 을 놔둬도 아무 일이 없어야 한다.
async function probePi() {
  if (!piEntry) return { harness: 'pi', skipped: '실행 파일 없음' };
  const o = resetObservations('pi');
  const logPath = join(home, 'mcp-pi.jsonl');
  await installPiMcp(logPath);
  const env = await gateway.buildEnv('pi');
  const r = await run(
    process.execPath,
    [piEntry, '-p', PROMPT, '--model', 'gateway/mock-model'],
    env,
    120_000,
  );
  const log = await readMcpLog(logPath);
  return {
    harness: 'pi',
    version: '0.84.1 (번들)',
    exit: r.code,
    verdict: verdictFrom(log, o),
    requests: o.requests,
    toolsSeen: [...o.toolNamesSeen],
    toolResult: o.toolResultSeen?.content?.slice(0, 200) ?? null,
    stdoutTail: r.stdout.slice(-600),
    stderrTail: r.stderr.slice(-800),
  };
}

// ── 데몬 경로 (실제 제품 경로: omp/pi = --mode rpc, grok = ACP) ───────────
// 하네스를 직접 -p 로 띄우는 것과 우리 어댑터가 띄우는 것이 다를 수 있어 둘 다 잰다.
async function probeViaDaemon() {
  // pi 확장의 MCP 서버 로그 — 데몬이 spawn 사양에 물려주므로 기동 전에 심어야 한다.
  // omp·grok 은 아래 루프에서 각자 로그 경로로 **재등록**하므로 이 값에 영향받지 않는다.
  if (realServer) process.env.CUSTOM_HARNESS_MCP_LOG = join(home, 'mcp-daemon-pi.jsonl');
  // 역방향 툴은 기본 off (WBS 7.2.4) — 실측은 켠 상태를 잰다. 재귀 상한은 넉넉히 둔다
  // (여기서 재는 것은 노출·왕복이지 상한이 아니다 — 상한은 단위 테스트가 고정한다).
  //
  // **덮어쓰지 말고 병합한다** — 같은 파일에 게이트웨이 설정이 이미 들어 있다
  // (GatewayService.setConfig). 통째로 쓰면 baseUrl·모델이 날아가 하네스가 인증에서 죽는다.
  const settingsPath = paths.settingsFile;
  const current = JSON.parse(await readFile(settingsPath, 'utf8').catch(() => '{}'));
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify(
      { ...current, tools: { reverseExposure: true, maxSessionDepth: 2 } },
      null,
      2,
    ),
  );
  const { startDaemon, PiAdapter, OmpAdapter, GrokAdapter } = await import(
    join(repoRoot, 'packages/daemon/dist/index.js')
  );
  const daemon = await startDaemon({
    root: home,
    version: '0.1.0-mcp-probe',
    managedBy: 'cli',
    maxSessions: 6,
    adapters: ({ paths: dp, supervisor }) => [
      ...(piEntry
        ? [
            new PiAdapter({
              command: process.execPath,
              prependArgs: [piEntry],
              supervisor,
              sessionDir: join(dp.dataDir, 'pi-sessions'),
              responseTimeoutMs: 60_000,
            }),
          ]
        : []),
      ...(ompPath
        ? [
            new OmpAdapter({
              command: ompPath,
              supervisor,
              sessionDir: join(dp.dataDir, 'omp-sessions'),
              responseTimeoutMs: 90_000,
            }),
          ]
        : []),
      ...(grokPath
        ? [
            new GrokAdapter({
              command: grokPath,
              // grok ACP 기본 모드(Auto)는 MCP 툴 호출을 승인 요청 없이 거절한다 (실측)
              ...(grokPermissionMode
                ? { prependArgs: ['--permission-mode', grokPermissionMode] }
                : {}),
              supervisor,
              responseTimeoutMs: 90_000,
            }),
          ]
        : []),
    ],
  });
  const events = [];
  const permissions = [];
  // 승인 요청은 자동 승인한다 — 역방향 툴이 승인 채널을 타는지 자체가 관측 대상이다
  daemon.manager.onEvent((e) => {
    events.push(e);
    if (e.type === 'permission_requested') {
      permissions.push({
        sessionId: e.sessionId,
        kind: e.request?.kind,
        // 역방향 툴 승인은 데몬이 만든 요청이다 (7.2.4) — 하네스 요청과 구분해 센다
        origin: e.request?.origin ?? 'harness',
        summary: e.request?.summary,
        options: (e.request?.options ?? []).map((o) => o.optionId ?? o.id),
      });
      const allow =
        (e.request?.options ?? []).find((o) =>
          /allow|approve|yes|once|accept/i.test(`${o.optionId ?? o.id ?? ''}${o.name ?? ''}`),
        ) ?? e.request?.options?.[0];
      if (allow) {
        daemon.manager
          .respondPermission(e.sessionId, e.request.requestId, {
            optionId: allow.optionId ?? allow.id,
          })
          .catch(() => {});
      }
    }
  });
  const MODEL_BY_HARNESS = {
    pi: 'gateway/mock-model',
    omp: 'gateway/mock-model',
    grok: 'mock-model',
  };

  const out = [];
  for (const harness of ['omp', 'grok', 'pi']) {
    if (only && only !== harness) continue;
    const logPath = join(home, `mcp-daemon-${harness}.jsonl`);
    await rm(logPath, { force: true });
    // 등록을 새 로그 경로로 다시 심는다 — CLI 단계 로그와 섞이지 않게
    if (harness === 'omp') await installOmpMcp(logPath, { xdev: false });
    if (harness === 'grok') await installGrokMcp(logPath, await gateway.buildEnv('grok'));
    // 실서버 모드의 pi 는 확장 경로이고, 그 spawn env·로그는 데몬이 소유한다.
    // 로그 경로는 데몬 기동 전에 process.env 로 심어 뒀다(아래 probeViaDaemon 진입부).
    if (harness === 'pi') {
      if (realServer) await installPiExtension();
      else await installPiMcp(logPath);
    }
    const o = resetObservations(`${harness}(daemon)`);
    let error = null;
    let turn1Exposure = null;
    let sessionIdForReport = null;
    let writeResult = null;
    try {
      const session = await daemon.manager.createSession({
        harness,
        cwd: workDir,
        modelId: MODEL_BY_HARNESS[harness],
      });
      sessionIdForReport = session.sessionId;
      // 2턴을 보낸다 — MCP 툴을 비동기로 싣는 하네스는 1턴째에 못 싣는다(omp rpc 경로 실측)
      for (let turn = 1; turn <= 2 && !error; turn += 1) {
        const { turnId } = await daemon.manager.prompt(session.sessionId, PROMPT);
        const deadline = Date.now() + 150_000;
        for (;;) {
          const terminal = events.find(
            (e) =>
              e.sessionId === session.sessionId &&
              (e.type === 'turn_completed' || e.type === 'turn_failed') &&
              e.turnId === turnId,
          );
          if (terminal) {
            if (terminal.type === 'turn_failed') error = terminal.error?.message ?? 'turn_failed';
            break;
          }
          if (Date.now() > deadline) {
            error = 'timeout';
            break;
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        if (turn === 1) turn1Exposure = resolveExposure(o);
      }
      // write 툴 왕복 (7.2.4) — 승인 대기를 낀 경로. 자동 승인은 위 리스너가 한다
      if (writeProbe && !error) {
        const before = (await daemon.manager.listSessions()).length;
        // 목이 부를 툴을 write 로 바꾸고 "이미 한 번 불렀다" 표시를 되돌린다
        targetTool = { name: 'session_new', args: { harness, cwd: workDir } };
        o.toolCallIssued = false;
        o.searchIssued = false;
        o.toolResultSeen = null;
        const { turnId } = await daemon.manager.prompt(
          session.sessionId,
          `Use the session_new tool with harness="${harness}" and cwd="${workDir}". ` +
            `You must call the tool. After the tool returns, reply with DONE and nothing else.`,
        );
        const deadline = Date.now() + 150_000;
        for (;;) {
          const terminal = events.find(
            (e) =>
              e.sessionId === session.sessionId &&
              (e.type === 'turn_completed' || e.type === 'turn_failed') &&
              e.turnId === turnId,
          );
          if (terminal) {
            if (terminal.type === 'turn_failed') {
              writeResult = { error: terminal.error?.message ?? 'turn_failed' };
            }
            break;
          }
          if (Date.now() > deadline) {
            writeResult = { error: 'timeout' };
            break;
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        const after = await daemon.manager.listSessions();
        writeResult = {
          ...(writeResult ?? {}),
          approvals: permissions.filter(
            (x) => x.sessionId === session.sessionId && x.origin === 'reverse_tool',
          ).length,
          sessionsCreated: after.length - before,
          // 라벨이 붙어야 재귀 상한이 다음 세대에도 성립한다
          childLabels:
            after.find((s) => s.labels?.['ch.parentSessionId'] === session.sessionId)?.labels ??
            null,
          toolResult: o.toolResultSeen?.content?.slice(0, 200) ?? null,
        };
        targetTool = { name: TOOL_NAME, args: realServer ? {} : { text: 'ping' } };
      }
      await daemon.manager.closeSession(session.sessionId).catch(() => {});
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const log = await readMcpLog(logPath);
    out.push({
      harness: `${harness} (데몬 경로)`,
      error,
      turn1Exposure: turn1Exposure ? `${turn1Exposure.kind}:${turn1Exposure.callName}` : null,
      permissionsSeen: permissions.filter((x) => x.sessionId === sessionIdForReport),
      verdict: verdictFrom(log, o),
      requests: o.requests,
      toolsSeen: [...o.toolNamesSeen],
      toolResult: o.toolResultSeen?.content?.slice(0, 200) ?? null,
      ...(writeProbe ? { writeTool: writeResult } : {}),
    });
  }
  await daemon.stop?.();
  return out;
}

const only = argValue('--only');
// 실서버는 데몬에 되붙어야 살아난다 — CLI 단독 경로에는 붙을 데몬이 없다.
// 조용히 실패시키지 않고 건너뛴다(실패로 세면 없는 결함을 보고하게 된다).
const cliProbes = realServer
  ? []
  : [
      ['omp', () => probeOmp({ xdev: true })],
      ['omp', () => probeOmp({ xdev: false })],
      ['grok', probeGrok],
      ['pi', probePi],
    ];
if (realServer && !args.includes('--daemon')) {
  console.error('[probe] --real-server 는 --daemon 과 함께 써야 한다 (서버가 데몬에 되붙는다)');
  process.exit(2);
}
for (const [name, fn] of cliProbes) {
  if (only && only !== name) continue;
  console.log(`\n[probe] ── ${name} ──`);
  const result = await fn();
  results.push(result);
  console.log(JSON.stringify(result, null, 2));
}

if (args.includes('--daemon')) {
  console.log('\n[probe] ── 데몬 경로 ──');
  for (const r of await probeViaDaemon()) {
    results.push(r);
    console.log(JSON.stringify(r, null, 2));
  }
}

mockGateway.close();
if (!keep) {
  await rm(home, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
} else {
  console.log(`\n[probe] --keep: ${home}, ${workDir}`);
}

console.log('\n[probe] 요약');
for (const r of results) {
  if (r.skipped) {
    console.log(`  ${r.harness}: SKIP (${r.skipped})`);
    continue;
  }
  const v = r.verdict;
  console.log(
    `  ${r.harness}: initialized=${v.initialized} registered=${v.registered} ` +
      `exposure=${v.exposure} invoked=${v.invoked} returned=${v.returned} ` +
      `foreign=${r.foreignMcpTools?.length ?? 0}` +
      (r.writeTool
        ? ` write(승인 ${r.writeTool.approvals ?? 0}건, 세션 +${r.writeTool.sessionsCreated ?? 0}` +
          `${r.writeTool.error ? `, error=${r.writeTool.error}` : ''})`
        : ''),
  );
}
