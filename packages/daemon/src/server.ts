// WS 서버 (protocol-design §1·§4, NFR-3)
// 127.0.0.1 바인드 고정, 토큰 인증 2중화(Bearer 헤더 + Sec-WebSocket-Protocol), hello 선행.
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  type CapabilityFlags,
  type ClientMessage,
  type ServerMessage,
} from '@custom-harness/protocol';
import { DaemonError, toRpcError } from './errors.js';
import type { KeyStore } from './gateway/key-store.js';
import type { GatewayService } from './gateway/service.js';
import type { SessionManager } from './session-manager.js';
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
  onShutdownRequest?: () => void;
}

const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_PROTOCOL_ERROR = 4400;

export class DaemonServer {
  private wss: WebSocketServer | undefined;
  private unsubscribe: (() => void) | undefined;
  private unsubscribeRegistry: (() => void) | undefined;
  private readonly helloDone = new WeakSet<WebSocket>();

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
      ws.on('message', (data) => {
        void this.onFrame(ws, String(data));
      });
    });

    // 매니저 이벤트 → hello 완료 연결 전체에 브로드캐스트
    const broadcast = (event: ServerMessage): void => {
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN && this.helloDone.has(client)) {
          this.send(client, event);
        }
      }
    };
    this.unsubscribe = this.options.manager.onEvent(broadcast);
    // 레지스트리 변경도 같은 경로로 — 클라이언트는 신호를 받고 목록을 다시 읽는다
    this.unsubscribeRegistry = this.options.provisioning?.onChange(broadcast);

    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
    return { port: (wss.address() as AddressInfo).port };
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribeRegistry?.();
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
        features: this.options.features ?? {},
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
      const result = await this.handle(message);
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

  private async handle(
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
      case 'session.timeline.request':
        return {
          events: await manager.timeline(message.params.sessionId, message.params.fromSeq),
        };
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
