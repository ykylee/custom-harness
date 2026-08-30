// 번들 터미널 스모크 (WBS 6.7.2) — 조립된 번들의 Electron(RUN_AS_NODE)으로 데몬을 띄우고
// 워크스페이스 → 터미널 생성 → attach → 바이너리 입력 → 출력까지 실제로 왕복한다.
//
// 이 스모크의 존재 이유: node-pty 는 네이티브 모듈이라 "테스트는 통과하는데 번들에서는 못 뜨는"
// 실패가 가능하다. 개발 트리의 node_modules 가 아니라 **동봉된 prebuilt** 를 쓰는지 확인한다.
//
// 사용: node scripts/terminal-bundle-smoke.mjs <번들 디렉토리 절대경로>
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const bundle = process.argv[2];
if (!bundle || !bundle.startsWith('/')) {
  console.error('사용: node scripts/terminal-bundle-smoke.mjs <번들 디렉토리 절대경로>');
  process.exit(2);
}
const home = await mkdtemp(join(tmpdir(), 'ch-bterm-'));
const work = await mkdtemp(join(tmpdir(), 'ch-bterm-work-'));
const electron =
  process.platform === 'darwin'
    ? join(bundle, 'app', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : join(bundle, 'app', 'electron', process.platform === 'win32' ? 'electron.exe' : 'electron');
const daemonMain = join(bundle, 'app', 'node_modules', '@custom-harness', 'daemon', 'dist', 'main.js');

const child = spawn(electron, [daemonMain], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    CUSTOM_HARNESS_HOME: home,
    CUSTOM_HARNESS_MANIFEST: join(bundle, 'manifest.json'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => (stderr += String(d)));

const pidFile = join(home, 'data', 'daemon.pid');
let info;
for (let i = 0; i < 100 && info === undefined; i += 1) {
  await new Promise((r) => setTimeout(r, 200));
  try { info = JSON.parse(await readFile(pidFile, 'utf8')); } catch { /* 대기 */ }
}
if (!info) { console.error('데몬 기동 실패\n' + stderr.slice(-800)); process.exit(1); }
const token = (await readFile(join(home, 'data', 'daemon.token'), 'utf8')).trim();

const { decodeTerminalFrame, encodeTerminalFrame, TERMINAL_OPCODE, PROTOCOL_VERSION } =
  await import(join(bundle, 'app', 'node_modules', '@custom-harness', 'protocol', 'dist', 'index.js'));

const ws = new WebSocket(`ws://127.0.0.1:${info.port}`, [], {
  headers: { authorization: `Bearer ${token}` },
});
ws.binaryType = 'arraybuffer';
const json = [];
let out = '';
let slot;
ws.on('message', (data, isBinary) => {
  if (isBinary) {
    const frame = decodeTerminalFrame(new Uint8Array(data));
    if (frame?.opcode === TERMINAL_OPCODE.output && frame.slot === slot) {
      out += Buffer.from(frame.payload).toString('utf8');
    }
    return;
  }
  json.push(JSON.parse(String(data)));
});
const waitJson = async (predicate, label) => {
  for (let i = 0; i < 150; i += 1) {
    const hit = json.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`타임아웃: ${label}`);
};

await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, clientInfo: { name: 'smoke', version: '0' }, capabilities: {} }));
const hello = await waitJson((m) => m.type === 'hello.response', 'hello');
console.log('[smoke] features.terminalBinaryFrames =', hello.features?.terminalBinaryFrames);

ws.send(JSON.stringify({ type: 'project.open.request', requestId: 'p1', params: { root: work } }));
const opened = await waitJson((m) => m.type === 'project.open.response', 'project.open');
const workspaceId = opened.result.workspace.id;

ws.send(JSON.stringify({ type: 'terminal.create.request', requestId: 't1', params: { workspaceId, cols: 80, rows: 24 } }));
const created = await waitJson((m) => m.type === 'terminal.create.response', 'terminal.create');
if (!created.ok) { console.error('[smoke] FAIL terminal.create:', JSON.stringify(created.error)); process.exit(1); }
const terminalId = created.result.terminal.id;

ws.send(JSON.stringify({ type: 'terminal.attach.request', requestId: 't2', params: { terminalId, cols: 80, rows: 24 } }));
const attached = await waitJson((m) => m.type === 'terminal.attach.response', 'terminal.attach');
slot = attached.result.slot;

ws.send(encodeTerminalFrame({ opcode: TERMINAL_OPCODE.input, slot, payload: new TextEncoder().encode('echo BUNDLE_PTY_OK\n') }), { binary: true });
for (let i = 0; i < 100 && !out.includes('BUNDLE_PTY_OK'); i += 1) await new Promise((r) => setTimeout(r, 100));

const ok = out.includes('BUNDLE_PTY_OK');
console.log(ok ? '[smoke] PASS — 번들 Electron 에서 pty 왕복 성공' : `[smoke] FAIL — 출력: ${out.slice(-300)}\n${stderr.slice(-600)}`);
ws.close();
child.kill('SIGTERM');
await rm(home, { recursive: true, force: true });
await rm(work, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
