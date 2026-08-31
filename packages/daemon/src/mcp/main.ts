// MCP stdio 서버 실행 진입점 (WBS 7.2.3) — **하네스가 spawn 한다**.
//
// 환경변수 계약:
//   CUSTOM_HARNESS_HOME     데이터 루트. 등록 시 항상 명시한다 — 이 프로세스는 홈이 격리된
//                           하네스의 자식이라 homedir() 가 가짜 홈을 가리킨다 (WBS 7.2.0a)
//   CUSTOM_HARNESS_MCP_LOG  진단 JSONL 경로 (선택). stdout 은 프로토콜 전용이라 로그를 못 섞는다
//
// **stdout 오염 금지**: 이 프로세스의 stdout 한 줄 한 줄이 JSON-RPC 프레임이다. console.log 를
// 쓰면 하네스 쪽 파서가 깨진다 — 진단은 전부 로그 파일이나 stderr 로 보낸다.
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { connectDaemonRpc } from './client.js';
import { createLineReader, McpStdioServer } from './server.js';
import { createToolInvoker } from './tools.js';

const logPath = process.env.CUSTOM_HARNESS_MCP_LOG;
function log(kind: string, payload: unknown): void {
  if (logPath === undefined) return;
  try {
    appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), kind, payload })}\n`);
  } catch {
    // 진단 실패가 서버를 죽이지 않는다
  }
}

async function main(): Promise<void> {
  // 등록이 항상 넘기지만, 사람이 손으로 띄우는 경우를 위해 폴백은 둔다
  const root = process.env.CUSTOM_HARNESS_HOME ?? join(homedir(), '.custom-harness');
  const rpc = await connectDaemonRpc({ root });
  log('connected', { root });

  const server = new McpStdioServer({
    invoker: createToolInvoker({ rpc }),
    send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
    serverName: 'custom-harness',
    serverVersion: '1',
    log,
  });

  // 줄 처리는 직렬화한다 — 앞 줄의 RPC 가 끝나기 전에 뒤 줄을 처리하면 응답 순서가 섞인다.
  // JSON-RPC 는 순서를 요구하지 않지만, 툴 호출이 서로의 상태를 보는 경우가 있어 순서를 지킨다.
  let queue: Promise<void> = Promise.resolve();
  const feed = createLineReader((line) => {
    queue = queue
      .then(() => server.handleLine(line))
      .catch((error: unknown) => {
        log('handle_error', { error: String(error) });
      });
  });

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', feed);
  process.stdin.on('end', () => {
    log('stdin_end', {});
    rpc.close();
    process.exit(0);
  });
}

main().catch((error: unknown) => {
  log('fatal', { error: String(error) });
  process.stderr.write(`[custom-harness-mcp] 기동 실패: ${String(error)}\n`);
  process.exit(1);
});
