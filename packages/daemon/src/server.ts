// WS 서버 (protocol-design §1·§4, NFR-3)
// 127.0.0.1 바인드 고정, 토큰 인증 2중화(Bearer 헤더 + Sec-WebSocket-Protocol), hello 선행.
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  RpcRequestSchema,
  TERMINAL_OPCODE,
  TERMINAL_SLOT_MAX,
  decodeTerminalFrame,
  encodeTerminalFrame,
  type CapabilityFlags,
  type ClientMessage,
  type ServerMessage,
} from '@custom-harness/protocol';
import { DaemonError, toRpcError } from './errors.js';
import { approvalSummary, depthFromLabels, invokeReverseTool } from './mcp/gate.js';
import type { AuditLogger } from './mcp/audit.js';
import { REVERSE_MCP_SERVER_NAME, detectServerNamePreemption } from './mcp/registration.js';
import type { ProcessSupervisor } from './processes.js';
import type { KeyStore } from './gateway/key-store.js';
import type { GatewayService } from './gateway/service.js';
import type { SessionManager } from './session-manager.js';
import type { SearchIndex } from './search/index-store.js';
import type { TerminalManager } from './terminals.js';
import { commitDiff, workingDiff, DiffWatcher } from './workspaces/diffs.js';
import { listDirectory, readWorkspaceFile, PathEscapeError } from './workspaces/files.js';
import type { WorkspaceProvisioning } from './workspaces/registry.js';

export interface DaemonServerOptions {
  manager: SessionManager;
  token: string;
  serverVersion: string;
  port?: number;
  /** hello.response.features — 렌더러 기능 게이트 (protocol-design §3) */
  features?: CapabilityFlags;
  /** config.* 도메인 배선 (WBS 1.4.3) — 미공급 시 unimplemented 응답 */
  gateway?: GatewayService;
  keyStore?: KeyStore;
  /** project.* / workspace.* 도메인 배선 (WBS 5.2.3·5.3.5) — 미공급 시 unimplemented 응답 */
  provisioning?: WorkspaceProvisioning;
  /** terminal.* 도메인 배선 (WBS 6.3) — 미공급 시 unimplemented 응답 */
  terminals?: TerminalManager;
  /** session.search 배선 (WBS 7.4.1) — 미공급 시 unimplemented 응답 */
  searchIndex?: SearchIndex;
  /**
   * tool.* 도메인 배선 (WBS 7.2.4) — 미공급 시 unimplemented 응답.
   * 셋이 다 있어야 관문이 성립한다: opt-in(설정)·호출자 판정(PID 원장)·감사(로거).
   */
  reverseTools?: {
    audit: AuditLogger;
    supervisor: ProcessSupervisor;
    isEnabled(): boolean;
    maxSessionDepth(): number;
    maxFanout(): number;
  };
  onShutdownRequest?: () => void;
}

const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_PROTOCOL_ERROR = 4400;

export class DaemonServer {
  private wss: WebSocketServer | undefined;
  private unsubscribe: (() => void) | undefined;
  private unsubscribeRegistry: (() => void) | undefined;
  private unsubscribeTerminals: (() => void) | undefined;
  /** 워크스페이스별 diff 감시자 — 구독자가 0이 되면 멈춘다 (WBS 6.5) */
  private readonly diffWatchers = new Map<string, { watcher: DiffWatcher; subscribers: number }>();
  private broadcast: ((event: ServerMessage) => void) | undefined;
  private readonly helloDone = new WeakSet<WebSocket>();
  /**
   * 연결별 터미널 슬롯 — 바이너리 프레임의 1바이트 핸들이 어느 터미널인지.
   * 연결이 끊기면 통째로 사라진다(재접속은 다시 attach 해서 새 슬롯을 받는다).
   */
  private readonly slots = new WeakMap<
    WebSocket,
    { bySlot: Map<number, string>; bySession: Map<string, { slot: number; detach: () => void }> }
  >();

  constructor(private readonly options: DaemonServerOptions) {}

  async start(): Promise<{ port: number }> {
    const { token } = this.options;
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: this.options.port ?? 0,
      // 브라우저 경로: 커스텀 헤더 불가 → 토큰을 서브프로토콜로 전달 (protocol-design §4)
      handleProtocols: (protocols) => (protocols.has(token) ? token : false),
    });
    this.wss = wss;

    wss.on('connection', (ws, req) => {
      if (!this.isAuthorized(ws, req)) {
        ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          // 터미널 입력 — 스키마 검증 밖의 별도 채널 (protocol-design v1.2 §1)
          this.onBinaryFrame(ws, new Uint8Array(data as Buffer));
          return;
        }
        void this.onFrame(ws, String(data));
      });
      ws.on('close', () => this.releaseSlots(ws));
    });

    // 매니저 이벤트 → hello 완료 연결 전체에 브로드캐스트
    this.broadcast = (event: ServerMessage): void => {
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN && this.helloDone.has(client)) {
          this.send(client, event);
        }
      }
    };
    const broadcast = this.broadcast;
    this.unsubscribe = this.options.manager.onEvent(broadcast);
    // 레지스트리 변경도 같은 경로로 — 클라이언트는 신호를 받고 목록을 다시 읽는다
    this.unsubscribeRegistry = this.options.provisioning?.onChange(broadcast);
    this.unsubscribeTerminals = this.options.terminals?.onChange((reason, terminal) =>
      broadcast({ type: 'terminal_changed', reason, terminal }),
    );

    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
    return { port: (wss.address() as AddressInfo).port };
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribeRegistry?.();
    this.unsubscribeTerminals?.();
    for (const entry of this.diffWatchers.values()) entry.watcher.stop();
    this.diffWatchers.clear();
    const wss = this.wss;
    if (!wss) return;
    for (const client of wss.clients) client.close(1001, 'daemon shutdown');
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    this.wss = undefined;
  }

  private isAuthorized(ws: WebSocket, req: IncomingMessage): boolean {
    if (req.headers.authorization === `Bearer ${this.options.token}`) return true;
    return ws.protocol === this.options.token; // handleProtocols 를 통과한 서브프로토콜 경로
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    ws.send(JSON.stringify(message));
  }

  /** hello 를 마친 연결에만 터미널 채널을 연다 */
  private onBinaryFrame(ws: WebSocket, data: Uint8Array): void {
    if (!this.helloDone.has(ws)) return;
    const frame = decodeTerminalFrame(data);
    // 미지 opcode·길이 부족은 조용히 버린다 (관대 파싱, NFR-5)
    if (!frame || frame.opcode !== TERMINAL_OPCODE.input) return;
    const terminalId = this.slots.get(ws)?.bySlot.get(frame.slot);
    if (terminalId === undefined) return; // 끊어진 슬롯으로 온 입력
    this.options.terminals?.write(terminalId, frame.payload);
  }

  private releaseSlots(ws: WebSocket): void {
    const table = this.slots.get(ws);
    if (!table) return;
    for (const entry of table.bySession.values()) entry.detach();
    this.slots.delete(ws);
  }

  /**
   * 슬롯을 배정하고 출력 구독을 연다. 스크롤백과 구독은 매니저가 한 번에 주므로
   * 그 사이 출력이 새지 않는다 (workbench-tabs §2.5).
   */
  private attachTerminal(
    ws: WebSocket,
    terminals: TerminalManager,
    params: { terminalId: string; cols: number; rows: number },
  ): { slot: number; scrollback: string; truncated: boolean } {
    if (terminals.find(params.terminalId) === undefined) {
      throw new DaemonError('not_found', `터미널 없음: ${params.terminalId}`);
    }
    const table = this.slots.get(ws) ?? { bySlot: new Map(), bySession: new Map() };
    this.slots.set(ws, table);

    // 이미 붙어 있으면 슬롯을 재사용한다 — 중복 구독으로 출력이 두 번 가지 않게
    const existing = table.bySession.get(params.terminalId);
    if (existing) existing.detach();

    const slot = existing?.slot ?? this.nextSlot(table);
    if (slot === undefined) {
      throw new DaemonError(
        'bad_request',
        `이 연결의 터미널 슬롯이 가득 참 (최대 ${TERMINAL_SLOT_MAX + 1}개)`,
      );
    }
    const attached = terminals.attach(params.terminalId, (chunk) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(encodeTerminalFrame({ opcode: TERMINAL_OPCODE.output, slot, payload: chunk }), {
        binary: true,
      });
    });
    if (!attached) throw new DaemonError('not_found', `터미널 없음: ${params.terminalId}`);

    table.bySlot.set(slot, params.terminalId);
    table.bySession.set(params.terminalId, { slot, detach: attached.detach });
    terminals.resize(params.terminalId, params.cols, params.rows);

    return {
      slot,
      scrollback: Buffer.from(attached.scrollback).toString('base64'),
      truncated: attached.truncated,
    };
  }

  private detachTerminal(ws: WebSocket, terminalId: string): void {
    const table = this.slots.get(ws);
    const entry = table?.bySession.get(terminalId);
    if (!table || !entry) return;
    entry.detach();
    table.bySlot.delete(entry.slot);
    table.bySession.delete(terminalId);
  }

  private nextSlot(table: { bySlot: Map<number, string> }): number | undefined {
    for (let slot = 0; slot <= TERMINAL_SLOT_MAX; slot += 1) {
      if (!table.bySlot.has(slot)) return slot;
    }
    return undefined;
  }

  private async requireWorkspace(workspaceId: string): Promise<{ id: string; cwd: string }> {
    const { provisioning } = this.requireProvisioning();
    const workspace = await provisioning.workspaces.find(workspaceId);
    if (!workspace) throw new DaemonError('not_found', `워크스페이스 없음: ${workspaceId}`);
    return workspace;
  }

  /** 경계 위반은 bad_request 로 — 클라이언트 버그이지 서버 오류가 아니다 */
  private async mapPathError<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      if (error instanceof PathEscapeError) throw new DaemonError('bad_request', error.message);
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new DaemonError('not_found', error.message);
      }
      throw error;
    }
  }

  /** 같은 워크스페이스 구독이 여럿이면 감시자는 하나만 돈다 */
  private async subscribeDiff(workspaceId: string, cwd: string): Promise<void> {
    const existing = this.diffWatchers.get(workspaceId);
    if (existing) {
      existing.subscribers += 1;
      return;
    }
    const watcher = new DiffWatcher(cwd, () =>
      this.broadcast?.({ type: 'diff_changed', workspaceId }),
    );
    this.diffWatchers.set(workspaceId, { watcher, subscribers: 1 });
    await watcher.start();
  }

  private unsubscribeDiff(workspaceId: string): void {
    const entry = this.diffWatchers.get(workspaceId);
    if (!entry) return;
    entry.subscribers -= 1;
    if (entry.subscribers > 0) return;
    entry.watcher.stop();
    this.diffWatchers.delete(workspaceId);
  }

  private requireTerminals(): TerminalManager {
    const { terminals } = this.options;
    if (!terminals) throw new DaemonError('unimplemented', 'terminal 도메인이 배선되지 않음');
    return terminals;
  }

  private async onFrame(ws: WebSocket, raw: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      ws.close(CLOSE_PROTOCOL_ERROR, 'invalid json');
      return;
    }
    const parsed = ClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.rejectUnparsable(ws, json);
      return;
    }
    const message = parsed.data;

    // hello 선행 규약 — 봉투 2계층의 연결 레벨 (protocol-design §1)
    if (!this.helloDone.has(ws)) {
      if (message.type !== 'hello') {
        ws.close(CLOSE_PROTOCOL_ERROR, 'hello first');
        return;
      }
      this.helloDone.add(ws);
      this.send(ws, {
        type: 'hello.response',
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: 'custom-harness-daemon', version: this.options.serverVersion },
        features: {
          // 터미널 바이너리 프레임은 배선됐을 때만 광고한다 — 플래그가 없으면 클라이언트는
          // 기능을 숨긴다(폴백 경로 금지, protocol-design §3)
          ...(this.options.terminals !== undefined ? { terminalBinaryFrames: true } : {}),
          ...(this.options.provisioning !== undefined ? { workspaces: true } : {}),
          ...this.options.features,
        },
      });
      return;
    }

    if (message.type === 'hello') {
      ws.close(CLOSE_PROTOCOL_ERROR, 'duplicate hello');
      return;
    }
    if (message.type === 'ping') {
      this.send(ws, { type: 'pong' });
      return;
    }
    if (message.type === 'pong') return;

    await this.dispatchRpc(ws, message);
  }

  /** 스키마 불일치 프레임 — requestId 를 건질 수 있으면 bad_request 응답, 아니면 드롭 */
  private rejectUnparsable(ws: WebSocket, json: unknown): void {
    if (typeof json === 'object' && json !== null) {
      const { type, requestId } = json as { type?: unknown; requestId?: unknown };
      if (typeof type === 'string' && type.endsWith('.request') && typeof requestId === 'string') {
        ws.send(
          JSON.stringify({
            type: type.replace(/\.request$/, '.response'),
            requestId,
            ok: false,
            error: { code: 'bad_request', message: '스키마 불일치 요청' },
          }),
        );
      }
    }
  }

  private async dispatchRpc(
    ws: WebSocket,
    message: Exclude<ClientMessage, { type: 'hello' | 'ping' | 'pong' }>,
  ): Promise<void> {
    const responseType = message.type.replace(/\.request$/, '.response');
    try {
      const result = await this.handle(ws, message);
      ws.send(
        JSON.stringify({ type: responseType, requestId: message.requestId, ok: true, result }),
      );
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: responseType,
          requestId: message.requestId,
          ok: false,
          error: toRpcError(error),
        }),
      );
    }
  }

  /**
   * 데몬 자신의 RPC 를 내부에서 한 번 부른다 (WBS 7.2.4).
   *
   * 역방향 툴 바인딩이 쓰는 경로다. 매니저를 직접 부르지 않고 RPC 를 다시 타는 이유:
   * 워크스페이스 존재 확인·경로 이탈 가드·터미널 소유 확인 같은 방어가 핸들러 안에 있고,
   * 우회하면 역방향 툴만 그 방어를 통과하지 않는 표면이 된다.
   *
   * 요청은 실제 수신 프레임과 같은 스키마로 검증한다 — 형이 아니라 값으로 확인해야
   * 바인딩이 잘못된 파라미터를 만들었을 때 여기서 걸린다.
   */
  private async callSelf(
    ws: WebSocket,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const parsed = RpcRequestSchema.safeParse({
      type: `${method}.request`,
      requestId: `self-${++this.selfRequestSeq}`,
      params,
    });
    if (!parsed.success) {
      throw new DaemonError('bad_request', `내부 호출 스키마 불일치: ${method}`);
    }
    return ((await this.handle(ws, parsed.data)) ?? {}) as Record<string, unknown>;
  }

  private selfRequestSeq = 0;

  private async handle(
    ws: WebSocket,
    message: Exclude<ClientMessage, { type: 'hello' | 'ping' | 'pong' }>,
  ): Promise<unknown> {
    const { manager } = this.options;
    switch (message.type) {
      case 'session.create.request': {
        // 소유권은 workspaceId 로만 판정한다 (WBS 5.4.1). cwd 만 온 요청은 그 경로로
        // 프로젝트를 열어 기본 워크스페이스에 귀속시킨다 — 추론이 아니라 "프로젝트 열기"라는
        // 명시적 행위이며, 스크립트·CLI 용 편의 경로로 유지한다(FR-9.6).
        const { provisioning } = this.options;
        let workspaceId = message.params.workspaceId;
        let cwd = message.params.cwd;
        if (workspaceId !== undefined) {
          const workspace = await provisioning?.workspaces.find(workspaceId);
          if (!workspace) throw new DaemonError('not_found', `워크스페이스 없음: ${workspaceId}`);
          if (workspace.archivedAt !== undefined) {
            throw new DaemonError('bad_request', '아카이브된 워크스페이스에는 세션을 만들 수 없음');
          }
          cwd = workspace.cwd;
        } else if (provisioning) {
          workspaceId = (await provisioning.openProject(cwd)).workspace.id;
        }
        // 서버명 선점 탐지 (WBS 7.2.4) — 저장소의 프로젝트 스코프 `.mcp.json` 이 우리 서버
        // 이름을 차지하면 모델이 부르는 역방향 툴이 그쪽으로 간다. 세션 생성을 막지는
        // 않는다(저장소가 자기 MCP 서버를 두는 것은 정상이다) — 알리는 것이 조치다.
        if (this.options.reverseTools?.isEnabled() === true) {
          const preemption = await detectServerNamePreemption(cwd);
          if (preemption.preempted) {
            console.warn(
              `[daemon] 역방향 툴 서버명 선점 감지: ${preemption.configPath} 가 '${REVERSE_MCP_SERVER_NAME}' 를 정의한다 — ` +
                '이 세션의 역방향 툴 호출은 우리 서버가 아니라 저장소가 정의한 서버로 갈 수 있다',
            );
          }
        }
        return {
          session: await manager.createSession({
            ...message.params,
            cwd,
            ...(workspaceId !== undefined ? { workspaceId } : {}),
          }),
        };
      }
      case 'session.resume.request':
        return { session: await manager.resumeSession(message.params.sessionId) };
      case 'session.list.request':
        return {
          sessions: await manager.listSessions(
            message.params.workspaceId === undefined
              ? {}
              : { workspaceId: message.params.workspaceId },
          ),
        };
      case 'session.close.request':
        await manager.closeSession(message.params.sessionId);
        return {};
      case 'session.prompt.request':
        return await manager.prompt(message.params.sessionId, message.params.prompt);
      case 'session.wait.request':
        return await manager.waitForTurn(
          message.params.sessionId,
          message.params.timeoutMs === undefined ? {} : { timeoutMs: message.params.timeoutMs },
        );
      case 'session.interrupt.request':
        await manager.interrupt(message.params.sessionId);
        return {};
      case 'session.permission.respond.request':
        await manager.respondPermission(
          message.params.sessionId,
          message.params.requestId,
          message.params.outcome,
        );
        return {};
      case 'session.model.set.request':
        await manager.setModel(message.params.sessionId, message.params.modelId);
        return {};
      case 'session.attention.ack.request':
        // 멱등 (M7 7.1.2) — 승인 대기는 이 호출로 사라지지 않는다
        manager.acknowledgeAttention(message.params.sessionId);
        return {};
      case 'session.usage.request':
        return await manager.usageTree(message.params.sessionId);
      case 'session.result.request':
        return await manager.lastTurnResult(message.params.sessionId);
      case 'session.timeline.request':
        return {
          events: await manager.timeline(message.params.sessionId, message.params.fromSeq),
        };
      case 'session.search.request': {
        const { searchIndex } = this.options;
        if (!searchIndex) throw new DaemonError('unimplemented', '검색 색인이 배선되지 않음');
        return { hits: searchIndex.search(message.params) };
      }
      case 'harness.list.request': {
        // 모델 카탈로그(FR-2.4)·경계 경고(FR-2.5)는 gateway 배선 시에만 — 미배선이면 기본 목록
        const { gateway } = this.options;
        const models = gateway ? await gateway.listModels() : undefined;
        const violations = gateway ? await gateway.checkTrafficBoundaries() : [];
        return {
          harnesses: manager.listAdapters().map((adapter) => {
            const warnings = violations
              .filter((v) => v.harness === adapter.id)
              .map((v) => `게이트웨이 외 목적지: ${v.url} (${v.location})`);
            return {
              id: adapter.id,
              capabilities: adapter.capabilities,
              ...(models !== undefined ? { models } : {}),
              ...(warnings.length > 0 ? { warnings } : {}),
            };
          }),
        };
      }
      case 'harness.probe.request':
        return { probe: await manager.probeHarness(message.params.harness) };
      case 'terminal.create.request': {
        const terminals = this.requireTerminals();
        const { provisioning } = this.options;
        const workspace = await provisioning?.workspaces.find(message.params.workspaceId);
        if (!workspace) {
          throw new DaemonError('not_found', `워크스페이스 없음: ${message.params.workspaceId}`);
        }
        return {
          terminal: terminals.create({
            workspaceId: workspace.id,
            cwd: workspace.cwd,
            cols: message.params.cols,
            rows: message.params.rows,
            ...(message.params.shell !== undefined ? { shell: message.params.shell } : {}),
          }),
        };
      }
      case 'terminal.list.request': {
        const terminals = this.requireTerminals();
        return { terminals: terminals.list(message.params.workspaceId) };
      }
      case 'terminal.attach.request': {
        const terminals = this.requireTerminals();
        return this.attachTerminal(ws, terminals, message.params);
      }
      case 'terminal.detach.request': {
        this.requireTerminals();
        this.detachTerminal(ws, message.params.terminalId);
        return {};
      }
      case 'terminal.resize.request': {
        const terminals = this.requireTerminals();
        terminals.resize(message.params.terminalId, message.params.cols, message.params.rows);
        return {};
      }
      case 'terminal.read.request': {
        const terminals = this.requireTerminals();
        const result = terminals.read(message.params.terminalId, message.params.bytes);
        if (!result) {
          throw new DaemonError('not_found', `터미널 없음: ${message.params.terminalId}`);
        }
        return {
          scrollback: Buffer.from(result.scrollback).toString('base64'),
          truncated: result.truncated,
        };
      }
      case 'terminal.write.request': {
        const terminals = this.requireTerminals();
        // 존재 확인이 필요하다 — TerminalManager.write 는 없는 id 에 조용히 no-op 이라
        // 그대로 두면 역방향 툴이 "보냈다"는 성공 응답을 받는다
        if (!terminals.list().some((term) => term.id === message.params.terminalId)) {
          throw new DaemonError('not_found', `터미널 없음: ${message.params.terminalId}`);
        }
        terminals.write(message.params.terminalId, Buffer.from(message.params.data, 'utf8'));
        return {};
      }
      case 'terminal.kill.request': {
        const terminals = this.requireTerminals();
        terminals.kill(message.params.terminalId);
        return {};
      }
      // 역방향 툴 (WBS 7.2.4) — opt-in·호출자 판정·승인·재귀 상한·감사를 게이트가 통과시킨다
      case 'tool.invoke.request': {
        const reverse = this.options.reverseTools;
        if (!reverse) throw new DaemonError('unimplemented', '역방향 툴이 배선되지 않음');
        return await invokeReverseTool(
          {
            // 툴 바인딩은 데몬 자신의 RPC 를 다시 탄다 — 워크스페이스 검증·경로 가드 같은
            // 기존 핸들러의 방어를 우회하지 않기 위해서다
            rpc: { call: (method, params) => this.callSelf(ws, method, params) },
            audit: reverse.audit,
            isEnabled: () => reverse.isEnabled(),
            maxSessionDepth: () => reverse.maxSessionDepth(),
            maxFanout: () => reverse.maxFanout(),
            // 게이트와 `session_usage` 가 **같은 함수**로 센다 — 기준이 갈라지면 모델은
            // 여유가 있다고 보는데 게이트는 막는 상태가 된다
            activeChildCount: async (id) => (await manager.usageTree(id)).activeChildCount,
            resolveCaller: async (callerPid) => {
              if (callerPid === undefined) return { depth: 0 };
              const entry = await reverse.supervisor.findByPid(callerPid);
              if (!entry?.sessionId) return { depth: 0 };
              const sessions = await manager.listSessions();
              const session = sessions.find((s) => s.sessionId === entry.sessionId);
              return {
                sessionId: entry.sessionId,
                ...(entry.harness !== undefined ? { harness: entry.harness } : {}),
                depth: depthFromLabels(session?.labels),
              };
            },
            requestApproval: ({ sessionId, spec, args }) =>
              manager.requestReverseToolApproval({
                sessionId,
                summary: approvalSummary(spec, args),
                detail: { tool: spec.name, args },
              }),
          },
          {
            name: message.params.name,
            args: message.params.args ?? {},
            ...(message.params.callerPid !== undefined
              ? { callerPid: message.params.callerPid }
              : {}),
          },
        );
      }
      case 'file.list.request': {
        const workspace = await this.requireWorkspace(message.params.workspaceId);
        return this.mapPathError(() => listDirectory(workspace.cwd, message.params.path));
      }
      case 'file.read.request': {
        const workspace = await this.requireWorkspace(message.params.workspaceId);
        return this.mapPathError(() => readWorkspaceFile(workspace.cwd, message.params.path));
      }
      case 'diff.get.request': {
        const workspace = await this.requireWorkspace(message.params.workspaceId);
        if (message.params.scope === 'commit') {
          const sha = message.params.sha;
          if (sha === undefined)
            throw new DaemonError('bad_request', 'commit scope 는 sha 가 필요');
          return commitDiff(workspace.cwd, sha);
        }
        return workingDiff(workspace.cwd);
      }
      case 'diff.subscribe.request': {
        const workspace = await this.requireWorkspace(message.params.workspaceId);
        await this.subscribeDiff(workspace.id, workspace.cwd);
        return {};
      }
      case 'diff.unsubscribe.request': {
        this.unsubscribeDiff(message.params.workspaceId);
        return {};
      }
      case 'system.version.request':
        return { version: this.options.serverVersion, protocolVersion: PROTOCOL_VERSION };
      case 'system.shutdown.request':
        queueMicrotask(() => this.options.onShutdownRequest?.());
        return {};
      case 'project.open.request': {
        const { provisioning } = this.requireProvisioning();
        return await provisioning.openProject(message.params.root);
      }
      case 'project.list.request': {
        const { provisioning } = this.requireProvisioning();
        return {
          projects: await provisioning.projects.list(
            message.params.includeArchived === undefined
              ? {}
              : { includeArchived: message.params.includeArchived },
          ),
        };
      }
      case 'project.update.request': {
        const { provisioning } = this.requireProvisioning();
        return {
          project: await this.mapNotFound(() =>
            provisioning.projects.rename(message.params.projectId, message.params.displayName),
          ),
        };
      }
      case 'project.archive.request': {
        const { provisioning } = this.requireProvisioning();
        await this.mapNotFound(() => provisioning.projects.archive(message.params.projectId));
        return {};
      }
      case 'workspace.create.request': {
        const { provisioning } = this.requireProvisioning();
        if (message.params.isolation === 'worktree') {
          return {
            workspace: await this.mapNotFound(() =>
              provisioning.createWorktreeWorkspace({
                projectId: message.params.projectId,
                ...(message.params.baseBranch !== undefined
                  ? { baseBranch: message.params.baseBranch }
                  : {}),
                ...(message.params.branch !== undefined ? { branch: message.params.branch } : {}),
                ...(message.params.displayName !== undefined
                  ? { displayName: message.params.displayName }
                  : {}),
              }),
            ),
          };
        }
        const cwd = message.params.cwd;
        if (cwd === undefined) {
          throw new DaemonError('bad_request', 'directory 격리는 cwd 가 필요');
        }
        return {
          workspace: await this.mapNotFound(() =>
            provisioning.addDirectoryWorkspace({
              projectId: message.params.projectId,
              cwd,
              ...(message.params.displayName !== undefined
                ? { displayName: message.params.displayName }
                : {}),
            }),
          ),
        };
      }
      case 'workspace.list.request': {
        const { provisioning } = this.requireProvisioning();
        return {
          workspaces: await provisioning.workspaces.list({
            ...(message.params.projectId !== undefined
              ? { projectId: message.params.projectId }
              : {}),
            ...(message.params.includeArchived !== undefined
              ? { includeArchived: message.params.includeArchived }
              : {}),
          }),
        };
      }
      case 'workspace.update.request': {
        const { provisioning } = this.requireProvisioning();
        if (message.params.displayName === undefined && message.params.labels === undefined) {
          throw new DaemonError('bad_request', '적용할 변경 없음 (displayName 또는 labels)');
        }
        const { workspaceId, displayName, labels } = message.params;
        return {
          workspace: await this.mapNotFound(async () => {
            // 라벨이 함께 오면 카탈로그를 먼저 갱신한다 (WBS 5.3.4)
            if (labels !== undefined) await provisioning.labels.remember(labels);
            return provisioning.workspaces.update(workspaceId, {
              ...(displayName !== undefined ? { displayName } : {}),
              ...(labels !== undefined ? { labels } : {}),
            });
          }),
        };
      }
      case 'workspace.archive.request': {
        const { provisioning } = this.requireProvisioning();
        return {
          workspace: await this.mapNotFound(() =>
            provisioning.archiveWorkspace(message.params.workspaceId, {
              removeCheckout: message.params.removeCheckout === true,
            }),
          ),
        };
      }
      case 'workspace.labels.list.request': {
        const { provisioning } = this.requireProvisioning();
        return { labels: await provisioning.labels.list() };
      }
      case 'workspace.scripts.list.request': {
        const { provisioning } = this.requireProvisioning();
        return this.mapNotFound(() =>
          provisioning.listWorkspaceScripts(message.params.workspaceId),
        );
      }
      case 'workspace.scripts.run.request': {
        const { provisioning } = this.requireProvisioning();
        const terminals = this.requireTerminals();
        const resolved = await this.mapNotFound(() =>
          provisioning.resolveWorkspaceScript(message.params.workspaceId, message.params.name),
        );
        // 감독 터미널 — 출력은 일반 터미널과 같은 경로로 흐른다
        return {
          terminal: terminals.create({
            workspaceId: message.params.workspaceId,
            cwd: resolved.cwd,
            cols: message.params.cols,
            rows: message.params.rows,
            env: resolved.env,
            command: resolved.command,
            label: message.params.name,
          }),
        };
      }
      case 'workspace.setup.run.request': {
        const { provisioning } = this.requireProvisioning();
        return await this.mapNotFound(() =>
          provisioning.runWorkspaceSetup(message.params.workspaceId, {
            ...(message.params.trust !== undefined ? { trust: message.params.trust } : {}),
          }),
        );
      }
      case 'config.key.set.request': {
        const { keyStore, gateway } = this.requireConfigServices();
        await keyStore.set(message.params.apiKey);
        // 키 저장 직후 주입 상태 동기화 — env 보간 방식이라 파일 재작성은 최초 1회뿐
        await gateway.ensurePiInjection();
        return {};
      }
      case 'config.key.test.request': {
        const { gateway } = this.requireConfigServices();
        return await gateway.testKey();
      }
      case 'config.get.request': {
        const { gateway, keyStore } = this.requireConfigServices();
        return {
          values: {
            gateway: (await gateway.getConfig()) ?? null,
            keyState: await keyStore.state(), // 키 값 자체는 절대 반환하지 않는다
            maxSessions: await gateway.getMaxSessions(),
          },
        };
      }
      case 'config.set.request': {
        const { gateway } = this.requireConfigServices();
        const values: Record<string, unknown> = {};
        const partial = message.params.values.gateway;
        if (partial !== undefined) {
          if (typeof partial !== 'object' || partial === null) {
            throw new DaemonError('bad_request', 'values.gateway 객체가 필요');
          }
          values.gateway = await gateway.setConfig(partial);
        }
        const maxSessions = message.params.values.maxSessions;
        if (maxSessions !== undefined) {
          if (typeof maxSessions !== 'number') {
            throw new DaemonError('bad_request', 'values.maxSessions 숫자가 필요');
          }
          try {
            await gateway.setMaxSessions(maxSessions);
          } catch (error) {
            throw new DaemonError(
              'bad_request',
              error instanceof Error ? error.message : String(error),
            );
          }
          manager.setMaxSessions(maxSessions); // 즉시 반영 (WBS 2.3.1)
          values.maxSessions = maxSessions;
        }
        if (Object.keys(values).length === 0) {
          throw new DaemonError('bad_request', '적용할 설정 없음 (gateway 또는 maxSessions)');
        }
        return { values };
      }
    }
  }

  private requireProvisioning(): { provisioning: WorkspaceProvisioning } {
    const { provisioning } = this.options;
    if (!provisioning) {
      throw new DaemonError('unimplemented', 'project/workspace 도메인이 배선되지 않음');
    }
    return { provisioning };
  }

  /** 레지스트리의 "없음" 오류를 RPC 에러 코드로 옮긴다 — 클라이언트가 분기할 수 있게 */
  private async mapNotFound<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.endsWith('없음') || / 없음: /.test(message)) {
        throw new DaemonError('not_found', message);
      }
      throw error;
    }
  }

  private requireConfigServices(): { gateway: GatewayService; keyStore: KeyStore } {
    const { gateway, keyStore } = this.options;
    if (!gateway || !keyStore) {
      throw new DaemonError('unimplemented', 'config 도메인 서비스가 배선되지 않음');
    }
    return { gateway, keyStore };
  }
}
