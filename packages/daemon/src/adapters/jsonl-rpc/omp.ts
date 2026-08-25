// omp(oh-my-pi) 어댑터 (WBS 2.1.1·2.1.2, FR-1.2.3) — `omp --mode rpc-ui` + stdio JSONL RPC.
// 스키마 근거: oh-my-pi 17.3.8 소스 실측 (packages/coding-agent/src/modes/rpc/{rpc-types,rpc-frame}.ts)
// + 로컬 바이너리 행동 실측 (ready 핸드셰이크·negotiate_protocol·재개 무리플레이).
// pi 와 이벤트 스키마 동일(포크) — 차이: ready 후 v2 협상(rpc_chunk 64MiB 수신 청킹),
// 승인은 --approval-mode 고정(런타임 중재 포기, adapter-contract §4 결정), 재개 리플레이 드롭 가드.
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
import { JsonlRpcSessionCore, OMP_TOOL_KIND_TABLE, mapToolKindWith } from './session-core.js';

export interface OmpAdapterOptions {
  /** 번들 내 omp 실행 파일 절대 경로 (FR-1.1.1 PATH 금지) */
  command: string;
  /** command 뒤·omp 인자 앞에 붙는 인자 (테스트: node 스크립트 경로 주입용) */
  prependArgs?: string[];
  supervisor: ProcessSupervisor;
  /** 세션 파일 격리 디렉토리 (--session-dir) — 데몬 데이터 하위 권장 */
  sessionDir?: string;
  responseTimeoutMs?: number;
  /** ready 프레임 대기 한도 — 초과 시에도 협상은 시도한다 (COMPAT) */
  readyTimeoutMs?: number;
}

export function mapOmpToolKind(toolName: string): ToolKind {
  return mapToolKindWith(OMP_TOOL_KIND_TABLE, toolName);
}

/**
 * approvalPolicy → --approval-mode 번역 (adapter-contract §4 결정).
 * mediate 는 런타임 중재가 불가하므로 보수 프리셋 write, auto 는 yolo.
 */
export function approvalModeFor(policy: SessionConfig['approvalPolicy']): 'write' | 'yolo' {
  return policy === 'auto' ? 'yolo' : 'write';
}

class OmpSession extends JsonlRpcSessionCore {
  protected readonly harness = 'omp' as const;
  /** 협상 결과 — 1 이면 v1 폴백 (구버전 COMPAT, 큰 프레임은 서버가 축약) */
  protocolVersion: 1 | 2 = 1;
  private readyResolve: (() => void) | undefined;
  private readonly readyPromise: Promise<void>;
  private readonly readyTimeoutMs: number;

  constructor(
    config: SessionConfig,
    process: ManagedProcess,
    options: { responseTimeoutMs?: number | undefined; readyTimeoutMs?: number | undefined },
  ) {
    super(config, process, {
      turnIdPrefix: 'omp-turn',
      toolKindTable: OMP_TOOL_KIND_TABLE,
      harnessLabel: 'omp',
      responseTimeoutMs: options.responseTimeoutMs,
    });
    this.readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
  }

  /** ready 대기 → negotiate_protocol v2. 실패해도 세션은 유효 (v1 폴백, 관대 COMPAT) */
  async negotiate(): Promise<void> {
    await Promise.race([
      this.readyPromise,
      new Promise((resolve) => setTimeout(resolve, this.readyTimeoutMs)),
    ]);
    try {
      const frame = await this.transport.request({
        type: 'negotiate_protocol',
        protocolVersion: 2,
      });
      const data = (frame.data ?? {}) as { protocolVersion?: unknown };
      if (data.protocolVersion === 2) this.protocolVersion = 2;
    } catch {
      // 구버전 omp (v2 미지원) — v1 로 계속. 1MiB 초과 프레임은 서버 측 축약본이 온다.
    }
  }

  /** 재개 세션 표시 — 첫 startTurn 전 하네스 대화 이벤트를 드롭 (리플레이 가드) */
  markResumed(): void {
    this.suppressReplay = true;
  }

  /** runtimePermission: false — 중재할 승인이 없다 (silent no-op 금지, §2 규칙) */
  async respondToPermission(_requestId: string, _outcome: PermissionOutcome): Promise<void> {
    throw new AdapterError(
      'unsupported',
      'omp 어댑터는 런타임 승인 중재 미지원 (--approval-mode 고정)',
    );
  }

  async getPendingPermissions(): Promise<PermissionRequest[]> {
    return [];
  }

  protected override handleExtraFrame(frame: Record<string, unknown>): boolean {
    if (frame.type === 'ready') {
      this.readyResolve?.();
      return true;
    }
    // omp 확장 프레임 — 중립 유니온 대상 아님, 1차 드롭 (prompt_result·notice·
    // available_commands_update·subagent_* 등). 코어 default 드롭과 동일하나
    // 리플레이 가드 대상에서 제외할 필요도 없어 코어로 통과시킨다.
    return false;
  }

  /**
   * 승인 중재 포기 결정(adapter-contract §4)에 따른 우아한 격하 —
   * 입력성 요청(confirm/select/input/editor)은 취소 응답으로 하네스 대기를 풀고,
   * 표시성 요청은 무시한다. 전용 승인 프레임 도입 시 재검토 (COMPAT 여지).
   */
  protected handleUiRequest(frame: Record<string, unknown>): void {
    const method = frame.method;
    if (method === 'confirm' || method === 'select' || method === 'input' || method === 'editor') {
      this.transport.send({
        type: 'extension_ui_response',
        id: String(frame.id ?? ''),
        cancelled: true,
      });
    }
  }
}

export class OmpAdapter implements AgentAdapter {
  readonly id = 'omp' as const;
  /**
   * 실측(oh-my-pi 17.3.8) + 1차 결정 기준.
   * 설계표(adapter-contract §2) 대비 하향분 — 하네스 RPC 는 실존하나 계약에 메서드가 없어
   * 보류(pi 와 동일 논리, 개정 포인트): steering(steer), compaction(compact),
   * nativeToolRegistration(set_host_tools). runtimePermission 은 §4 결정대로 false.
   */
  readonly capabilities = {
    streaming: true,
    reasoningStream: true,
    sessionResume: true,
    runtimePermission: false,
    modelSwitch: true,
    mcpInjection: false,
    nativeToolRegistration: false,
    steering: false,
    usageReporting: true,
    compaction: false,
  };

  constructor(private readonly options: OmpAdapterOptions) {}

  async probe(): Promise<ProbeResult> {
    try {
      const managed = await this.options.supervisor.spawn({
        command: this.options.command,
        args: [...(this.options.prependArgs ?? []), '--version'],
        harness: 'omp',
      });
      let out = '';
      managed.child.stdout?.on('data', (chunk: Buffer) => (out += String(chunk)));
      const exit = await managed.exited;
      if (exit.code !== 0) {
        return { available: false, warnings: [`omp --version 종료 코드 ${exit.code}`] };
      }
      return {
        available: true,
        version: out.trim().replace(/^omp\//, ''),
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
    return this.spawnSession(config, [], { resumed: false });
  }

  async resumeSession(handle: PersistenceHandle, config: SessionConfig): Promise<AgentSession> {
    if (typeof handle.nativeHandle !== 'string' || !handle.nativeHandle) {
      throw new AdapterError('protocol', 'omp 재개에는 세션 파일 경로 핸들이 필요');
    }
    return this.spawnSession(config, ['--session', handle.nativeHandle], { resumed: true });
  }

  /** 게이트웨이 모델 카탈로그(FR-2.4)는 2.3.4 — 그 전까지 빈 목록 */
  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  private async spawnSession(
    config: SessionConfig,
    extraArgs: string[],
    flags: { resumed: boolean },
  ): Promise<AgentSession> {
    if (config.mcpServers && config.mcpServers.length > 0) {
      // capability 미지원 무시 금지 규칙 (adapter-contract §2) — 세션 단위 MCP 주입 경로 없음
      throw new AdapterError(
        'unsupported',
        'omp 어댑터는 세션 단위 MCP 주입 미지원 (host tools 대체는 보류)',
      );
    }
    const args = [
      ...(this.options.prependArgs ?? []),
      '--mode',
      'rpc-ui',
      '--approval-mode',
      approvalModeFor(config.approvalPolicy),
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
        harness: 'omp',
      });
    } catch (error) {
      throw new AdapterError('spawn', error instanceof Error ? error.message : String(error));
    }
    const session = new OmpSession(config, managed, {
      responseTimeoutMs: this.options.responseTimeoutMs,
      readyTimeoutMs: this.options.readyTimeoutMs,
    });
    if (flags.resumed) session.markResumed();
    try {
      await session.negotiate();
      await session.loadState();
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }
}
