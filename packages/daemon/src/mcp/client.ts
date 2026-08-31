// MCP 서버 → 데몬 WS 클라이언트 (WBS 7.2.3)
//
// MCP 서버는 하네스가 spawn 하는 **별도 프로세스**라, 데몬 상태에 닿으려면 일반 클라이언트와
// 같은 문으로 들어와야 한다 — 127.0.0.1 WS + Bearer 토큰 (protocol-design §4, NFR-3).
//
// **토큰을 등록 파일에 적지 않는다.** 등록은 하네스 설정 파일(`mcp.json` / `config.toml`)에
// spawn 명령을 남기는 일인데, 거기에 토큰을 박으면 ① 비밀이 설정 파일에 평문으로 남고
// ② 데몬 재기동마다 토큰이 회전하므로(§4) 곧 낡는다. 그래서 이 프로세스가 **데이터 디렉토리에서
// 직접** `daemon.pid`(포트)와 `daemon.token` 을 읽는다.
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@custom-harness/protocol';
import { readDaemonInfo } from '../launcher.js';
import { resolvePaths } from '../paths.js';
import { readTokenFile } from '../token.js';
import type { DaemonRpc } from './tools.js';

export interface DaemonRpcClientOptions {
  /**
   * 데이터 루트. **반드시 명시적으로 넘긴다** — 이 프로세스는 홈이 격리된 하네스의 자식이라
   * `homedir()` 가 가짜 홈(`data/harness-home/<harness>/`)을 가리킨다 (WBS 7.2.0a).
   * 기본값에 의존하면 존재하지 않는 데이터 디렉토리를 보게 된다.
   */
  root: string;
  timeoutMs?: number;
}

export interface DaemonRpcClient extends DaemonRpc {
  close(): void;
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export async function connectDaemonRpc(options: DaemonRpcClientOptions): Promise<DaemonRpcClient> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const paths = resolvePaths(options.root);
  const info = await readDaemonInfo(paths);
  if (!info?.port) {
    throw new Error(`데몬이 실행 중이 아니다 (${paths.pidFile} 에 포트 없음)`);
  }
  const token = await readTokenFile(paths.tokenFile);

  const ws = new WebSocket(`ws://127.0.0.1:${info.port}`, [], {
    headers: { authorization: `Bearer ${token}` },
  });

  const pending = new Map<string, Pending>();
  let closed = false;
  let nextId = 0;

  ws.on('message', (data) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return; // 관대 파싱 — 프레임 하나로 연결을 버리지 않는다 (NFR-5)
    }
    const requestId = frame.requestId;
    if (typeof requestId !== 'string') return;
    const waiter = pending.get(requestId);
    if (!waiter) return;
    pending.delete(requestId);
    clearTimeout(waiter.timer);
    if (frame.ok === true) {
      waiter.resolve((frame.result as Record<string, unknown>) ?? {});
      return;
    }
    const error = frame.error as { code?: unknown; message?: unknown } | undefined;
    waiter.reject(
      new Error(
        `${String(error?.code ?? 'error')}: ${String(error?.message ?? '알 수 없는 오류')}`,
      ),
    );
  });

  const failAll = (reason: string): void => {
    closed = true;
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    pending.clear();
  };
  ws.on('close', () => failAll('데몬 연결이 끊겼다'));
  ws.on('error', (error) => failAll(`데몬 연결 오류: ${error.message}`));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('데몬 접속 타임아웃')), timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const call = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    if (closed) throw new Error('데몬 연결이 닫혀 있다');
    const requestId = `mcp-${++nextId}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`${method} 응답 타임아웃`));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: `${method}.request`, requestId, params }));
    });
  };

  // hello 는 RPC 가 아니라 연결 레벨 봉투다 — 응답을 기다린 뒤에야 RPC 를 보낸다
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hello 응답 타임아웃')), timeoutMs);
    const onMessage = (data: unknown): void => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (frame.type !== 'hello.response') return;
      ws.off('message', onMessage);
      clearTimeout(timer);
      resolve();
    };
    ws.on('message', onMessage);
    ws.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'custom-harness-mcp', version: '1' },
        capabilities: {},
      }),
    );
  });

  return {
    call,
    close(): void {
      closed = true;
      ws.close();
    },
  };
}
