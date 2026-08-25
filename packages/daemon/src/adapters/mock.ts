// mock 하네스 어댑터 (WBS 1.3.4) — 프로세스 없는 전 계약 구현.
// 계약 테스트의 기준점이자 렌더러 개발용 (test-strategy §1 — mock 은 1급 취급).
// 시나리오 마커: 프롬프트에 "[approval]" 승인 게이트, "[fail]" 턴 실패, "[tool:<name>]" 툴명 지정.
import type {
  AgentEvent,
  ModelInfo,
  PermissionOutcome,
  PermissionRequest,
  ProbeResult,
} from '@custom-harness/protocol';
import {
  AdapterError,
  type AgentAdapter,
  type AgentSession,
  type PersistenceHandle,
  type SessionConfig,
  type Unsubscribe,
} from './contract.js';

function toolNameFrom(prompt: string): string {
  const match = /\[tool:([^\]]+)\]/.exec(prompt);
  return match?.[1] ?? 'bash';
}

export class MockSession implements AgentSession {
  readonly sessionId: string;
  readonly resumed: boolean;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly pending = new Map<string, PermissionRequest>();
  private readonly waiters = new Map<string, (outcome: PermissionOutcome) => void>();
  private turnCounter = 0;
  private activeTurnId: string | undefined;
  modelId: string | undefined;

  constructor(config: SessionConfig, resumed: boolean, restoredPending: PermissionRequest[]) {
    this.sessionId = config.sessionId;
    this.resumed = resumed;
    this.modelId = config.modelId;
    for (const request of restoredPending) this.pending.set(request.requestId, request);
  }

  async startTurn(prompt: string): Promise<{ turnId: string }> {
    if (this.activeTurnId) throw new AdapterError('protocol', '이미 활성 턴 존재');
    this.turnCounter += 1;
    const turnId = `mock-turn-${this.turnCounter}`;
    this.activeTurnId = turnId;
    queueMicrotask(() => void this.runScenario(turnId, prompt));
    return { turnId };
  }

  subscribe(listener: (event: AgentEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async interrupt(): Promise<void> {
    if (!this.activeTurnId) return; // 멱등 (FR-1.6)
    const turnId = this.activeTurnId;
    this.activeTurnId = undefined;
    this.emit({ type: 'turn_canceled', turnId });
  }

  async respondToPermission(requestId: string, outcome: PermissionOutcome): Promise<void> {
    if (!this.pending.has(requestId)) {
      throw new AdapterError('protocol', `미지의 승인 요청: ${requestId}`);
    }
    this.pending.delete(requestId);
    this.emit({ type: 'permission_resolved', requestId, outcome });
    this.waiters.get(requestId)?.(outcome);
    this.waiters.delete(requestId);
  }

  async getPendingPermissions(): Promise<PermissionRequest[]> {
    return [...this.pending.values()];
  }

  async setModel(modelId: string): Promise<void> {
    this.modelId = modelId;
  }

  describeHandle(): PersistenceHandle {
    return { harness: 'mock', nativeHandle: `mock-native-${this.sessionId}` };
  }

  async close(): Promise<void> {
    this.activeTurnId = undefined;
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async runScenario(turnId: string, prompt: string): Promise<void> {
    const active = (): boolean => this.activeTurnId === turnId;
    if (!active()) return;
    this.emit({ type: 'reasoning_delta', turnId, delta: '생각 중…' });
    this.emit({ type: 'message_delta', turnId, delta: '작업을 ' });
    this.emit({ type: 'message_delta', turnId, delta: '시작합니다' });

    if (prompt.includes('[wait]')) return; // 완료 보류 — interrupt 가 turn_canceled 를 발행

    if (prompt.includes('[approval]')) {
      const request: PermissionRequest = {
        requestId: `perm-${turnId}`,
        kind: 'shell',
        summary: 'mock 명령 실행 승인',
        detail: { prompt },
        options: [
          { optionId: 'allow', label: '허용', kind: 'allow_once' },
          { optionId: 'deny', label: '거부', kind: 'reject_once' },
        ],
      };
      this.pending.set(request.requestId, request);
      const outcome = new Promise<PermissionOutcome>((resolve) => {
        this.waiters.set(request.requestId, resolve);
      });
      this.emit({ type: 'permission_requested', request });
      const resolved = await outcome;
      if (!active()) return;
      if ('cancelled' in resolved || resolved.optionId === 'deny') {
        this.activeTurnId = undefined;
        this.emit({ type: 'turn_canceled', turnId });
        return;
      }
    }

    const toolName = toolNameFrom(prompt);
    this.emit({
      type: 'tool_execution_started',
      turnId,
      toolCallId: `tc-${turnId}`,
      kind: toolName === 'bash' ? 'shell' : 'other',
      toolName,
      rawInput: { command: 'echo mock' },
    });
    this.emit({
      type: 'tool_execution_completed',
      turnId,
      toolCallId: `tc-${turnId}`,
      ok: true,
      rawOutput: { stdout: 'mock' },
    });

    if (!active()) return;
    this.activeTurnId = undefined;
    if (prompt.includes('[fail]')) {
      this.emit({
        type: 'turn_failed',
        turnId,
        error: { kind: 'unknown', message: 'mock 시나리오 실패' },
      });
      return;
    }
    this.emit({
      type: 'usage_updated',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    this.emit({
      type: 'turn_completed',
      turnId,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
  }
}

export interface MockAdapterOptions {
  /** resumeSession 시 복원할 미응답 승인 (FR-1.5 재기동 시나리오) */
  pendingOnResume?: PermissionRequest[];
}

export class MockAdapter implements AgentAdapter {
  readonly id = 'mock' as const;
  readonly capabilities = {
    streaming: true,
    reasoningStream: true,
    sessionResume: true,
    runtimePermission: true,
    modelSwitch: true,
    mcpInjection: false,
    nativeToolRegistration: false,
    steering: false,
    usageReporting: true,
    compaction: false,
  };
  readonly sessions: MockSession[] = [];

  constructor(private readonly options: MockAdapterOptions = {}) {}

  async probe(): Promise<ProbeResult> {
    return { available: true, version: 'mock-1.0.0', verified: true, warnings: [] };
  }

  async createSession(config: SessionConfig): Promise<AgentSession> {
    const session = new MockSession(config, false, []);
    this.sessions.push(session);
    return session;
  }

  async resumeSession(_handle: PersistenceHandle, config: SessionConfig): Promise<AgentSession> {
    const session = new MockSession(config, true, this.options.pendingOnResume ?? []);
    this.sessions.push(session);
    return session;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: 'mock/base', displayName: 'Mock Base' }];
  }
}
