// pi 역방향 툴 확장 (M7 WBS 7.2.3b, FR-9.2)
//
// pi 는 MCP 를 **설계상 배제**한다(7.2.1 실측: 관례 경로 4곳에 서버를 깔아도 프로세스가 뜨지
// 않는다). 대신 `pi.registerTool` 이 1급 API 라, 같은 카탈로그를 이 확장으로 다시 노출한다.
//
// **이 파일은 카탈로그를 알지 못한다.** 데몬의 MCP 서버를 자식으로 띄우고 `tools/list` 로 받은
// 것을 그대로 pi 에 옮긴다 — 그래야 pi 가 보는 툴 표면이 omp·grok 과 **구조적으로 같다**.
// 여기에 카탈로그를 다시 적으면 정의가 둘이 되고, 승인 게이트·파라미터 검증·결과 추림이
// 갈라진다(7.2.2 가 정의를 프로토콜 층에 둔 이유가 그것이다).
//
// 이 파일은 pi 가 컴파일한다 — 우리 tsc 대상이 아니고(`include: ["src"]`), 의존은 node 내장만
// 쓴다(pi 확장의 import 표면이 좁다).
//
// 환경변수 계약 (데몬이 pi spawn 시 넣는다):
//   CUSTOM_HARNESS_MCP_COMMAND  MCP 서버 실행 파일 (보통 데몬의 process.execPath)
//   CUSTOM_HARNESS_MCP_ARGS     인자 JSON 배열
//   CUSTOM_HARNESS_HOME         데이터 루트 — 서버가 데몬 포트·토큰을 찾는 근거
//   CUSTOM_HARNESS_MCP_LOG      (선택) 진단 JSONL
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync } from 'node:fs';

interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ToolContent {
  type: 'text';
  text: string;
}

interface PiToolResult {
  content: ToolContent[];
  details: Record<string, unknown>;
}

interface PiToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<PiToolResult>;
}

interface PiApi {
  registerTool(spec: PiToolSpec): void;
}

interface JsonRpcReply {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

const logPath = process.env.CUSTOM_HARNESS_MCP_LOG;
function log(kind: string, payload: unknown): void {
  if (logPath === undefined) return;
  try {
    appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), kind, payload })}\n`);
  } catch {
    // 진단 실패가 확장을 죽이지 않는다
  }
}

/** MCP 서버 자식 프로세스 — 줄 단위 JSON-RPC 2.0 */
class McpChild {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, (reply: JsonRpcReply) => void>();
  private buffer = '';
  private nextId = 0;
  private readonly timeoutMs: number;

  constructor(command: string, args: string[], timeoutMs: number) {
    this.timeoutMs = timeoutMs;
    this.child = spawn(command, args, {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    // stderr 은 서버의 기동 실패 사유가 실린다 — 삼키면 원인을 못 찾는다
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => log('server_stderr', chunk.trim()));
    this.child.on('exit', (code) => {
      log('server_exit', { code });
      for (const [, resolve] of this.pending) {
        resolve({ error: { code: -32000, message: `MCP 서버가 종료됐다 (code=${String(code)})` } });
      }
      this.pending.clear();
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) break;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line === '') continue;
      let reply: JsonRpcReply;
      try {
        reply = JSON.parse(line) as JsonRpcReply;
      } catch {
        continue; // 관대 파싱 — 줄 하나로 채널을 버리지 않는다
      }
      if (typeof reply.id !== 'number') continue;
      const waiter = this.pending.get(reply.id);
      if (!waiter) continue;
      this.pending.delete(reply.id);
      waiter(reply);
    }
  }

  request(method: string, params?: Record<string, unknown>): Promise<JsonRpcReply> {
    const id = ++this.nextId;
    return new Promise<JsonRpcReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { code: -32001, message: `${method} 응답 타임아웃` } });
      }, this.timeoutMs);
      this.pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  dispose(): void {
    this.child.kill('SIGTERM');
  }
}

function errorResult(text: string): PiToolResult {
  return { content: [{ type: 'text', text }], details: { isError: true } };
}

export default function activate(pi: PiApi): void {
  const command = process.env.CUSTOM_HARNESS_MCP_COMMAND;
  const rawArgs = process.env.CUSTOM_HARNESS_MCP_ARGS;
  if (command === undefined || rawArgs === undefined) {
    // 데몬이 아닌 경로로 pi 가 떴다(사용자가 직접 실행). 역방향 툴 없이 조용히 지나간다 —
    // 여기서 던지면 pi 자체가 못 뜬다.
    log('skipped', { reason: 'MCP spawn 사양 없음' });
    return;
  }
  let args: string[];
  try {
    args = JSON.parse(rawArgs) as string[];
  } catch {
    log('skipped', { reason: 'CUSTOM_HARNESS_MCP_ARGS 파싱 실패', rawArgs });
    return;
  }

  const server = new McpChild(command, args, 30_000);
  process.on('exit', () => server.dispose());

  // 등록은 비동기다 — pi 는 기동 후 등록도 같은 세션에 반영한다(7.2.1 실측).
  // 그래서 activate 를 붙잡지 않고 백그라운드로 진행한다.
  void (async () => {
    const initialized = await server.request('initialize', { protocolVersion: '2025-06-18' });
    if (initialized.error) {
      log('initialize_failed', initialized.error);
      return;
    }
    const listed = await server.request('tools/list');
    const tools = (listed.result?.tools as ToolDescriptor[] | undefined) ?? [];
    if (tools.length === 0) {
      log('no_tools', listed.error ?? {});
      return;
    }

    for (const tool of tools) {
      pi.registerTool({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        // MCP `tools/list` 의 inputSchema 는 이미 JSON Schema 다 — typebox 로 다시 만들지 않는다
        parameters: tool.inputSchema,
        async execute(_toolCallId, params) {
          const reply = await server.request('tools/call', {
            name: tool.name,
            arguments: (params ?? {}) as Record<string, unknown>,
          });
          if (reply.error) return errorResult(`${tool.name} 실패: ${reply.error.message}`);
          const result = reply.result as
            | { content?: ToolContent[]; isError?: boolean }
            | undefined;
          const content = result?.content ?? [];
          if (content.length === 0) return errorResult(`${tool.name} 이 빈 결과를 돌려줬다`);
          // MCP 의 isError 를 pi 결과에 그대로 옮긴다 — 모델이 실패를 읽고 대응해야 한다
          return { content, details: result?.isError === true ? { isError: true } : {} };
        },
      });
    }
    log('registered', { count: tools.length, names: tools.map((t) => t.name) });
  })();
}
