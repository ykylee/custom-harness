// 세션 매니저 (daemon-design §4, FR-1.3~1.6)
// 상태 전이는 매니저 소유 — 어댑터는 신호만. turn_started·user_message 행도 매니저가 발행한다.
import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  HarnessId,
  McpServerConfig,
  PermissionOutcome,
  PermissionRequest,
  SessionEvent,
  SessionSummary,
} from '@custom-harness/protocol';
import { hasCapability } from '@custom-harness/protocol';
import type { AgentAdapter, AgentSession, Unsubscribe } from './adapters/contract.js';
import { DaemonError } from './errors.js';
import type { SessionMeta, SessionStore } from './store.js';

interface LiveSession {
  meta: SessionMeta;
  /** undefined = 런타임 없음 (closed — 재개 가능) */
  runtime: AgentSession | undefined;
  unsubscribe: Unsubscribe | undefined;
  nextSeq: number;
  activeTurnId: string | undefined;
  pending: Map<string, PermissionRequest>;
  /** 영속화·팬아웃 순서 보장용 직렬 체인 */
  chain: Promise<void>;
}

export interface SessionManagerOptions {
  store: SessionStore;
  adapters: AgentAdapter[];
  /** 동시 활성 세션 상한 — settings 기본 8 (daemon-design §4) */
  maxSessions?: number;
  /** SessionConfig.env 조립 — 게이트웨이 키·격리 홈·오프라인 프리셋 (GatewayService.buildEnv) */
  buildEnv?: (harness: HarnessId) => Record<string, string> | Promise<Record<string, string>>;
}

export class SessionManager {
  private readonly store: SessionStore;
  private readonly adapters: Map<HarnessId, AgentAdapter>;
  private readonly maxSessions: number;
  private readonly buildEnv: (
    harness: HarnessId,
  ) => Record<string, string> | Promise<Record<string, string>>;
  private readonly sessions = new Map<string, LiveSession>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();

  constructor(options: SessionManagerOptions) {
    this.store = options.store;
    this.adapters = new Map(options.adapters.map((a) => [a.id, a]));
    this.maxSessions = options.maxSessions ?? 8;
    this.buildEnv = options.buildEnv ?? (() => ({}));
  }

  /** 기동 시 저장된 세션 로드 — 런타임이 없으므로 잔존 활성 상태는 closed 로 정정 (FR-1.3.5) */
  async init(): Promise<void> {
    for (const stored of await this.store.listMetas()) {
      const meta = { ...stored };
      if (meta.status === 'initializing' || meta.status === 'idle' || meta.status === 'running') {
        meta.status = 'closed';
        meta.updatedAt = new Date().toISOString();
        await this.store.writeMeta(meta);
      }
      this.sessions.set(meta.sessionId, {
        meta,
        runtime: undefined,
        unsubscribe: undefined,
        nextSeq: (await this.store.lastSeq(meta.sessionId)) + 1,
        activeTurnId: undefined,
        pending: new Map(),
        chain: Promise.resolve(),
      });
    }
  }

  onEvent(listener: (event: SessionEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listAdapters(): AgentAdapter[] {
    return [...this.adapters.values()];
  }

  getAdapter(harness: HarnessId): AgentAdapter {
    const adapter = this.adapters.get(harness);
    if (!adapter) throw new DaemonError('not_found', `등록되지 않은 하네스: ${harness}`);
    return adapter;
  }

  async createSession(params: {
    harness: HarnessId;
    cwd: string;
    modelId?: string | undefined;
    approvalPolicy?: 'mediate' | 'auto' | undefined;
    mcpServers?: McpServerConfig[] | undefined;
  }): Promise<SessionSummary> {
    const adapter = this.getAdapter(params.harness);
    const activeCount = [...this.sessions.values()].filter((s) => s.runtime).length;
    if (activeCount >= this.maxSessions) {
      throw new DaemonError('session_limit', `동시 세션 상한 초과 (${this.maxSessions})`);
    }

    const now = new Date().toISOString();
    const meta: SessionMeta = {
      sessionId: randomUUID(),
      harness: params.harness,
      cwd: params.cwd,
      ...(params.modelId !== undefined ? { modelId: params.modelId } : {}),
      status: 'initializing',
      createdAt: now,
      updatedAt: now,
      approvalPolicy: params.approvalPolicy ?? 'mediate',
    };
    const live: LiveSession = {
      meta,
      runtime: undefined,
      unsubscribe: undefined,
      nextSeq: 0,
      activeTurnId: undefined,
      pending: new Map(),
      chain: Promise.resolve(),
    };
    this.sessions.set(meta.sessionId, live);
    await this.store.writeMeta(meta);
    this.emit(live, { type: 'session_status_changed', status: 'initializing' });

    try {
      const runtime = await adapter.createSession({
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        ...(meta.modelId !== undefined ? { modelId: meta.modelId } : {}),
        env: await this.buildEnv(meta.harness),
        approvalPolicy: meta.approvalPolicy ?? 'mediate',
        // mcpServers 는 세션 생성 시점에만 전달 — 재개 시 재주입은 M2 개정 포인트
        ...(params.mcpServers !== undefined ? { mcpServers: params.mcpServers } : {}),
      });
      this.attachRuntime(live, runtime);
      await this.transition(live, 'idle');
    } catch (error) {
      await this.transition(live, 'error');
      throw error;
    }
    return this.summarize(live);
  }

  async resumeSession(sessionId: string): Promise<SessionSummary> {
    const live = this.requireSession(sessionId);
    if (live.runtime) return this.summarize(live); // 이미 활성 — 멱등 처리
    const handle = live.meta.handle;
    if (!handle)
      throw new DaemonError('bad_request', '영속 핸들이 없어 재개 불가 — 이력 열람만 가능');
    const adapter = this.getAdapter(live.meta.harness);

    await this.transition(live, 'initializing');
    try {
      const runtime = await adapter.resumeSession(handle, {
        sessionId: live.meta.sessionId,
        cwd: live.meta.cwd,
        ...(live.meta.modelId !== undefined ? { modelId: live.meta.modelId } : {}),
        env: await this.buildEnv(live.meta.harness),
        approvalPolicy: live.meta.approvalPolicy ?? 'mediate',
      });
      this.attachRuntime(live, runtime);
      // 미응답 승인 복원 (FR-1.5)
      live.pending = new Map((await runtime.getPendingPermissions()).map((p) => [p.requestId, p]));
      await this.transition(live, 'idle');
    } catch (error) {
      await this.transition(live, 'error');
      throw error;
    }
    return this.summarize(live);
  }

  async listSessions(): Promise<SessionSummary[]> {
    return [...this.sessions.values()].map((live) => this.summarize(live));
  }

  async closeSession(sessionId: string): Promise<void> {
    const live = this.requireSession(sessionId);
    if (live.runtime) {
      live.unsubscribe?.();
      await live.runtime.close();
      live.runtime = undefined;
      live.unsubscribe = undefined;
      live.activeTurnId = undefined;
      live.pending.clear();
    }
    await this.transition(live, 'closed');
  }

  async prompt(sessionId: string, text: string): Promise<{ turnId: string }> {
    const live = this.requireSession(sessionId);
    if (!live.runtime) throw new DaemonError('bad_request', '런타임 없음 — 먼저 재개(resume) 필요');
    if (live.activeTurnId) {
      // 활성 턴 1개 — 큐잉이 아니라 거부 (daemon-design §4)
      throw new DaemonError('busy', `활성 턴 존재: ${live.activeTurnId}`);
    }
    if (live.meta.status !== 'idle') {
      throw new DaemonError('bad_request', `프롬프트 불가 상태: ${live.meta.status}`);
    }

    const { turnId } = await live.runtime.startTurn(text);
    live.activeTurnId = turnId;
    // 매니저 소유 타임라인 행 — user_message + turn_started (FR-1.4, daemon-design §4)
    this.emit(live, { type: 'user_message', turnId, text });
    this.emit(live, { type: 'turn_started', turnId });
    await this.transition(live, 'running');
    return { turnId };
  }

  /** 멱등 — 활성 턴이 없어도 에러 없이 완료 (FR-1.6) */
  async interrupt(sessionId: string): Promise<void> {
    const live = this.requireSession(sessionId);
    if (!live.runtime || !live.activeTurnId) return;
    await live.runtime.interrupt();
  }

  async respondPermission(
    sessionId: string,
    requestId: string,
    outcome: PermissionOutcome,
  ): Promise<void> {
    const live = this.requireSession(sessionId);
    if (!live.runtime) throw new DaemonError('bad_request', '런타임 없음');
    if (!live.pending.has(requestId)) {
      throw new DaemonError('not_found', `대기 중이 아닌 승인 요청: ${requestId}`);
    }
    await live.runtime.respondToPermission(requestId, outcome);
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    const live = this.requireSession(sessionId);
    if (!live.runtime) throw new DaemonError('bad_request', '런타임 없음');
    const adapter = this.getAdapter(live.meta.harness);
    if (!hasCapability(adapter.capabilities, 'modelSwitch') || !live.runtime.setModel) {
      // 미지원 기능의 silent 실패 금지 (adapter-contract §2)
      throw new DaemonError('unsupported', `${live.meta.harness} 는 모델 전환 미지원`);
    }
    await live.runtime.setModel(modelId);
    live.meta.modelId = modelId;
    await this.persistMeta(live);
  }

  async timeline(sessionId: string, fromSeq?: number): Promise<SessionEvent[]> {
    this.requireSession(sessionId);
    return this.store.readTimeline(sessionId, fromSeq ?? 0);
  }

  /** 데몬 셧다운 — 실행 중 턴 interrupt 후 하네스 정리 (daemon-design §3) */
  async shutdown(): Promise<void> {
    for (const live of this.sessions.values()) {
      if (!live.runtime) continue;
      try {
        if (live.activeTurnId) await live.runtime.interrupt();
      } catch {
        // interrupt 실패해도 정리는 계속
      }
      await this.closeSession(live.meta.sessionId);
    }
  }

  // ── 내부 ─────────────────────────────────────────────────────────────────

  private requireSession(sessionId: string): LiveSession {
    const live = this.sessions.get(sessionId);
    if (!live) throw new DaemonError('not_found', `세션 없음: ${sessionId}`);
    return live;
  }

  private attachRuntime(live: LiveSession, runtime: AgentSession): void {
    live.runtime = runtime;
    live.unsubscribe = runtime.subscribe((event) => this.onAdapterEvent(live, event));
    live.meta.handle = runtime.describeHandle();
  }

  private onAdapterEvent(live: LiveSession, event: AgentEvent): void {
    switch (event.type) {
      case 'turn_started':
        // 매니저 소유 — 어댑터 유래 중복 발행은 드롭 (adapter-contract §1)
        return;
      case 'turn_completed':
      case 'turn_failed':
      case 'turn_canceled':
        this.emit(live, event);
        live.activeTurnId = undefined;
        void this.transition(live, 'idle');
        return;
      case 'session_status_changed':
        // 어댑터는 신호만 — 상태 반영 후 단일 이벤트로 통과 (비정상 종료 등)
        live.meta.status = event.status;
        if (event.status === 'error') live.activeTurnId = undefined;
        void this.persistMeta(live);
        this.emit(live, event);
        return;
      case 'permission_requested':
        live.pending.set(event.request.requestId, event.request);
        this.emit(live, event);
        return;
      case 'permission_resolved':
        live.pending.delete(event.requestId);
        this.emit(live, event);
        return;
      default:
        this.emit(live, event);
    }
  }

  /** seq 부여는 동기, 영속화·팬아웃은 세션 체인으로 직렬화 — 순서 보장 */
  private emit(
    live: LiveSession,
    body: AgentEvent | { type: 'user_message'; turnId: string; text: string },
  ): void {
    const event = {
      ...body,
      sessionId: live.meta.sessionId,
      seq: live.nextSeq,
    } as SessionEvent;
    live.nextSeq += 1;
    live.chain = live.chain
      .then(async () => {
        await this.store.appendEvent(event);
        for (const listener of this.listeners) listener(event);
      })
      .catch((error: unknown) => {
        console.error(`[daemon] 타임라인 기록 실패 (${live.meta.sessionId}):`, error);
      });
  }

  private async transition(live: LiveSession, status: SessionMeta['status']): Promise<void> {
    live.meta.status = status;
    await this.persistMeta(live);
    this.emit(live, { type: 'session_status_changed', status });
  }

  private async persistMeta(live: LiveSession): Promise<void> {
    live.meta.updatedAt = new Date().toISOString();
    await this.store.writeMeta(live.meta);
  }

  private summarize(live: LiveSession): SessionSummary {
    return {
      sessionId: live.meta.sessionId,
      harness: live.meta.harness,
      cwd: live.meta.cwd,
      status: live.meta.status,
      ...(live.meta.modelId !== undefined ? { modelId: live.meta.modelId } : {}),
      seq: live.nextSeq - 1,
      ...(live.pending.size > 0 ? { pendingPermissions: [...live.pending.values()] } : {}),
      createdAt: live.meta.createdAt,
      updatedAt: live.meta.updatedAt,
    };
  }
}
