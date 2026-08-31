// 세션 매니저 (daemon-design §4, FR-1.3~1.6)
// 상태 전이는 매니저 소유 — 어댑터는 신호만. turn_started·user_message 행도 매니저가 발행한다.
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
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
import type { ProbeResult } from '@custom-harness/protocol';
import type { AgentAdapter, AgentSession, Unsubscribe } from './adapters/contract.js';
import { DaemonError } from './errors.js';
import { attentionChanged, computeAttention, type AttentionState } from './attention.js';
import { verifyProbeAgainstManifest, type BundleManifest } from './manifest.js';
import type { SessionMeta, SessionStore } from './store.js';

interface LiveSession {
  meta: SessionMeta;
  /** undefined = 런타임 없음 (closed — 재개 가능) */
  runtime: AgentSession | undefined;
  unsubscribe: Unsubscribe | undefined;
  nextSeq: number;
  activeTurnId: string | undefined;
  pending: Map<string, PermissionRequest>;
  /** 마지막 턴 종료 결과 — 주의 상태 정책 입력 (M7 7.1.1) */
  lastTurnOutcome: 'completed' | 'failed' | 'canceled' | undefined;
  /** 사용자가 확인한 뒤 새 사건이 없는가 — 주의 상태 정책 입력 (M7 7.1.1) */
  attentionAcknowledged: boolean;
  /** 영속화·팬아웃 순서 보장용 직렬 체인 */
  chain: Promise<void>;
  /**
   * meta.json 쓰기 직렬 체인 (WBS 2.3.1) — 같은 세션의 tmp+rename 이 동시 실행되면
   * ENOENT 경합이 난다 (빠른 하네스에서 running 전이와 turn 완료 idle 전이가 겹침)
   */
  metaChain: Promise<void>;
}

export interface SessionManagerOptions {
  store: SessionStore;
  adapters: AgentAdapter[];
  /** 동시 활성 세션 상한 — settings 기본 8 (daemon-design §4) */
  maxSessions?: number;
  /** SessionConfig.env 조립 — 게이트웨이 키·격리 홈·오프라인 프리셋 (GatewayService.buildEnv) */
  buildEnv?: (harness: HarnessId) => Record<string, string> | Promise<Record<string, string>>;
  /** 번들 manifest — probe 버전 대조 (WBS 2.3.3, FR-1.8). 미공급 시 검증 생략 */
  manifest?: BundleManifest;
}

export class SessionManager {
  private readonly store: SessionStore;
  private readonly adapters: Map<HarnessId, AgentAdapter>;
  private maxSessions: number;
  private readonly manifest: BundleManifest | undefined;
  private readonly buildEnv: (
    harness: HarnessId,
  ) => Record<string, string> | Promise<Record<string, string>>;
  private readonly sessions = new Map<string, LiveSession>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();

  constructor(options: SessionManagerOptions) {
    this.store = options.store;
    this.adapters = new Map(options.adapters.map((a) => [a.id, a]));
    this.maxSessions = options.maxSessions ?? 8;
    this.manifest = options.manifest;
    this.buildEnv = options.buildEnv ?? (() => ({}));
  }

  /** 동시 세션 상한 런타임 갱신 (WBS 2.3.1) — 초과 활성 세션은 종료하지 않고 신규만 거부 */
  setMaxSessions(value: number): void {
    this.maxSessions = value;
  }

  getMaxSessions(): number {
    return this.maxSessions;
  }

  /** probe + manifest 버전 대조 (WBS 2.3.3, FR-1.8) — 불일치는 경고만 */
  async probeHarness(harness: HarnessId): Promise<ProbeResult> {
    const adapter = this.getAdapter(harness);
    return verifyProbeAgainstManifest(harness, await adapter.probe(), this.manifest);
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
        lastTurnOutcome: undefined,
        // 재기동 복원 — 영속된 주의 상태를 그대로 되살린다 (FR-9.1 재접속 조회)
        attentionAcknowledged: meta.requiresAttention !== true,
        chain: Promise.resolve(),
        metaChain: Promise.resolve(),
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
    /** 소유 워크스페이스 (WBS 5.4.1) — 런타임은 cwd 로 소유권을 추론하지 않는다 */
    workspaceId?: string | undefined;
    modelId?: string | undefined;
    approvalPolicy?: 'mediate' | 'auto' | undefined;
    mcpServers?: McpServerConfig[] | undefined;
  }): Promise<SessionSummary> {
    const adapter = this.getAdapter(params.harness);
    const activeCount = [...this.sessions.values()].filter((s) => s.runtime).length;
    if (activeCount >= this.maxSessions) {
      throw new DaemonError('session_limit', `동시 세션 상한 초과 (${this.maxSessions})`);
    }
    // cwd 선검증 — 존재하지 않는 디렉토리는 spawn 이 명령 경로를 탓하는 ENOENT 로 오인 보고됨
    if (!isAbsolute(params.cwd)) {
      throw new DaemonError('bad_request', `작업 디렉토리는 절대 경로만 허용: ${params.cwd}`);
    }
    try {
      if (!(await stat(params.cwd)).isDirectory()) {
        throw new DaemonError('bad_request', `작업 디렉토리가 디렉토리가 아님: ${params.cwd}`);
      }
    } catch (error) {
      if (error instanceof DaemonError) throw error;
      throw new DaemonError('bad_request', `작업 디렉토리 없음: ${params.cwd}`);
    }

    const now = new Date().toISOString();
    const meta: SessionMeta = {
      sessionId: randomUUID(),
      harness: params.harness,
      cwd: params.cwd,
      ...(params.workspaceId !== undefined ? { workspaceId: params.workspaceId } : {}),
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
      lastTurnOutcome: undefined,
      attentionAcknowledged: true,
      chain: Promise.resolve(),
      metaChain: Promise.resolve(),
    };
    this.sessions.set(meta.sessionId, live);
    await this.persistMeta(live);
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

  async listSessions(filter: { workspaceId?: string } = {}): Promise<SessionSummary[]> {
    const all = [...this.sessions.values()];
    // 집계는 workspaceId 기준 — cwd 비교로 형제 워크스페이스를 섞지 않는다 (WBS 5.4.3)
    const scoped =
      filter.workspaceId === undefined
        ? all
        : all.filter((live) => live.meta.workspaceId === filter.workspaceId);
    return scoped.map((live) => this.summarize(live));
  }

  /** 백필 전용 (WBS 5.4.2) — cwd → workspaceId 매핑이 존재하는 유일한 지점 */
  async backfillWorkspaceIds(
    resolve: (cwd: string) => Promise<string | undefined>,
  ): Promise<{ mapped: number; skipped: number }> {
    let mapped = 0;
    let skipped = 0;
    for (const live of this.sessions.values()) {
      if (live.meta.workspaceId !== undefined) continue;
      let workspaceId: string | undefined;
      try {
        workspaceId = await resolve(live.meta.cwd);
      } catch {
        workspaceId = undefined;
      }
      if (workspaceId === undefined) {
        skipped += 1; // 사라진 디렉토리 등 — 기동을 막지 않는다
        continue;
      }
      live.meta.workspaceId = workspaceId;
      await this.persistMeta(live); // 세션별 직렬화 경로를 그대로 탄다
      mapped += 1;
    }
    return { mapped, skipped };
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
    // 새 프롬프트 = 사용자가 이 세션에 붙어 있다 (7.1.1)
    live.attentionAcknowledged = true;
    live.lastTurnOutcome = undefined;
    // 매니저 소유 타임라인 행 — user_message + turn_started 는 즉시 발행 (FR-1.4)
    this.emit(live, { type: 'user_message', turnId, text });
    this.emit(live, { type: 'turn_started', turnId });
    // 매우 빠른 하네스는 이 시점에 이미 턴을 끝냈을 수 있다 — running 역전 방지 (WBS 2.3.1)
    if (live.activeTurnId === turnId) {
      await this.transition(live, 'running');
    }
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
        // 세션 누적 토큰 (FR-3.7) — 턴 종료 usage 를 meta 에 합산해 목록 요약에 노출
        if (event.type === 'turn_completed' && event.usage) {
          const totals = live.meta.usageTotals ?? {};
          live.meta.usageTotals = {
            ...totals,
            ...(event.usage.inputTokens !== undefined
              ? { inputTokens: (totals.inputTokens ?? 0) + event.usage.inputTokens }
              : {}),
            ...(event.usage.outputTokens !== undefined
              ? { outputTokens: (totals.outputTokens ?? 0) + event.usage.outputTokens }
              : {}),
            ...(event.usage.totalTokens !== undefined
              ? { totalTokens: (totals.totalTokens ?? 0) + event.usage.totalTokens }
              : {}),
          };
        }
        this.emit(live, event);
        live.activeTurnId = undefined;
        live.lastTurnOutcome =
          event.type === 'turn_completed'
            ? 'completed'
            : event.type === 'turn_failed'
              ? 'failed'
              : 'canceled';
        // 턴이 끝났다 = 사용자가 아직 결과를 못 봤다 (7.1.1)
        live.attentionAcknowledged = false;
        void this.transition(live, 'idle');
        return;
      case 'session_status_changed':
        // 어댑터는 신호만 — 상태 반영 후 단일 이벤트로 통과 (비정상 종료 등)
        live.meta.status = event.status;
        if (event.status === 'error') {
          live.activeTurnId = undefined;
          live.attentionAcknowledged = false;
        }
        void this.persistMeta(live);
        this.emit(live, event);
        this.refreshAttention(live);
        return;
      case 'permission_requested':
        live.pending.set(event.request.requestId, event.request);
        this.emit(live, event);
        this.refreshAttention(live);
        return;
      case 'permission_resolved':
        live.pending.delete(event.requestId);
        this.emit(live, event);
        this.refreshAttention(live);
        return;
      default:
        this.emit(live, event);
    }
  }

  /** seq 부여는 동기, 영속화·팬아웃은 세션 체인으로 직렬화 — 순서 보장 */
  private emit(
    live: LiveSession,
    body:
      | AgentEvent
      | { type: 'user_message'; turnId: string; text: string }
      // 데몬 소유 이벤트 (M7 7.1.2) — 어댑터 유니온에는 없다
      | {
          type: 'attention_changed';
          requiresAttention: boolean;
          attentionReason?: AttentionState['attentionReason'];
          attentionTimestamp?: string;
        },
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
    this.refreshAttention(live);
  }

  // ── 주의 상태 (M7 7.1.1·7.1.2, FR-9.1) ───────────────────────────────────

  /**
   * 정책 모듈을 돌려 상태가 달라졌을 때만 영속화 + 이벤트 발행.
   * 상태를 바꿀 수 있는 지점(턴 종료·상태 전이·승인 요청/해소·확인)이 전부 여기로 모인다.
   */
  private refreshAttention(live: LiveSession): void {
    const previous: AttentionState = {
      requiresAttention: live.meta.requiresAttention === true,
      ...(live.meta.attentionReason !== undefined
        ? { attentionReason: live.meta.attentionReason }
        : {}),
      ...(live.meta.attentionTimestamp !== undefined
        ? { attentionTimestamp: live.meta.attentionTimestamp }
        : {}),
    };
    const next = computeAttention(
      {
        status: live.meta.status,
        pendingPermissions: live.pending.size,
        lastTurnOutcome: live.lastTurnOutcome,
        acknowledged: live.attentionAcknowledged,
      },
      previous,
    );
    if (!attentionChanged(previous, next)) return;
    live.meta.requiresAttention = next.requiresAttention;
    live.meta.attentionReason = next.attentionReason;
    live.meta.attentionTimestamp = next.attentionTimestamp;
    void this.persistMeta(live);
    this.emit(live, {
      type: 'attention_changed',
      requiresAttention: next.requiresAttention,
      ...(next.attentionReason !== undefined ? { attentionReason: next.attentionReason } : {}),
      ...(next.attentionTimestamp !== undefined
        ? { attentionTimestamp: next.attentionTimestamp }
        : {}),
    });
  }

  /**
   * 사용자가 세션을 확인했다 (7.1.2). 멱등. 승인 대기는 지워지지 않는다 —
   * 화면을 본 것이 승인 응답은 아니다(정책 모듈이 그렇게 계산한다).
   */
  acknowledgeAttention(sessionId: string): void {
    const live = this.requireSession(sessionId);
    live.attentionAcknowledged = true;
    live.lastTurnOutcome = undefined;
    this.refreshAttention(live);
  }

  /** 세션별 직렬화 — 스냅샷을 체인에 태워 tmp+rename 경합 없이 호출 순서대로 기록 */
  private persistMeta(live: LiveSession): Promise<void> {
    live.meta.updatedAt = new Date().toISOString();
    const snapshot = { ...live.meta };
    const write = live.metaChain.then(() => this.store.writeMeta(snapshot));
    live.metaChain = write.catch((error: unknown) => {
      console.error(`[daemon] meta 기록 실패 (${live.meta.sessionId}):`, error);
    });
    return write;
  }

  private summarize(live: LiveSession): SessionSummary {
    return {
      sessionId: live.meta.sessionId,
      harness: live.meta.harness,
      cwd: live.meta.cwd,
      ...(live.meta.workspaceId !== undefined ? { workspaceId: live.meta.workspaceId } : {}),
      status: live.meta.status,
      ...(live.meta.modelId !== undefined ? { modelId: live.meta.modelId } : {}),
      seq: live.nextSeq - 1,
      ...(live.pending.size > 0 ? { pendingPermissions: [...live.pending.values()] } : {}),
      ...(live.meta.usageTotals !== undefined ? { usage: live.meta.usageTotals } : {}),
      createdAt: live.meta.createdAt,
      updatedAt: live.meta.updatedAt,
      // 주의 상태는 목록에 항상 실린다 — 재접속 시 클라이언트가 없던 동안의 상태를
      // 그대로 되찾는 경로다 (FR-9.1)
      requiresAttention: live.meta.requiresAttention === true,
      ...(live.meta.attentionReason !== undefined
        ? { attentionReason: live.meta.attentionReason }
        : {}),
      ...(live.meta.attentionTimestamp !== undefined
        ? { attentionTimestamp: live.meta.attentionTimestamp }
        : {}),
    };
  }
}
