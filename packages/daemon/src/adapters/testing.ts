// 테스트용 fake 어댑터 — 데몬 코어(1.2) 테스트 전용.
// 정식 mock 하네스(계약 테스트 1급, test-strategy §1)는 WBS 1.3.4 에서 이 자리를 대체한다.
import type {
  AgentEvent,
  ModelInfo,
  PermissionOutcome,
  PermissionRequest,
  ProbeResult,
} from '@custom-harness/protocol';
import type {
  AgentAdapter,
  AgentSession,
  PersistenceHandle,
  SessionConfig,
  Unsubscribe,
} from './contract.js';

export class FakeSession implements AgentSession {
  readonly sessionId: string;
  readonly config: SessionConfig;
  readonly resumed: boolean;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private turnCounter = 0;
  lastTurnId: string | undefined;
  interruptCalls = 0;
  closed = false;
  modelSet: string | undefined;
  pendingOnQuery: PermissionRequest[] = [];

  constructor(config: SessionConfig, resumed = false) {
    this.sessionId = config.sessionId;
    this.config = config;
    this.resumed = resumed;
  }

  /** 테스트가 하네스 유래 이벤트를 주입하는 통로 */
  emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async startTurn(_prompt: string): Promise<{ turnId: string }> {
    this.turnCounter += 1;
    this.lastTurnId = `turn-${this.turnCounter}`;
    return { turnId: this.lastTurnId };
  }

  subscribe(listener: (event: AgentEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
    if (this.lastTurnId) this.emit({ type: 'turn_canceled', turnId: this.lastTurnId });
  }

  async respondToPermission(requestId: string, outcome: PermissionOutcome): Promise<void> {
    this.emit({ type: 'permission_resolved', requestId, outcome });
  }

  async getPendingPermissions(): Promise<PermissionRequest[]> {
    return this.pendingOnQuery;
  }

  async setModel(modelId: string): Promise<void> {
    this.modelSet = modelId;
  }

  describeHandle(): PersistenceHandle {
    return { harness: 'mock', nativeHandle: `native-${this.sessionId}` };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakeAdapter implements AgentAdapter {
  readonly id = 'mock' as const;
  readonly capabilities = {
    streaming: true,
    sessionResume: true,
    runtimePermission: true,
    modelSwitch: true,
    usageReporting: true,
  };
  readonly sessions: FakeSession[] = [];
  /** resumeSession 이 돌려줄 미응답 승인 목록 (FR-1.5 복원 테스트용) */
  pendingOnResume: PermissionRequest[] = [];
  failNextCreate = false;

  async probe(): Promise<ProbeResult> {
    return { available: true, version: '0.0.1', verified: true, warnings: [] };
  }

  async createSession(config: SessionConfig): Promise<FakeSession> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error('fake create failure');
    }
    const session = new FakeSession(config);
    this.sessions.push(session);
    return session;
  }

  async resumeSession(_handle: PersistenceHandle, config: SessionConfig): Promise<FakeSession> {
    const session = new FakeSession(config, true);
    session.pendingOnQuery = this.pendingOnResume;
    this.sessions.push(session);
    return session;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: 'mock-model' }];
  }
}
