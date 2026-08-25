// pi 계열 공용 세션 코어 (WBS 2.1.1·2.1.2) — pi/omp 가 공유하는 이벤트 정규화·턴 수명주기.
// omp 는 pi 의 포크로 RPC 이벤트 스키마가 동일하다(소스 실측: oh-my-pi 17.3.8 rpc-types).
// 하네스별 차이(승인 배선, ready/협상, 확장 프레임)는 훅으로 분리한다.
import type {
  AgentEvent,
  PermissionOutcome,
  PermissionRequest,
  ToolKind,
  Usage,
} from '@custom-harness/protocol';
import {
  AdapterError,
  type AgentSession,
  type PersistenceHandle,
  type SessionConfig,
  type Unsubscribe,
} from '../contract.js';
import type { ManagedProcess } from '../../processes.js';
import { JsonlRpcTransport } from './transport.js';

/** FR-1.2.5 중립 분류 매핑 — 미지 툴명은 other + 원본 보존 (테이블 주도, 관대 매핑) */
export const TOOL_KIND_TABLE: Record<string, ToolKind> = {
  bash: 'shell',
  run: 'shell',
  read: 'read',
  read_file: 'read',
  edit: 'edit',
  write: 'write',
  write_file: 'write',
  create: 'write',
  grep: 'search',
  glob: 'search',
  find: 'search',
  fetch: 'fetch',
  web_fetch: 'fetch',
  web_search: 'fetch',
  plan: 'plan',
};

/** omp 확장분 (builtin-names.ts 실측 17.3.8) — 공용 테이블 위에 겹친다 */
export const OMP_TOOL_KIND_TABLE: Record<string, ToolKind> = {
  ...TOOL_KIND_TABLE,
  ast_grep: 'search',
  lsp: 'search',
  ast_edit: 'edit',
  task: 'sub_agent',
  todo: 'plan',
  think: 'plan',
};

export function mapToolKindWith(table: Record<string, ToolKind>, toolName: string): ToolKind {
  return table[toolName] ?? 'other';
}

/** pi/omp Usage → 중립 usage (미지 필드는 loose 스키마가 보존) */
export function normalizeUsage(raw: Record<string, unknown>): Usage {
  const usage: Usage = { ...raw };
  if (typeof raw.input === 'number') usage.inputTokens = raw.input;
  if (typeof raw.output === 'number') usage.outputTokens = raw.output;
  if (typeof raw.totalTokens === 'number') usage.totalTokens = raw.totalTokens;
  return usage;
}

export interface SessionCoreOptions {
  /** turnId 접두 (pi-turn / omp-turn) */
  turnIdPrefix: string;
  /** 툴 중립 분류 테이블 */
  toolKindTable: Record<string, ToolKind>;
  /** 에러 메시지용 하네스 표기 */
  harnessLabel: string;
  responseTimeoutMs?: number | undefined;
  /** 전송 계층 경고 수신 (rpc_chunk 폐기 등) */
  onTransportWarning?: ((message: string) => void) | undefined;
}

export abstract class JsonlRpcSessionCore implements AgentSession {
  readonly sessionId: string;
  protected readonly transport: JsonlRpcTransport;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly coreOptions: SessionCoreOptions;
  protected turnCounter = 0;
  protected activeTurnId: string | undefined;
  protected nativeSessionFile: string | undefined;
  protected nativeSessionId: string | undefined;
  /**
   * 세션 재개 리플레이 드롭 가드 (WBS 2.1.2, FR-1.3.4) — true 인 동안 하네스 유래
   * 대화 이벤트를 억제한다. 첫 startTurn 에서 해제. omp 17.3.8 실측으로는 재개 시
   * 리플레이가 없으나, 버전 드리프트 대비 방어 (harness-interfaces §1 조사 근거).
   */
  protected suppressReplay = false;

  constructor(config: SessionConfig, process: ManagedProcess, options: SessionCoreOptions) {
    this.sessionId = config.sessionId;
    this.coreOptions = options;
    this.transport = new JsonlRpcTransport(process, {
      ...(options.responseTimeoutMs !== undefined
        ? { responseTimeoutMs: options.responseTimeoutMs }
        : {}),
      onFrame: (frame) => this.dispatchFrame(frame),
      ...(options.onTransportWarning !== undefined
        ? { onWarning: options.onTransportWarning }
        : {}),
    });
    // 비정상 종료 감지 → 세션 에러 신호 (FR-1.1.3)
    void process.exited.then((exit) => {
      if (!exit.expected) {
        this.emit({
          type: 'session_status_changed',
          status: 'error',
          error: {
            kind: 'spawn',
            message: `${options.harnessLabel} 프로세스 비정상 종료 (code=${exit.code}, signal=${exit.signal})`,
            retriable: true,
          },
        });
      }
    });
  }

  // ── 하네스별 훅 ───────────────────────────────────────────────────────────

  protected abstract readonly harness: PersistenceHandle['harness'];
  /** extension_ui_request 처리 — pi 는 승인 중재, omp 는 우아한 격하 */
  protected abstract handleUiRequest(frame: Record<string, unknown>): void;
  /** 코어 스위치 앞의 하네스 확장 프레임 처리 — true 반환 시 소비됨 (omp: ready 등) */
  protected handleExtraFrame(_frame: Record<string, unknown>): boolean {
    return false;
  }

  abstract respondToPermission(requestId: string, outcome: PermissionOutcome): Promise<void>;
  abstract getPendingPermissions(): Promise<PermissionRequest[]>;

  // ── 공통 수명주기 ─────────────────────────────────────────────────────────

  /** 기동 직후 get_state 로 영속 핸들 확보 — 응답 가능 시점 확인을 겸한다 */
  async loadState(): Promise<void> {
    const frame = await this.transport.request({ type: 'get_state' });
    const data = (frame.data ?? {}) as { sessionFile?: string; sessionId?: string };
    this.nativeSessionFile = data.sessionFile;
    this.nativeSessionId = data.sessionId;
  }

  async startTurn(prompt: string): Promise<{ turnId: string }> {
    // turnId 는 전송 전에 선할당 — 응답과 첫 이벤트가 같은 stdout 청크로 도착하면
    // 이벤트 처리가 응답 대기 재개(마이크로태스크)보다 먼저 실행되는 경합이 있다
    this.suppressReplay = false;
    this.turnCounter += 1;
    const turnId = `${this.coreOptions.turnIdPrefix}-${this.turnCounter}`;
    this.activeTurnId = turnId;
    try {
      await this.transport.request({ type: 'prompt', message: prompt });
    } catch (error) {
      this.activeTurnId = undefined;
      throw error;
    }
    return { turnId };
  }

  subscribe(listener: (event: AgentEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** abort 는 스트리밍 중이 아니어도 성공 응답 — 멱등 (FR-1.6) */
  async interrupt(): Promise<void> {
    await this.transport.request({ type: 'abort' });
  }

  async setModel(modelId: string): Promise<void> {
    // set_model 은 provider + modelId 분리 형식 — "provider/id" 표기를 계약 형식으로 사용
    const slash = modelId.indexOf('/');
    if (slash <= 0) {
      throw new AdapterError('model', `모델 ID 는 "provider/id" 형식 필요: ${modelId}`);
    }
    await this.transport.request({
      type: 'set_model',
      provider: modelId.slice(0, slash),
      modelId: modelId.slice(slash + 1),
    });
  }

  describeHandle(): PersistenceHandle {
    return {
      harness: this.harness,
      nativeHandle: this.nativeSessionFile ?? null,
      metadata: this.nativeSessionId !== undefined ? { sessionId: this.nativeSessionId } : {},
    };
  }

  async close(): Promise<void> {
    await this.transport.dispose();
  }

  protected emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  // ── 이벤트 정규화 (FR-1.4) ────────────────────────────────────────────────

  private dispatchFrame(frame: Record<string, unknown>): void {
    if (this.handleExtraFrame(frame)) return;
    if (frame.type === 'extension_ui_request') {
      this.handleUiRequest(frame);
      return;
    }
    if (this.suppressReplay) return; // 재개 리플레이 억제 — 첫 startTurn 전 대화 이벤트 드롭
    switch (frame.type) {
      case 'message_update': {
        const inner = (frame.assistantMessageEvent ?? {}) as { type?: string; delta?: string };
        if (inner.type === 'text_delta' && typeof inner.delta === 'string') {
          this.emit({ type: 'message_delta', delta: inner.delta, ...this.turnRef() });
        } else if (inner.type === 'thinking_delta' && typeof inner.delta === 'string') {
          this.emit({ type: 'reasoning_delta', delta: inner.delta, ...this.turnRef() });
        }
        return;
      }
      case 'tool_execution_start':
        this.emit({
          type: 'tool_execution_started',
          toolCallId: String(frame.toolCallId),
          kind: mapToolKindWith(this.coreOptions.toolKindTable, String(frame.toolName)),
          toolName: String(frame.toolName),
          rawInput: frame.args,
        });
        return;
      case 'tool_execution_update':
        this.emit({
          type: 'tool_execution_updated',
          toolCallId: String(frame.toolCallId),
          rawUpdate: frame.partialResult,
        });
        return;
      case 'tool_execution_end':
        this.emit({
          type: 'tool_execution_completed',
          toolCallId: String(frame.toolCallId),
          ok: frame.isError !== true,
          rawOutput: frame.result,
        });
        return;
      case 'turn_end': {
        const message = frame.message as { usage?: Record<string, unknown> } | undefined;
        if (message?.usage) {
          this.emit({ type: 'usage_updated', usage: normalizeUsage(message.usage) });
        }
        return;
      }
      case 'agent_end':
        this.onAgentEnd(frame);
        return;
      default:
        // agent_start/turn_start/message_start·end 등은 중립 유니온 대상 아님.
        // 미지 이벤트 통과(FR-1.8, S)는 M2 후반에서 — 1차는 드롭.
        return;
    }
  }

  protected turnRef(): { turnId?: string } {
    return this.activeTurnId !== undefined ? { turnId: this.activeTurnId } : {};
  }

  private onAgentEnd(frame: Record<string, unknown>): void {
    const turnId = this.activeTurnId ?? `${this.coreOptions.turnIdPrefix}-${this.turnCounter}`;
    this.activeTurnId = undefined;
    const messages = Array.isArray(frame.messages) ? (frame.messages as unknown[]) : [];
    const lastAssistant = [...messages]
      .reverse()
      .find(
        (m): m is Record<string, unknown> =>
          typeof m === 'object' && m !== null && (m as { role?: string }).role === 'assistant',
      );
    const stopReason = lastAssistant?.stopReason;
    if (stopReason === 'aborted') {
      this.emit({ type: 'turn_canceled', turnId });
      return;
    }
    if (stopReason === 'error') {
      this.emit({
        type: 'turn_failed',
        turnId,
        error: {
          kind: 'unknown',
          message: String(
            lastAssistant?.errorMessage ?? `${this.coreOptions.harnessLabel} 턴 실패`,
          ),
          nativeDetail: lastAssistant,
        },
      });
      return;
    }
    const usage = lastAssistant?.usage as Record<string, unknown> | undefined;
    this.emit({
      type: 'turn_completed',
      turnId,
      ...(usage ? { usage: normalizeUsage(usage) } : {}),
    });
  }
}
