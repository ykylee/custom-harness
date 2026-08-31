#!/usr/bin/env node
// 목 MCP stdio 서버 (WBS 7.2.1 실측 도구)
// MCP stdio 전송 = 줄 단위 JSON-RPC 2.0. 하네스가 실제로 서버를 띄우고 tools/list ·
// tools/call 을 왕복하는지 판정하기 위한 최소 구현이다. 모든 수신 메시지는
// CH_MCP_PROBE_LOG 파일에 JSONL 로 append 되어 오케스트레이터가 사후 판정한다.
import { appendFileSync } from 'node:fs';
import process from 'node:process';

const logPath = process.env.CH_MCP_PROBE_LOG;
const TOOL_NAME = process.env.CH_MCP_PROBE_TOOL ?? 'ch_probe_echo';

function log(kind, payload) {
  if (!logPath) return;
  appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), kind, payload })}\n`);
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
  log('out', msg);
}

const TOOLS = [
  {
    name: TOOL_NAME,
    description:
      'Probe tool for custom-harness MCP measurement. Echoes back the given text. Call it exactly once with text="ping".',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'text to echo' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

function handle(msg) {
  log('in', msg);
  const { id, method, params } = msg;
  // 알림(id 없음)은 응답하지 않는다
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize':
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          // 클라이언트가 요청한 버전을 그대로 되돌려 협상 실패를 피한다
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'ch-mcp-probe', version: '0.0.1' },
        },
      });
    case 'ping':
      return send({ jsonrpc: '2.0', id, result: {} });
    case 'tools/list':
      return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    case 'tools/call': {
      const text = params?.arguments?.text ?? '';
      log('tool_called', { name: params?.name, arguments: params?.arguments });
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `CH_MCP_PROBE_OK:${text}` }],
          isError: false,
        },
      });
    }
    case 'resources/list':
      return send({ jsonrpc: '2.0', id, result: { resources: [] } });
    case 'prompts/list':
      return send({ jsonrpc: '2.0', id, result: { prompts: [] } });
    default:
      return send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      log('parse_error', { line, error: String(error) });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
