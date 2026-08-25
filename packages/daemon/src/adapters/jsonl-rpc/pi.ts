// pi 어댑터 (WBS 1.3.2·1.3.3, FR-1.2.2) — `pi --mode rpc` + stdio JSONL RPC.
// 스키마 근거: pi 0.84.1 실측 (dist/modes/rpc/rpc-types — RpcCommand/RpcResponse/AgentEvent).
// 설계표(adapter-contract §2)와의 실측 차이: mcpInjection 플래그 없음(--mcp-config 부재),
// steer/compact RPC 는 존재하나 계약 밖 → capability false 유지. 문서 개정 포인트로 기록.
import type {
  AgentEvent,
  ModelInfo,
  PermissionOutcome,
  PermissionRequest,
  ProbeResult,
  ToolKind,
  Usage,
} from '@custom-harness/protocol';
import {
  AdapterError,
  type AgentAdapter,
  type AgentSession,
  type PersistenceHandle,
  type SessionConfig,
  type Unsubscribe,
} from '../contract.js';
import type { ManagedProcess, ProcessSupervisor } from '../../processes.js';
import { JsonlRpcTransport } from './transport.js';

export interface PiAdapterOptions {
  /** 번들 내 pi 실행 파일 절대 경로 (FR-1.1.1 PATH 금지) */
  command: string;
  /** command 뒤·pi 인자 앞에 붙는 인자 (테스트: node 스크립트 경로 주입용) */
  prependArgs?: string[];
  supervisor: ProcessSupervisor;
  /** 세션 파일 격리 디렉토리 (--session-dir) — 데몬 데이터 하위 권장 */
  sessionDir?: string;
  responseTimeoutMs?: number;
}

/** FR-1.2.5 중립 분류 매핑 — 미지 툴명은 other + 원본 보존 (테이블 주도, 관대 매핑) */
const TOOL_KIND_TABLE: Record<string, ToolKind> = {
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

export function mapToolKind(toolName: string): ToolKind {
  return TOOL_KIND_TABLE[toolName] ?? 'other';
}

/** pi Usage → 중립 usage (미지 필드는 loose 스키마가 보존) */
function normalizeUsage(raw: Record<string, unknown>): Usage {
  const usage: Usage = { ...raw };
  if (typeof raw.input === 'number') usage.inputTokens = raw.input;
  if (typeof raw.output === 'number') usage.outputTokens = raw.output;
  if (typeof raw.totalTokens === 'number') usage.totalTokens = raw.totalTokens;
  return usage;
}

interface PendingUi {
  request: PermissionRequest;
  method: 'confirm' | 'select';
  selectOptions?: string[];
}

class PiSession implements AgentSession {
  readonly sessionId: string;
  private readonly transport: JsonlRpcTransport;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly pendingUi = new Map<string, PendingUi>();
  private turnCounter = 0;
  private activeTurnId: string | undefined;
  private nativeSessionFile: string | undefined;
  private nativeSessionId: string | undefined;

  constructor(
    config: SessionConfig,
    private readonly process: ManagedProcess,
    options: { responseTimeoutMs?: number | undefined },
  ) {
    this.sessionId = config.sessionId;
    this.transport = new JsonlRpcTransport(process, {
      ...(options.responseTimeoutMs !== undefined
        ? { responseTimeoutMs: options.responseTimeoutMs }
        : {}),
      onFrame: (frame) => this.onFrame(frame),
    });
    // 비정상 종료 감지 → 세션 에러 신호 (FR-1.1.3)
    void process.exited.then((exit) => {
      if (!exit.expected) {
        this.emit({
          type: 'session_status_changed',
          status: 'error',
          error: {
            kind: 'spawn',
            message: `pi 프로세스 비정상 종료 (code=${exit.code}, signal=${exit.signal})`,
            retriable: true,
          },
        });
      }
    });
  }

  /** 기동 직후 get_state 로 영속 핸들 확보 — 응답 가능 시점 확인을 겸한다 */
  async loadState(): Promise<void> {
    const frame = await this.transport.request({ type: 'get_state' });
    const data = (frame.data ?? {}) as { sessionFile?: string; sessionId?: string };
    this.nativeSessionFile = data.sessionFile;
    this.nativeSessionId = data.sessionId;
  }

  async startTurn(prompt: string): Promise<{ turnId: string }> {
    await this.transport.request({ type: 'prompt', message: prompt });
    this.turnCounter += 1;
    this.activeTurnId = `pi-turn-${this.turnCounter}`;
    return { turnId: this.activeTurnId };
  }

  subscribe(listener: (event: AgentEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** pi abort 는 스트리밍 중이 아니어도 성공 응답 — 멱등 (FR-1.6) */
  async interrupt(): Promise<void> {
    await this.transport.request({ type: 'abort' });
  }

  async respondToPermission(requestId: string, outcome: PermissionOutcome): Promise<void> {
    const pending = this.pendingUi.get(requestId);
    if (!pending) throw new AdapterError('protocol', `미지의 승인 요청: ${requestId}`);
    this.transport.send(this.buildUiResponse(requestId, pending, outcome));
    this.pendingUi.delete(requestId);
    this.emit({ type: 'permission_resolved', requestId, outcome });
  }

  async getPendingPermissions(): Promise<PermissionRequest[]> {
    return [...this.pendingUi.values()].map((p) => p.request);
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
      harness: 'pi',
      nativeHandle: this.nativeSessionFile ?? null,
      metadata: this.nativeSessionId !== undefined ? { sessionId: this.nativeSessionId } : {},
    };
  }

  async close(): Promise<void> {
    await this.transport.dispose();
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  // ── 이벤트 정규화 (FR-1.4) ────────────────────────────────────────────────

  private onFrame(frame: Record<string, unknown>): void {
    switch (frame.type) {
      case 'extension_ui_request':
        this.onUiRequest(frame);
        return;
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
          kind: mapToolKind(String(frame.toolName)),
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
        // 미지 이벤트 통과(FR-1.8, S)는 M2 에서 — 1차는 드롭.
        return;
    }
  }

  private turnRef(): { turnId?: string } {
    return this.activeTurnId !== undefined ? { turnId: this.activeTurnId } : {};
  }

  private onAgentEnd(frame: Record<string, unknown>): void {
    const turnId = this.activeTurnId ?? `pi-turn-${this.turnCounter}`;
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
          message: String(lastAssistant?.errorMessage ?? 'pi 턴 실패'),
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

  // ── 승인 배선 (WBS 1.3.3, FR-1.5) — extension_ui_request 채널 ─────────────

  private onUiRequest(frame: Record<string, unknown>): void {
    const id = String(frame.id ?? '');
    const method = frame.method;
    if (method === 'confirm') {
      const request: PermissionRequest = {
        requestId: id,
        kind: 'other',
        summary: `${String(frame.title ?? '확인 요청')}: ${String(frame.message ?? '')}`,
        detail: frame,
        options: [
          { optionId: 'confirm', label: '확인', kind: 'allow_once' },
          { optionId: 'reject', label: '거부', kind: 'reject_once' },
        ],
      };
      this.pendingUi.set(id, { request, method: 'confirm' });
      this.emit({ type: 'permission_requested', request });
      return;
    }
    if (method === 'select') {
      const options = Array.isArray(frame.options) ? frame.options.map(String) : [];
      const request: PermissionRequest = {
        requestId: id,
        kind: 'other',
        summary: String(frame.title ?? '선택 요청'),
        detail: frame,
        options: options.map((label, index) => ({
          optionId: String(index),
          label,
          kind: 'allow_once' as const,
        })),
      };
      this.pendingUi.set(id, { request, method: 'select', selectOptions: options });
      this.emit({ type: 'permission_requested', request });
      return;
    }
    if (method === 'input' || method === 'editor') {
      // 텍스트 입력 중재는 1차 범위 외 — 취소 응답으로 우아한 격하 (M2 개정 포인트)
      this.transport.send({ type: 'extension_ui_response', id, cancelled: true });
      return;
    }
    // notify/setStatus/setWidget/setTitle/set_editor_text — 표시성 요청, 1차 무시
  }

  private buildUiResponse(
    id: string,
    pending: PendingUi,
    outcome: PermissionOutcome,
  ): Record<string, unknown> {
    if ('cancelled' in outcome) return { type: 'extension_ui_response', id, cancelled: true };
    if (pending.method === 'confirm') {
      if (outcome.optionId === 'confirm')
        return { type: 'extension_ui_response', id, confirmed: true };
      if (outcome.optionId === 'reject')
        return { type: 'extension_ui_response', id, confirmed: false };
      throw new AdapterError('protocol', `confirm 요청에 없는 옵션: ${outcome.optionId}`);
    }
    const value = pending.selectOptions?.[Number(outcome.optionId)];
    if (value === undefined) {
      throw new AdapterError('protocol', `select 요청에 없는 옵션: ${outcome.optionId}`);
    }
    return { type: 'extension_ui_response', id, value };
  }
}

export class PiAdapter implements AgentAdapter {
  readonly id = 'pi' as const;
  /** 실측(pi 0.84.1) 기준 — 설계표와 차이는 파일 상단 주석 참조 */
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

  constructor(private readonly options: PiAdapterOptions) {}

  async probe(): Promise<ProbeResult> {
    try {
      const managed = await this.options.supervisor.spawn({
        command: this.options.command,
        args: [...(this.options.prependArgs ?? []), '--version'],
        harness: 'pi',
      });
      let out = '';
      managed.child.stdout?.on('data', (chunk: Buffer) => (out += String(chunk)));
      const exit = await managed.exited;
      if (exit.code !== 0) {
        return { available: false, warnings: [`pi --version 종료 코드 ${exit.code}`] };
      }
      return {
        available: true,
        version: out.trim(),
        verified: false,
        warnings: ['manifest 버전 대조(FR-1.8)는 M2 에서 구현'],
      };
    } catch (error) {
      return {
        available: false,
        warnings: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  async createSession(config: SessionConfig): Promise<AgentSession> {
    return this.spawnSession(config, []);
  }

  async resumeSession(handle: PersistenceHandle, config: SessionConfig): Promise<AgentSession> {
    if (typeof handle.nativeHandle !== 'string' || !handle.nativeHandle) {
      throw new AdapterError('protocol', 'pi 재개에는 세션 파일 경로 핸들이 필요');
    }
    return this.spawnSession(config, ['--session', handle.nativeHandle]);
  }

  /** 게이트웨이 모델 카탈로그 배선(FR-2.4)은 WBS 1.4 — 그 전까지 빈 목록 */
  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  private async spawnSession(config: SessionConfig, extraArgs: string[]): Promise<AgentSession> {
    if (config.mcpServers && config.mcpServers.length > 0) {
      // capability 미지원 무시 금지 규칙 (adapter-contract §2) — pi 0.84.1 은 mcp 주입 플래그 없음
      throw new AdapterError('unsupported', 'pi 어댑터는 세션 단위 MCP 주입 미지원');
    }
    const args = [
      ...(this.options.prependArgs ?? []),
      '--mode',
      'rpc',
      ...(this.options.sessionDir ? ['--session-dir', this.options.sessionDir] : []),
      ...(config.modelId !== undefined ? ['--model', config.modelId] : []),
      ...extraArgs,
    ];
    let managed: ManagedProcess;
    try {
      managed = await this.options.supervisor.spawn({
        command: this.options.command,
        args,
        cwd: config.cwd,
        env: config.env,
        sessionId: config.sessionId,
        harness: 'pi',
      });
    } catch (error) {
      throw new AdapterError('spawn', error instanceof Error ? error.message : String(error));
    }
    const session = new PiSession(config, managed, {
      responseTimeoutMs: this.options.responseTimeoutMs,
    });
    try {
      await session.loadState();
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }
}
