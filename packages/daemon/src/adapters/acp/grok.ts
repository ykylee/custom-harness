// grok 어댑터 (WBS 2.2.1·2.2.3, FR-1.2.4) — ACP 경로 (`grok agent stdio`, 2026-08-25 승인).
// 스키마 근거: grok 1.0.5 실측 (목 게이트웨이 ACP 프로브 — initialize/new/prompt/update/
// request_permission/cancel/set_model/load 리플레이/SIGTERM 저장, grok-integration-paths §3).
// GROK_HOME 격리는 데몬 env 오버레이(gateway/service)가 담당. --version 정품 검증(비공식
// grok CLI 충돌 대비). 세션 재개는 session/load — 응답 전 도착하는 히스토리 리플레이는 드롭.
import type {
  AgentEvent,
  McpServerConfig,
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
import { AcpClient } from './client.js';

export interface GrokAdapterOptions {
  /** 번들 내 grok 실행 파일 절대 경로 (FR-1.1.1 PATH 금지) */
  command: string;
  /** command 뒤·grok 인자 앞에 붙는 인자 (테스트: node 스크립트 경로 주입용) */
  prependArgs?: string[];
  supervisor: ProcessSupervisor;
  responseTimeoutMs?: number;
}

/** ACP tool_call.kind → 중립 분류 (adapter-contract §3 — kind 를 프로토콜이 제공) */
const ACP_KIND_TABLE: Record<string, ToolKind> = {
  execute: 'shell',
  read: 'read',
  edit: 'edit',
  search: 'search',
  fetch: 'fetch',
  think: 'plan',
  move: 'other',
  delete: 'other',
  other: 'other',
};

export function mapAcpToolKind(kind: string): ToolKind {
  return ACP_KIND_TABLE[kind] ?? 'other';
}

/** ACP toolCall.kind → 승인 요청 분류 (FR-1.5) */
function permissionKindFor(kind: string): PermissionRequest['kind'] {
  if (kind === 'execute') return 'shell';
  if (kind === 'edit' || kind === 'move' || kind === 'delete') return 'file_write';
  if (kind === 'fetch') return 'fetch';
  return 'other';
}

/** prompt 응답 _meta → 중립 usage (grok 1.0.5 실측: _meta.usage.{input,output,total}Tokens) */
function usageFromMeta(meta: Record<string, unknown> | undefined): Usage | undefined {
  const raw = (meta?.usage ?? meta) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  const usage: Usage = {};
  if (typeof raw.inputTokens === 'number') usage.inputTokens = raw.inputTokens;
  if (typeof raw.outputTokens === 'number') usage.outputTokens = raw.outputTokens;
  if (typeof raw.totalTokens === 'number') usage.totalTokens = raw.totalTokens;
  return usage.inputTokens !== undefined || usage.totalTokens !== undefined ? usage : undefined;
}

interface PendingPermission {
  rpcId: number | string;
  request: PermissionRequest;
}

class GrokSession implements AgentSession {
  readonly sessionId: string;
  private readonly client: AcpClient;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly cwd: string;
  private acpSessionId = '';
  private turnCounter = 0;
  private activeTurnId: string | undefined;
  /** session/load 응답 전 도착하는 히스토리 리플레이 드롭 (실측: 응답 전에 재생됨) */
  private suppressReplay = false;
  private permissionCounter = 0;

  constructor(
    config: SessionConfig,
    process: ManagedProcess,
    options: { responseTimeoutMs?: number | undefined },
  ) {
    this.sessionId = config.sessionId;
    this.cwd = config.cwd;
    this.client = new AcpClient(process, {
      ...(options.responseTimeoutMs !== undefined
        ? { requestTimeoutMs: options.responseTimeoutMs }
        : {}),
      onNotification: (method, params) => this.onNotification(method, params),
      onServerRequest: (request) => this.onServerRequest(request),
    });
    void process.exited.then((exit) => {
      if (!exit.expected) {
        this.emit({
          type: 'session_status_changed',
          status: 'error',
          error: {
            kind: 'spawn',
            message: `grok 프로세스 비정상 종료 (code=${exit.code}, signal=${exit.signal})`,
            retriable: true,
          },
        });
      }
    });
  }

  /** initialize → session/new 또는 session/load (재개) */
  async open(config: SessionConfig, resume: { acpSessionId: string } | undefined): Promise<void> {
    await this.client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const mcpServers = (config.mcpServers ?? []).map((m: McpServerConfig) => ({
      name: m.name,
      command: m.command,
      args: m.args ?? [],
      env: Object.entries(m.env ?? {}).map(([name, value]) => ({ name, value })),
    }));
    if (resume) {
      this.suppressReplay = true;
      try {
        await this.client.request(
          'session/load',
          { sessionId: resume.acpSessionId, cwd: this.cwd, mcpServers },
          60_000,
        );
      } finally {
        this.suppressReplay = false;
      }
      this.acpSessionId = resume.acpSessionId;
    } else {
      const result = (await this.client.request('session/new', {
        cwd: this.cwd,
        mcpServers,
      })) as { sessionId?: string };
      if (typeof result?.sessionId !== 'string' || !result.sessionId) {
        throw new AdapterError('protocol', 'session/new 응답에 sessionId 없음', {
          nativeDetail: result,
        });
      }
      this.acpSessionId = result.sessionId;
    }
    if (config.modelId !== undefined) await this.setModel(config.modelId);
  }

  async startTurn(prompt: string): Promise<{ turnId: string }> {
    if (this.activeTurnId !== undefined) {
      throw new AdapterError('protocol', '활성 턴이 이미 있음');
    }
    this.turnCounter += 1;
    const turnId = `grok-turn-${this.turnCounter}`;
    this.activeTurnId = turnId;
    // prompt 응답 = 턴 종료 (ACP) — 타임아웃 없이 비동기 완결 처리
    void this.client
      .request(
        'session/prompt',
        { sessionId: this.acpSessionId, prompt: [{ type: 'text', text: prompt }] },
        0,
      )
      .then((result) => {
        this.activeTurnId = undefined;
        const { stopReason, _meta } = (result ?? {}) as {
          stopReason?: string;
          _meta?: Record<string, unknown>;
        };
        const usage = usageFromMeta(_meta);
        if (stopReason === 'cancelled') {
          this.emit({ type: 'turn_canceled', turnId });
          return;
        }
        if (stopReason === 'refusal') {
          this.emit({
            type: 'turn_failed',
            turnId,
            error: { kind: 'unknown', message: 'grok 이 요청을 거부함 (refusal)' },
          });
          return;
        }
        this.emit({ type: 'turn_completed', turnId, ...(usage ? { usage } : {}) });
      })
      .catch((error: unknown) => {
        this.activeTurnId = undefined;
        // ErrorInfo.kind 에는 'unsupported' 가 없다 — 턴 실패 문맥에선 unknown 으로 투영
        const kind =
          error instanceof AdapterError && error.kind !== 'unsupported' ? error.kind : 'unknown';
        this.emit({
          type: 'turn_failed',
          turnId,
          error: {
            kind,
            message: error instanceof Error ? error.message : String(error),
            nativeDetail: error instanceof AdapterError ? error.nativeDetail : undefined,
          },
        });
      });
    return { turnId };
  }

  subscribe(listener: (event: AgentEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** session/cancel 은 알림 — 활성 턴이 없어도 안전 (멱등, FR-1.6, 실측 #6) */
  async interrupt(): Promise<void> {
    this.client.notify('session/cancel', { sessionId: this.acpSessionId });
  }

  async respondToPermission(requestId: string, outcome: PermissionOutcome): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) throw new AdapterError('protocol', `미지의 승인 요청: ${requestId}`);
    if ('cancelled' in outcome) {
      this.client.respond(pending.rpcId, { outcome: { outcome: 'cancelled' } });
    } else {
      if (!pending.request.options.some((o) => o.optionId === outcome.optionId)) {
        throw new AdapterError('protocol', `승인 요청에 없는 옵션: ${outcome.optionId}`);
      }
      this.client.respond(pending.rpcId, {
        outcome: { outcome: 'selected', optionId: outcome.optionId },
      });
    }
    this.pendingPermissions.delete(requestId);
    this.emit({ type: 'permission_resolved', requestId, outcome });
  }

  async getPendingPermissions(): Promise<PermissionRequest[]> {
    return [...this.pendingPermissions.values()].map((p) => p.request);
  }

  async setModel(modelId: string): Promise<void> {
    await this.client.request('session/set_model', {
      sessionId: this.acpSessionId,
      modelId,
    });
  }

  describeHandle(): PersistenceHandle {
    return {
      harness: 'grok',
      nativeHandle: this.acpSessionId,
      // session/load 는 원 cwd 를 요구 — 세션 저장이 cwd 단위 디렉토리 (1.0.5 실측)
      metadata: { cwd: this.cwd },
    };
  }

  /** SIGTERM 시 grok 는 세션을 저장한다 (실측 #9) — 재개 가능 상태로 종료 */
  async close(): Promise<void> {
    await this.client.dispose();
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  // ── 이벤트 정규화 (FR-1.4) ────────────────────────────────────────────────

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method !== 'session/update') return; // _x.ai/* 확장·큐 알림은 1차 대상 아님
    if (this.suppressReplay) return; // session/load 히스토리 리플레이 드롭
    const update = (params.update ?? {}) as Record<string, unknown>;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = (update.content as { text?: string } | undefined)?.text;
        if (typeof text === 'string') {
          this.emit({ type: 'message_delta', delta: text, ...this.turnRef() });
        }
        return;
      }
      case 'agent_thought_chunk': {
        const text = (update.content as { text?: string } | undefined)?.text;
        if (typeof text === 'string') {
          this.emit({ type: 'reasoning_delta', delta: text, ...this.turnRef() });
        }
        return;
      }
      case 'tool_call':
        this.emit({
          type: 'tool_execution_started',
          toolCallId: String(update.toolCallId),
          kind: mapAcpToolKind(String(update.kind)),
          toolName: this.nativeToolName(update),
          rawInput: update.rawInput,
        });
        return;
      case 'tool_call_update': {
        const status = update.status;
        if (status === 'completed' || status === 'failed') {
          this.emit({
            type: 'tool_execution_completed',
            toolCallId: String(update.toolCallId),
            ok: status === 'completed',
            rawOutput: update.content ?? update.rawOutput,
          });
        } else {
          this.emit({
            type: 'tool_execution_updated',
            toolCallId: String(update.toolCallId),
            rawUpdate: update,
          });
        }
        return;
      }
      default:
        // user_message_chunk(데몬 소유)·plan·available_commands_update 등 — 1차 드롭
        return;
    }
  }

  /** x.ai 확장 메타의 네이티브 툴명 우선, 없으면 ACP kind (§3 — 원본 보존) */
  private nativeToolName(update: Record<string, unknown>): string {
    const meta = update._meta as Record<string, unknown> | undefined;
    const tool = meta?.['x.ai/tool'] as { name?: string } | undefined;
    return tool?.name ?? String(update.title ?? update.kind);
  }

  private turnRef(): { turnId?: string } {
    return this.activeTurnId !== undefined ? { turnId: this.activeTurnId } : {};
  }

  // ── 승인 배선 (WBS 2.2.3, FR-1.5) — session/request_permission ────────────

  private onServerRequest(request: {
    id: number | string;
    method: string;
    params: Record<string, unknown>;
  }): void {
    if (request.method !== 'session/request_permission') {
      // 미지 서버 요청 — 프로토콜을 세우지 않도록 에러 응답 (관대 처리)
      this.client.respondError(request.id, -32601, `unsupported: ${request.method}`);
      return;
    }
    const toolCall = (request.params.toolCall ?? {}) as Record<string, unknown>;
    const rawOptions = Array.isArray(request.params.options) ? request.params.options : [];
    this.permissionCounter += 1;
    const requestId = `grok-perm-${this.permissionCounter}`;
    const permission: PermissionRequest = {
      requestId,
      kind: permissionKindFor(String(toolCall.kind ?? 'other')),
      summary: String(toolCall.title ?? '승인 요청'),
      detail: request.params,
      // 실측(1.0.5 기본 권한 모드): allow-once/reject-once 2종, kind 는 ACP 표준과 동일 표기
      options: rawOptions.map((option) => {
        const o = option as { optionId?: unknown; name?: unknown; kind?: unknown };
        const kind = String(o.kind ?? 'allow_once');
        return {
          optionId: String(o.optionId ?? ''),
          label: String(o.name ?? o.optionId ?? ''),
          kind:
            (['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const).find(
              (k) => k === kind,
            ) ?? 'allow_once',
        };
      }),
    };
    this.pendingPermissions.set(requestId, { rpcId: request.id, request: permission });
    this.emit({ type: 'permission_requested', request: permission });
  }
}

export class GrokAdapter implements AgentAdapter {
  readonly id = 'grok' as const;
  /**
   * 실측(grok 1.0.5) 기준. 설계표(adapter-contract §2) 대비 하향: compaction 은
   * /compact 슬래시 커맨드 경로뿐이라 계약 메서드 부재로 1차 false (개정 포인트).
   */
  readonly capabilities = {
    streaming: true,
    reasoningStream: true,
    sessionResume: true,
    runtimePermission: true,
    modelSwitch: true,
    mcpInjection: true,
    nativeToolRegistration: false,
    steering: false,
    usageReporting: true,
    compaction: false,
  };

  constructor(private readonly options: GrokAdapterOptions) {}

  /** `--version` 정품 검증 — 비공식 grok CLI 와 바이너리명 충돌 대비 (조사 §2 주의) */
  async probe(): Promise<ProbeResult> {
    try {
      const managed = await this.options.supervisor.spawn({
        command: this.options.command,
        args: [...(this.options.prependArgs ?? []), '--version'],
        harness: 'grok',
      });
      let out = '';
      managed.child.stdout?.on('data', (chunk: Buffer) => (out += String(chunk)));
      const exit = await managed.exited;
      if (exit.code !== 0) {
        return { available: false, warnings: [`grok --version 종료 코드 ${exit.code}`] };
      }
      const match = /^grok\s+(\d+\.\d+\.\S*)/.exec(out.trim());
      if (!match) {
        return {
          available: false,
          warnings: [`정품 grok 출력 형식 아님 (비공식 CLI 충돌 의심): ${out.trim().slice(0, 80)}`],
        };
      }
      return {
        available: true,
        version: match[1] as string,
        verified: false,
        warnings: ['manifest 버전 대조(FR-1.8)는 2.3.3 에서 구현'],
      };
    } catch (error) {
      return {
        available: false,
        warnings: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  async createSession(config: SessionConfig): Promise<AgentSession> {
    return this.spawnSession(config, undefined);
  }

  async resumeSession(handle: PersistenceHandle, config: SessionConfig): Promise<AgentSession> {
    if (typeof handle.nativeHandle !== 'string' || !handle.nativeHandle) {
      throw new AdapterError('protocol', 'grok 재개에는 ACP sessionId 핸들이 필요');
    }
    const storedCwd = (handle.metadata as { cwd?: string } | undefined)?.cwd;
    return this.spawnSession(
      // 세션 저장이 cwd 단위 — 핸들의 원 cwd 를 우선 사용 (실측)
      storedCwd !== undefined ? { ...config, cwd: storedCwd } : config,
      { acpSessionId: handle.nativeHandle },
    );
  }

  /** 게이트웨이 모델 카탈로그(FR-2.4)는 2.3.4 — 그 전까지 빈 목록 */
  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  private async spawnSession(
    config: SessionConfig,
    resume: { acpSessionId: string } | undefined,
  ): Promise<AgentSession> {
    let managed: ManagedProcess;
    try {
      managed = await this.options.supervisor.spawn({
        command: this.options.command,
        args: [...(this.options.prependArgs ?? []), 'agent', 'stdio'],
        cwd: config.cwd,
        env: config.env,
        sessionId: config.sessionId,
        harness: 'grok',
      });
    } catch (error) {
      throw new AdapterError('spawn', error instanceof Error ? error.message : String(error));
    }
    const session = new GrokSession(config, managed, {
      responseTimeoutMs: this.options.responseTimeoutMs,
    });
    try {
      await session.open(config, resume);
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }
}
