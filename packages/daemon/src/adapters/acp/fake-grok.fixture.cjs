#!/usr/bin/env node
// 테스트용 fake grok — grok 1.0.5 `agent stdio` ACP 프로토콜(행동 실측)을 흉내낸다.
// 실측 재현: initialize capability, session/new, session/prompt(응답=턴 종료, _meta.usage),
// session/update 알림(chunk·tool_call·tool_call_update), session/request_permission
// (allow-once/reject-once 2종), session/cancel → stopReason cancelled,
// session/load → 응답 전 히스토리 리플레이.
// 시나리오 마커: [approval] 승인 게이트, [fail] 턴 실패, [tool:<name>] 툴명(kind other),
// [wait] 완료 보류, [die] 비정상 종료.
'use strict';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  if (process.env.FAKE_GROK_BOGUS === '1') {
    process.stdout.write('SuperGrok CLI v9.9 (unofficial)\n');
  } else {
    process.stdout.write('grok 1.0.5-fake (deadbeef) [stable]\n');
  }
  process.exit(0);
}

const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const notify = (method, params) => out({ jsonrpc: '2.0', method, params });
const update = (sessionId, u) => notify('session/update', { sessionId, update: u });

let nextServerId = 1000;
let sessionId = null;
let cancelRequested = false;
let pendingPrompt = null; // { id } — [wait] 시나리오 보류
let pendingPermission = null; // { id, resolve }
let modelId = 'mock';

const usageMeta = {
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedReadTokens: 0 },
};

async function runPrompt(id, text) {
  cancelRequested = false;
  update(sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '생각 중…' } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '작업을 ' } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '시작합니다' } });

  if (text.includes('[wait]')) {
    pendingPrompt = { id };
    return; // session/cancel 이 올 때까지 보류
  }

  const toolMatch = /\[tool:([^\]]+)\]/.exec(text);
  const toolName = toolMatch ? toolMatch[1] : 'bash';
  const kind = toolMatch ? 'other' : 'execute';
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'call_1',
    kind,
    title: `Execute \`${toolName}\``,
    rawInput: { command: 'echo hi' },
    _meta: { 'x.ai/tool': { name: toolName, kind } },
  });

  if (text.includes('[approval]')) {
    const allowed = await new Promise((resolve) => {
      const reqId = nextServerId++;
      pendingPermission = { id: reqId, resolve };
      out({
        jsonrpc: '2.0',
        id: reqId,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: {
            toolCallId: 'call_1',
            kind: 'execute',
            title: 'Execute `echo hi`',
            rawInput: { command: 'echo hi' },
          },
          options: [
            { optionId: 'allow-once', name: 'Yes, proceed', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'No, and tell Grok what to do differently', kind: 'reject_once' },
          ],
        },
      });
    });
    pendingPermission = null;
    if (!allowed) {
      // 실측: 거부 시 툴은 실패하고 턴은 정상 완결(end_turn) — 모델이 거부를 안고 계속
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'failed' });
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '알겠습니다' } });
      out({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', _meta: { ...usageMeta } } });
      return;
    }
  }

  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'in_progress' });
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'hi' } }],
  });

  if (text.includes('[fail]')) {
    out({ jsonrpc: '2.0', id, error: { code: -32000, message: 'boom' } });
    return;
  }
  out({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', _meta: { modelId, ...usageMeta } } });
  if (text.includes('[die]')) process.exit(7);
}

function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      out({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } },
          authMethods: [{ id: 'xai.api_key', name: 'xai.api_key' }],
        },
      });
      return;
    case 'session/new':
      sessionId = 'grok-acp-session-1';
      out({
        jsonrpc: '2.0',
        id,
        result: {
          sessionId,
          models: { currentModelId: modelId, availableModels: [{ modelId: 'mock', name: 'Mock' }] },
        },
      });
      return;
    case 'session/load': {
      sessionId = String(params.sessionId);
      // 실측: 응답 전에 히스토리가 session/update 로 리플레이된다
      update(sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '과거 질문' } });
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '과거 응답' } });
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'old_call',
        kind: 'execute',
        title: 'Execute `old`',
        _meta: { 'x.ai/tool': { name: 'bash', kind: 'execute' } },
      });
      out({ jsonrpc: '2.0', id, result: { models: { currentModelId: modelId } } });
      return;
    }
    case 'session/prompt': {
      const text = (params.prompt ?? []).map((p) => p.text ?? '').join('');
      void runPrompt(id, text);
      return;
    }
    case 'session/cancel':
      cancelRequested = true;
      if (pendingPrompt) {
        out({ jsonrpc: '2.0', id: pendingPrompt.id, result: { stopReason: 'cancelled', _meta: { ...usageMeta } } });
        pendingPrompt = null;
      }
      return; // 알림 — 응답 없음
    case 'session/set_model':
      modelId = String(params.modelId);
      out({ jsonrpc: '2.0', id, result: { _meta: { model: { Ok: modelId } } } });
      return;
    default:
      if (id !== undefined) {
        out({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } });
      }
  }
}

// 클라이언트 응답 (request_permission 회신) 처리
function handleResponse(msg) {
  if (pendingPermission && msg.id === pendingPermission.id) {
    const outcome = msg.result?.outcome;
    pendingPermission.resolve(outcome?.outcome === 'selected' && outcome.optionId === 'allow-once');
  }
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method) handle(msg);
    else handleResponse(msg);
  }
});

// SIGTERM 시 세션 저장 후 정상 종료 (실측 #9 재현 — 저장은 상태 플래그로 대체)
process.on('SIGTERM', () => process.exit(0));
