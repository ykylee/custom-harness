// 데몬 소유 MCP stdio 서버 (WBS 7.2.3, FR-9.2)
//
// omp·grok 에게 역방향 툴을 노출하는 경로다. 하네스가 이 프로세스를 spawn 하고, 이 프로세스가
// 데몬 WS 로 되붙어 툴을 처리한다 (pi 는 MCP 를 설계상 배제하므로 확장으로 따로 간다 — 7.2.1).
//
// MCP stdio 전송 = **줄 단위 JSON-RPC 2.0**. 프레이밍이 줄바꿈이므로 페이로드에 raw 개행이
// 들어가면 안 된다 — `JSON.stringify` 가 이스케이프하므로 별도 처리는 없다.
//
// 이 파일은 전송과 디스패치만 안다. 툴이 무엇을 하는지는 `ToolInvoker`(tools.ts)가 소유한다 —
// 그래야 서버를 프로세스 없이 테스트할 수 있다.
import type { ToolDescriptor } from '@custom-harness/protocol';

/** MCP `tools/call` 결과 — 텍스트 콘텐츠 1개로 통일한다 (7.2.3 결정, 설계서 §7 해소) */
export interface ToolCallResult {
  content: { type: 'text'; text: string }[];
  isError: boolean;
}

export interface ToolInvoker {
  list(): ToolDescriptor[];
  call(name: string, args: unknown): Promise<ToolCallResult>;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * 클라이언트가 요청한 프로토콜 버전을 그대로 되돌린다.
 *
 * 7.2.1 실측에서 omp·grok 이 서로 다른 버전을 보냈다(grok doctor 는 `2025-11-25`). 우리가 특정
 * 버전을 고집하면 협상 실패로 서버가 통째로 안 뜬다 — 우리는 `tools/*` 만 쓰고 버전에 따라
 * 달라지는 기능을 쓰지 않으므로, 상대 버전을 수용하는 쪽이 안전하다.
 */
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';

export interface McpStdioServerOptions {
  invoker: ToolInvoker;
  /** 한 줄(개행 없이)을 내보낸다 — 호출자가 개행을 붙인다 */
  send: (message: Record<string, unknown>) => void;
  serverName?: string;
  serverVersion?: string;
  /** 진단 기록 — stdout 은 프로토콜 전용이라 로그를 섞을 수 없다 */
  log?: (kind: string, payload: unknown) => void;
}

export class McpStdioServer {
  private readonly options: McpStdioServerOptions;

  constructor(options: McpStdioServerOptions) {
    this.options = options;
  }

  /** 한 줄을 처리한다. 파싱 불가는 조용히 버린다 — 줄 하나로 서버를 죽이지 않는다 */
  async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      this.options.log?.('parse_error', { line: trimmed.slice(0, 200) });
      return;
    }
    await this.handle(message);
  }

  private async handle(message: JsonRpcMessage): Promise<void> {
    this.options.log?.('in', message);
    const { id, method } = message;
    // 알림(id 없음)에는 응답하지 않는다 — JSON-RPC 규칙이고, 응답하면 클라이언트가 혼란한다
    if (id === undefined || id === null) return;

    switch (method) {
      case 'initialize':
        return this.reply(id, {
          protocolVersion:
            typeof message.params?.protocolVersion === 'string'
              ? message.params.protocolVersion
              : FALLBACK_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: this.options.serverName ?? 'custom-harness',
            version: this.options.serverVersion ?? '0.0.0',
          },
        });
      case 'ping':
        return this.reply(id, {});
      case 'tools/list':
        return this.reply(id, { tools: this.options.invoker.list() });
      case 'tools/call': {
        const name = message.params?.name;
        if (typeof name !== 'string') {
          return this.fail(id, -32602, 'tools/call 에 name 이 없다');
        }
        // 툴 실행 실패는 **프로토콜 오류가 아니라 결과**다 — 모델이 읽고 대응해야 하기 때문이다.
        // 프로토콜 오류로 올리면 하네스가 대화 밖에서 삼켜 모델은 아무 일도 없던 것처럼 군다.
        const result = await this.options.invoker.call(name, message.params?.arguments ?? {});
        this.options.log?.('tool_called', { name, isError: result.isError });
        return this.reply(id, result as unknown as Record<string, unknown>);
      }
      // 우리는 툴만 제공한다. 빈 목록을 주는 편이 method-not-found 보다 조용하다.
      case 'resources/list':
        return this.reply(id, { resources: [] });
      case 'prompts/list':
        return this.reply(id, { prompts: [] });
      default:
        return this.fail(id, -32601, `method not found: ${String(method)}`);
    }
  }

  private reply(id: string | number, result: Record<string, unknown>): void {
    this.emit({ jsonrpc: '2.0', id, result });
  }

  private fail(id: string | number, code: number, message: string): void {
    this.emit({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private emit(message: Record<string, unknown>): void {
    this.options.log?.('out', message);
    this.options.send(message);
  }
}

/**
 * 줄 단위 리더 — 청크 경계가 줄 경계와 무관하므로 버퍼가 필요하다.
 * 반환된 함수에 청크를 먹이면 완성된 줄마다 `onLine` 이 불린다.
 */
export function createLineReader(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk: string): void => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      onLine(line);
    }
  };
}
