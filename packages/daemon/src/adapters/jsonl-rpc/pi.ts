// pi 어댑터 (WBS 1.3.2·1.3.3, FR-1.2.2) — `pi --mode rpc` + stdio JSONL RPC.
// 스키마 근거: pi 0.84.1 실측 (dist/modes/rpc/rpc-types — RpcCommand/RpcResponse/AgentEvent).
// 설계표(adapter-contract §2)와의 실측 차이: mcpInjection 플래그 없음(--mcp-config 부재),
// steer/compact RPC 는 존재하나 계약 밖 → capability false 유지. 문서 개정 포인트로 기록.
// 공용 정규화·수명주기는 session-core.ts (WBS 2.1.1 에서 omp 와 공유하도록 추출).
import type {
  ModelInfo,
  PermissionOutcome,
  PermissionRequest,
  ProbeResult,
  ToolKind,
} from '@custom-harness/protocol';
import {
  AdapterError,
  type AgentAdapter,
  type AgentSession,
  type PersistenceHandle,
  type SessionConfig,
} from '../contract.js';
import type { ManagedProcess, ProcessSupervisor } from '../../processes.js';
import { JsonlRpcSessionCore, TOOL_KIND_TABLE, mapToolKindWith } from './session-core.js';

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

export function mapToolKind(toolName: string): ToolKind {
  return mapToolKindWith(TOOL_KIND_TABLE, toolName);
}

interface PendingUi {
  request: PermissionRequest;
  method: 'confirm' | 'select';
  selectOptions?: string[];
}

class PiSession extends JsonlRpcSessionCore {
  protected readonly harness = 'pi' as const;
  private readonly pendingUi = new Map<string, PendingUi>();

  constructor(
    config: SessionConfig,
    process: ManagedProcess,
    options: { responseTimeoutMs?: number | undefined },
  ) {
    super(config, process, {
      turnIdPrefix: 'pi-turn',
      toolKindTable: TOOL_KIND_TABLE,
      harnessLabel: 'pi',
      responseTimeoutMs: options.responseTimeoutMs,
    });
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

  // ── 승인 배선 (WBS 1.3.3, FR-1.5) — extension_ui_request 채널 ─────────────

  protected handleUiRequest(frame: Record<string, unknown>): void {
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
