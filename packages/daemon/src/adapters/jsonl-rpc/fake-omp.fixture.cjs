#!/usr/bin/env node
// 테스트용 fake omp — oh-my-pi 17.3.8 의 `--mode rpc-ui` JSONL 프로토콜(소스·행동 실측)을 흉내낸다.
// 실측 재현: ready 핸드셰이크(v[1,2]), negotiate_protocol, v2 rpc_chunk(256KiB) 송신 청킹,
// 재개(--session) 시 기동 리플레이 없음.
// 시나리오 마커: [fail] 턴 실패, [tool:<name>] 툴명, [wait] 완료 보류, [die] 비정상 종료,
// [uiconfirm] extension_ui_request confirm 발행(어댑터의 자동 취소 격하 검증),
// [bigframe] 1MiB 초과 message_update 를 rpc_chunk 로 송신 (v1 이면 축약 프레임).
// 환경: FAKE_OMP_NO_V2=1 → negotiate 거부(구버전 흉내), FAKE_OMP_REPLAY=1 → 기동 직후
// 과거 이벤트 리플레이 방출(리플레이 드롭 가드 검증 — 버전 드리프트 가정).
'use strict';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('omp/17.3.8-fake\n');
  process.exit(0);
}
const sessionArg = args.indexOf('--session');
const sessionFile = sessionArg >= 0 ? args[sessionArg + 1] : '/fake/sessions/omp-native.jsonl';
const approvalArg = args.indexOf('--approval-mode');
const approvalMode = approvalArg >= 0 ? args[approvalArg + 1] : null;

const CHUNK_PAYLOAD = 256 * 1024;
const MAX_FRAME = 1024 * 1024;
let protocolVersion = 1;
let chunkCounter = 0;

const rawOut = (line) => process.stdout.write(line);
const out = (frame) => {
  const json = JSON.stringify(frame);
  if (Buffer.byteLength(json, 'utf8') + 1 <= MAX_FRAME || protocolVersion !== 2) {
    // v1 대형 프레임 축약은 실물이 shrink 하지만 여기선 마커만 — 테스트는 v2 경로를 본다
    rawOut(`${json}\n`);
    return;
  }
  const bytes = Buffer.from(json, 'utf8');
  const count = Math.ceil(bytes.byteLength / CHUNK_PAYLOAD);
  const chunkId = `rpc-${++chunkCounter}`;
  for (let index = 0; index < count; index++) {
    rawOut(
      `${JSON.stringify({
        type: 'rpc_chunk',
        chunkId,
        index,
        count,
        byteLength: bytes.byteLength,
        data: bytes.subarray(index * CHUNK_PAYLOAD, (index + 1) * CHUNK_PAYLOAD).toString('base64'),
      })}\n`,
    );
  }
};

let activeTurn = false;
let uiCancelled = false;

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 };
const assistant = (stopReason, errorMessage) => ({
  role: 'assistant',
  content: [],
  usage,
  stopReason,
  ...(errorMessage ? { errorMessage } : {}),
  timestamp: 0,
});

// 실측 기동 시퀀스: ready → (표시성 extension_ui_request) → available_commands_update
out({
  type: 'ready',
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: MAX_FRAME,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
});
out({ type: 'extension_ui_request', id: 'w-1', method: 'setWidget', widgetKey: 'fake' });
out({ type: 'available_commands_update', commands: [] });
if (process.env.FAKE_OMP_REPLAY === '1') {
  // 버전 드리프트 가정 리플레이 — 어댑터 가드가 드롭해야 한다
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '리플레이 잔향' } });
  out({ type: 'tool_execution_start', toolCallId: 'old-1', toolName: 'bash', args: {} });
  out({ type: 'agent_end', messages: [assistant('stop')] });
}

async function runScenario(message) {
  activeTurn = true;
  out({ type: 'agent_start' });
  out({ type: 'turn_start' });
  // 관대 파싱 검증용 — 비 JSON 줄과 미지 이벤트 주입
  rawOut('this is not json\n');
  out({ type: 'notice', level: 'info', message: 'fake notice', source: 'fake' });
  out({ type: 'prompt_result', agentInvoked: true });

  out({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '생각 중…' } });
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '작업을 ' } });
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '시작합니다' } });

  if (message.includes('[bigframe]')) {
    // 1MiB 초과 논리 프레임 — v2 면 rpc_chunk 로 나간다
    out({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(1_500_000) },
    });
  }

  if (message.includes('[uiconfirm]')) {
    // 어댑터는 즉시 cancelled 응답으로 격하해야 한다 — 응답이 오면 턴을 계속한다
    await new Promise((resolve) => {
      pendingUi = { id: 'ui-omp-1', resolve };
      out({ type: 'extension_ui_request', id: 'ui-omp-1', method: 'confirm', title: '확인', message: '계속?' });
    });
    pendingUi = null;
  }

  if (message.includes('[wait]')) return; // abort 가 올 때까지 완료 보류

  const toolMatch = /\[tool:([^\]]+)\]/.exec(message);
  const toolName = toolMatch ? toolMatch[1] : 'bash';
  out({ type: 'tool_execution_start', toolCallId: 'tc-1', toolName, args: { command: 'echo hi' } });
  out({ type: 'tool_execution_update', toolCallId: 'tc-1', toolName, args: {}, partialResult: { line: 1 } });
  out({ type: 'tool_execution_end', toolCallId: 'tc-1', toolName, result: { stdout: 'hi' }, isError: false });

  activeTurn = false;
  if (message.includes('[fail]')) {
    out({ type: 'agent_end', messages: [assistant('error', 'boom')] });
    return;
  }
  out({ type: 'turn_end', message: assistant('stop'), toolResults: [] });
  out({ type: 'agent_end', messages: [assistant('stop')] });

  if (message.includes('[die]')) process.exit(7);
}

let pendingUi = null; // { id, resolve }
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    handle(cmd);
  }
});

function handle(cmd) {
  switch (cmd.type) {
    case 'negotiate_protocol':
      if (process.env.FAKE_OMP_NO_V2 === '1' || cmd.protocolVersion !== 2) {
        out({
          type: 'response',
          id: cmd.id,
          command: 'negotiate_protocol',
          success: false,
          error: `Unsupported RPC protocol version: ${cmd.protocolVersion}`,
        });
        return;
      }
      protocolVersion = 2;
      out({
        type: 'response',
        id: cmd.id,
        command: 'negotiate_protocol',
        success: true,
        data: { protocolVersion: 2 },
      });
      return;
    case 'get_state':
      out({
        type: 'response',
        id: cmd.id,
        command: 'get_state',
        success: true,
        data: {
          sessionId: 'omp-native-abc',
          sessionFile,
          isStreaming: activeTurn,
          thinkingLevel: 'high',
          // 어댑터 spawn 인자 검증용 (실물 get_state 에는 없음 — fake 확장)
          fakeApprovalMode: approvalMode,
          fakeUiCancelled: uiCancelled,
        },
      });
      return;
    case 'prompt':
      out({ type: 'response', id: cmd.id, command: 'prompt', success: true, data: { agentInvoked: true } });
      void runScenario(String(cmd.message ?? ''));
      return;
    case 'abort':
      out({ type: 'response', id: cmd.id, command: 'abort', success: true });
      if (activeTurn) {
        activeTurn = false;
        out({ type: 'agent_end', messages: [assistant('aborted')] });
      }
      return;
    case 'set_model':
      out({ type: 'response', id: cmd.id, command: 'set_model', success: true, data: { id: cmd.modelId } });
      return;
    case 'extension_ui_response':
      if (cmd.cancelled === true) uiCancelled = true;
      if (pendingUi && cmd.id === pendingUi.id) pendingUi.resolve();
      return;
    default:
      out({ type: 'response', id: cmd.id, command: String(cmd.type), success: false, error: `unknown command: ${cmd.type}` });
  }
}
