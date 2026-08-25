#!/usr/bin/env node
// 테스트용 fake pi — pi 0.84.1 의 `--mode rpc` JSONL 프로토콜(실측 스키마)을 흉내낸다.
// 시나리오 마커: [approval] 승인 게이트, [fail] 턴 실패, [tool:<name>] 툴명, [wait] 완료 보류, [die] 비정상 종료.
'use strict';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('0.84.1-fake\n');
  process.exit(0);
}
const sessionArg = args.indexOf('--session');
const sessionFile = sessionArg >= 0 ? args[sessionArg + 1] : '/fake/sessions/native-abc.jsonl';

const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
let activeTurn = false;
let pendingUi = null; // { resolve }

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 };
const assistant = (stopReason, errorMessage) => ({
  role: 'assistant',
  content: [],
  usage,
  stopReason,
  ...(errorMessage ? { errorMessage } : {}),
  timestamp: 0,
});

async function runScenario(message) {
  activeTurn = true;
  out({ type: 'agent_start' });
  out({ type: 'turn_start' });
  // 관대 파싱 검증용 — 비 JSON 줄과 미지 이벤트 주입
  process.stdout.write('this is not json\n');
  out({ type: 'mystery_event', payload: { future: true } });

  out({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '생각 중…' } });
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '작업을 ' } });
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '시작합니다' } });

  if (message.includes('[approval]')) {
    const confirmed = await new Promise((resolve) => {
      pendingUi = { resolve };
      out({
        type: 'extension_ui_request',
        id: 'ui-1',
        method: 'confirm',
        title: '승인',
        message: 'rm 실행',
      });
    });
    pendingUi = null;
    if (!confirmed) {
      activeTurn = false;
      out({ type: 'agent_end', messages: [assistant('aborted')] });
      return;
    }
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
    case 'get_state':
      out({
        type: 'response',
        id: cmd.id,
        command: 'get_state',
        success: true,
        data: { sessionId: 'native-abc', sessionFile, isStreaming: activeTurn, thinkingLevel: 'off' },
      });
      return;
    case 'prompt':
      out({ type: 'response', id: cmd.id, command: 'prompt', success: true });
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
      if (pendingUi) pendingUi.resolve(cmd.confirmed === true && cmd.cancelled !== true);
      return;
    default:
      out({ type: 'response', id: cmd.id, command: String(cmd.type), success: false, error: `unknown command: ${cmd.type}` });
  }
}
