#!/usr/bin/env node
// grok 권한 모드 실측 (M7 WBS 7.2.0b) — 7.2.1 에서 검출한 결함의 해결책을 고른다.
//
// 결함: `grok agent stdio` 를 권한 모드 지정 없이 띄우면 MCP 툴 호출이
// `Auto mode blocked this action` 으로 **잘리는데 `session/request_permission` 이 오지 않는다**.
// 사용자가 승인할 기회조차 없다(FR-1.5 무력화).
//
// 측정: 모드마다 데몬 + 실물 grok 세션을 하나 띄우고, 목 게이트웨이가 한 턴 안에서
//   ① search_tool → ② use_tool(우리 MCP 툴) → ③ 내장 쓰기 툴
// 을 차례로 호출시켜 각 단계에서
//   - `permission_requested` 가 오는가 (= 사용자 승인 채널이 사는가)
//   - 툴이 실제 실행됐는가 (MCP 서버 로그 / 파일 생성)
//   - 잘렸다면 어떤 사유 문구로 잘렸는가
// 를 기록한다. 판정 목표는 **"MCP 툴은 승인 대상, 내장 파괴적 툴도 승인 대상"** 이 동시에 서는 모드다.
//
// 사용: node scripts/grok-permission-probe.mjs [--modes a,b,c] [--grok <path>] [--keep]
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const MCP_SERVER = join(repoRoot, 'scripts/mcp-probe/mock-mcp-server.mjs');
const TOOL_NAME = 'ch_probe_echo';
const VALID_KEY = 'sk-grok-perm-probe';

// 'unset' = 플래그를 아예 주지 않는 현행 동작 (결함 재현 기준선)
const MODES = (argValue('--modes') ?? 'unset,default,acceptEdits,auto,dontAsk,bypassPermissions')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

const exists = async (p) =>
  access(p)
    .then(() => true)
    .catch(() => false);
const grokDefault = join(homedir(), '.grok/bin/grok');
const grokPath =
  argValue('--grok') ??
  process.env.CUSTOM_HARNESS_GROK_PATH ??
  ((await exists(grokDefault)) ? grokDefault : undefined);
if (!grokPath) {
  console.error('grok 실행 파일을 찾지 못함 — --grok 지정 필요');
  process.exit(2);
}

const { startDaemon, GatewayService, KeyStore, GrokAdapter, resolvePaths } = await import(
  join(repoRoot, 'packages/daemon/dist/index.js')
);

// ── 계획 구동 목 게이트웨이 ───────────────────────────────────────────────
// 휴리스틱 대신 **호출 순서를 고정**한다 — 모드 간 비교가 목적이라 자극이 같아야 한다.
let obs = null;
function resetObservations(mode, plan) {
  obs = { mode, plan, planIndex: 0, requests: 0, toolNamesSeen: new Set(), notices: [] };
  return obs;
}

/** 잘림 사유는 도구 결과가 아니라 대화 텍스트로 되돌아온다 (실측) */
function collectNotices(body) {
  const out = [];
  for (const m of body?.messages ?? []) {
    const content =
      typeof m?.content === 'string'
        ? m.content
        : Array.isArray(m?.content)
          ? m.content.map((c) => c?.text ?? '').join('')
          : '';
    for (const line of content.split('\n')) {
      if (/not executed|blocked|denied|rejected|requires approval/i.test(line))
        out.push(line.trim());
      if (line.includes('CH_MCP_PROBE_OK')) out.push(line.trim());
    }
  }
  return out;
}

let toolCallSeq = 0;
const mockGateway = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${VALID_KEY}`) {
    res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: {} }));
    return;
  }
  if (req.url === '/v1/models') {
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
    return;
  }
  if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* 무시 */
    }
    if (obs) {
      obs.requests += 1;
      for (const t of body?.tools ?? []) {
        const n = t?.function?.name ?? t?.name;
        if (typeof n === 'string') obs.toolNamesSeen.add(n);
      }
      for (const n of collectNotices(body)) if (!obs.notices.includes(n)) obs.notices.push(n);
    }
    // 계획의 다음 단계를 발행한다. 단계가 남지 않았으면 텍스트로 턴을 끝낸다.
    const step = obs?.plan?.[obs.planIndex];
    const resolved = typeof step === 'function' ? step(obs) : step;
    if (resolved) obs.planIndex += 1;
    toolCallSeq += 1;
    const usage = { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 };
    const wantsStream = body?.stream === true || /"stream"\s*:\s*true/.test(raw);
    if (wantsStream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const chunk = (delta, finish = null, extra) =>
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-perm-probe',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'mock-model',
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...(extra ?? {}),
          })}\n\n`,
        );
      chunk({ role: 'assistant', content: '' });
      if (resolved) {
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `call_${toolCallSeq}`,
              type: 'function',
              function: { name: resolved.name, arguments: JSON.stringify(resolved.args) },
            },
          ],
        });
        chunk({}, 'tool_calls', { usage });
      } else {
        chunk({ content: '확인했습니다.' });
        chunk({}, 'stop', { usage });
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        id: 'chatcmpl-perm-probe',
        object: 'chat.completion',
        created: 0,
        model: 'mock-model',
        choices: [
          {
            index: 0,
            message: resolved
              ? {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: `call_${toolCallSeq}`,
                      type: 'function',
                      function: { name: resolved.name, arguments: JSON.stringify(resolved.args) },
                    },
                  ],
                }
              : { role: 'assistant', content: '확인했습니다.' },
            finish_reason: resolved ? 'tool_calls' : 'stop',
          },
        ],
        usage,
      }),
    );
  });
});
await new Promise((r) => mockGateway.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${mockGateway.address().port}/v1`;
console.log(`[perm] 목 게이트웨이: ${baseUrl}`);

const home = await mkdtemp(join(tmpdir(), 'ch-grok-perm-'));
const workDir = await mkdtemp(join(tmpdir(), 'ch-grok-perm-work-'));
const paths = resolvePaths(home);
const keyStore = new KeyStore(paths.credentialsFile);
const gateway = new GatewayService(paths, keyStore);
await gateway.setConfig({ baseUrl, models: [{ id: 'mock-model' }], defaultModel: 'mock-model' });
await keyStore.set(VALID_KEY);
console.log(`[perm] 격리 홈: ${home}`);

const run = (cmd, argv, env) =>
  new Promise((resolve) => {
    execFile(cmd, argv, { env: { ...process.env, ...env }, timeout: 60_000 }, (e, stdout, stderr) =>
      resolve({ code: e?.code ?? 0, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });

/** MCP 등록은 하네스 자신의 CLI 에 위임한다 (7.2.1 에서 확정한 정본 창구) */
async function installGrokMcp(logPath) {
  const env = await gateway.buildEnv('grok');
  await run(grokPath, ['mcp', 'remove', 'ch-probe'], env);
  return run(
    grokPath,
    [
      'mcp',
      'add',
      'ch-probe',
      '--scope',
      'user',
      '-e',
      `CH_MCP_PROBE_LOG=${logPath}`,
      '-e',
      `CH_MCP_PROBE_TOOL=${TOOL_NAME}`,
      '--',
      process.execPath,
      MCP_SERVER,
    ],
    env,
  );
}

async function readMcpLog(path) {
  try {
    return (await readFile(path, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** 내장 쓰기 툴 이름은 버전마다 다를 수 있다 — 실제 노출된 이름에서 고른다 */
function pickBuiltinWrite(names) {
  for (const candidate of ['write', 'create_file', 'write_file', 'edit', 'str_replace']) {
    if (names.has(candidate)) return candidate;
  }
  return undefined;
}

const results = [];
for (const mode of MODES) {
  const logPath = join(home, `mcp-${mode}.jsonl`);
  const writeTarget = join(workDir, `perm-${mode}.txt`);
  await rm(logPath, { force: true });
  await rm(writeTarget, { force: true });
  await installGrokMcp(logPath);

  const daemon = await startDaemon({
    root: home,
    version: '0.1.0-perm-probe',
    managedBy: 'cli',
    maxSessions: 2,
    adapters: ({ supervisor }) => [
      new GrokAdapter({
        command: grokPath,
        ...(mode === 'unset' ? {} : { prependArgs: ['--permission-mode', mode] }),
        supervisor,
        responseTimeoutMs: 90_000,
      }),
    ],
  });

  const permissions = [];
  const events = [];
  daemon.manager.onEvent((e) => {
    events.push(e);
    if (e.type !== 'permission_requested') return;
    const options = (e.request?.options ?? []).map((o) => ({
      id: o.optionId ?? o.id,
      name: o.name,
      kind: o.kind,
    }));
    permissions.push({
      at: permissions.length + 1,
      kind: e.request?.kind,
      summary: e.request?.summary,
      // 옵션의 kind 까지 남긴다 — 영속 승인(allow_always)을 1회 승인으로 잘못 라벨링하면
      // 사용자가 무엇에 동의했는지 화면과 실제가 어긋난다 (FR-1.5)
      options,
    });
    // 자동 승인 — 승인 채널이 살아 있는지가 관측 대상이지 사람의 판단이 아니다
    const allow =
      options.find((o) => /allow|approve|yes|once|accept/i.test(`${o.id ?? ''}${o.name ?? ''}`)) ??
      options[0];
    if (allow) {
      daemon.manager
        .respondPermission(e.sessionId, e.request.requestId, { optionId: allow.id })
        .catch(() => {});
    }
  });

  const record = { mode, error: null };
  try {
    const session = await daemon.manager.createSession({
      harness: 'grok',
      cwd: workDir,
      modelId: 'mock-model',
    });
    // 1턴: 노출 관측만 (grok 은 MCP 툴을 search_tool/use_tool 뒤에 숨긴다)
    const o = resetObservations(mode, []);
    await promptAndWait(daemon, session.sessionId, '준비됐으면 짧게 답해.', events);

    // 2턴: search_tool → use_tool(우리 MCP 툴) → 내장 쓰기. 계획 고정.
    const builtin = pickBuiltinWrite(o.toolNamesSeen);
    resetObservations(mode, [
      { name: 'search_tool', args: { query: `ch-probe ${TOOL_NAME} echo` } },
      {
        name: 'use_tool',
        args: { tool_name: `ch-probe__${TOOL_NAME}`, tool_input: { text: 'ping' } },
      },
      ...(builtin
        ? [
            {
              name: builtin,
              args: { path: writeTarget, file_path: writeTarget, content: 'perm probe\n' },
            },
          ]
        : []),
    ]);
    obs.toolNamesSeen = o.toolNamesSeen;
    await promptAndWait(daemon, session.sessionId, '요청한 도구를 순서대로 실행해.', events);

    const log = await readMcpLog(logPath);
    record.builtinTool = builtin ?? null;
    record.mcpInvoked = log.some((e) => e.kind === 'tool_called');
    record.builtinWrote = await exists(writeTarget);
    record.permissions = permissions;
    record.mcpPermission = permissions.some((p) =>
      /use_tool|search_tool|ch-probe|ch_probe|mcp/i.test(`${p.summary ?? ''}${p.kind ?? ''}`),
    );
    record.builtinPermission = Boolean(
      builtin &&
      permissions.some((p) =>
        new RegExp(`${builtin}|write|create|edit|파일`, 'i').test(`${p.summary ?? ''}`),
      ),
    );
    record.notices = obs.notices.filter((n) => !n.includes('CH_MCP_PROBE_OK')).slice(0, 4);
    record.mcpResultReturned = obs.notices.some((n) => n.includes('CH_MCP_PROBE_OK'));
    await daemon.manager.closeSession(session.sessionId).catch(() => {});
  } catch (e) {
    record.error = e instanceof Error ? e.message : String(e);
  }
  await daemon.stop?.();
  results.push(record);
  console.log(`\n[perm] ── ${mode} ──`);
  console.log(JSON.stringify(record, null, 2));
}

async function promptAndWait(daemon, sessionId, text, events, timeoutMs = 120_000) {
  const { turnId } = await daemon.manager.prompt(sessionId, text);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const terminal = events.find(
      (e) =>
        e.sessionId === sessionId &&
        e.turnId === turnId &&
        (e.type === 'turn_completed' || e.type === 'turn_failed'),
    );
    if (terminal) return terminal;
    if (Date.now() > deadline) throw new Error(`턴 타임아웃 (${timeoutMs / 1000}s)`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

mockGateway.close();
if (!args.includes('--keep')) {
  await rm(home, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
} else {
  console.log(`\n[perm] --keep: ${home}, ${workDir}`);
}

console.log('\n[perm] 요약 (승인요청 = session/request_permission 도달 여부)');
for (const r of results) {
  if (r.error) {
    console.log(`  ${r.mode}: ERROR ${r.error}`);
    continue;
  }
  console.log(
    `  ${r.mode.padEnd(18)} MCP[승인요청=${r.mcpPermission} 실행=${r.mcpInvoked} 결과반영=${r.mcpResultReturned}] ` +
      `내장(${r.builtinTool ?? '-'})[승인요청=${r.builtinPermission} 실행=${r.builtinWrote}]`,
  );
}
process.exit(0);
