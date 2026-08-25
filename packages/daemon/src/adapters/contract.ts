// 어댑터 공통 계약 (docs/design/adapter-contract.md §1·§5)
// 전송(JSONL RPC / ACP)은 어댑터 내부에 숨는다. 이벤트는 protocol 패키지 스키마를 재사용한다.
import type {
  AgentEvent,
  CapabilityFlags,
  HarnessId,
  McpServerConfig,
  ModelInfo,
  PermissionOutcome,
  PermissionRequest,
  ProbeResult,
} from '@custom-harness/protocol';

export interface SessionConfig {
  /** 데몬 부여 세션 ID (계약서 §1 — 네이티브 ID 는 핸들에) */
  sessionId: string;
  cwd: string;
  modelId?: string;
  /** 데몬이 조립: 게이트웨이 키·오프라인 스위치·GROK_HOME 등 (FR-2.1.4) */
  env: Record<string, string>;
  /** capability 미지원 어댑터는 무시 금지 — AdapterError('unsupported') (§2 규칙) */
  mcpServers?: McpServerConfig[];
  approvalPolicy: 'mediate' | 'auto';
}

/** 영속 핸들 — meta.json 에 그대로 저장되므로 loose 스키마와 호환되는 형태 유지 */
export interface PersistenceHandle {
  harness: HarnessId;
  nativeHandle: unknown;
  metadata?: Record<string, unknown> | undefined;
  [key: string]: unknown;
}

export type Unsubscribe = () => void;

export interface AgentSession {
  readonly sessionId: string;
  startTurn(prompt: string): Promise<{ turnId: string }>;
  /** 하네스 유래 이벤트만 — turn_started·user_message 는 데몬(세션 매니저) 소유 (FR-1.4) */
  subscribe(listener: (event: AgentEvent) => void): Unsubscribe;
  /** 멱등 (FR-1.6) */
  interrupt(): Promise<void>;
  respondToPermission(requestId: string, outcome: PermissionOutcome): Promise<void>;
  getPendingPermissions(): Promise<PermissionRequest[]>;
  setModel?(modelId: string): Promise<void>;
  describeHandle(): PersistenceHandle;
  /** 프로세스 정리 — 세션은 재개 가능 상태(closed)로 남는다 */
  close(): Promise<void>;
}

export interface AgentAdapter {
  readonly id: HarnessId;
  /** 정적 선언 — probe() 가 버전에 따라 하향 보정 가능 (상향 금지) */
  readonly capabilities: CapabilityFlags;
  probe(): Promise<ProbeResult>;
  createSession(config: SessionConfig): Promise<AgentSession>;
  resumeSession(handle: PersistenceHandle, config: SessionConfig): Promise<AgentSession>;
  listModels(): Promise<ModelInfo[]>;
}

/** 'unsupported' 는 §2 미지원 기능 호출 규칙용 (silent no-op 금지) */
export type AdapterErrorKind =
  'spawn' | 'protocol' | 'auth' | 'model' | 'interrupted' | 'unsupported' | 'unknown';

export class AdapterError extends Error {
  readonly kind: AdapterErrorKind;
  readonly retriable: boolean;
  readonly nativeDetail: unknown;

  constructor(
    kind: AdapterErrorKind,
    message: string,
    opts: { retriable?: boolean; nativeDetail?: unknown } = {},
  ) {
    super(message);
    this.name = 'AdapterError';
    this.kind = kind;
    this.retriable = opts.retriable ?? false;
    this.nativeDetail = opts.nativeDetail;
  }
}
