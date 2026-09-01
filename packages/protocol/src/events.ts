// FR-1.4 스트리밍 이벤트 유니온 — 어댑터 이벤트(AgentEvent)와 와이어 이벤트(SessionEvent)는
// 동일 스키마를 공유하고, 데몬은 sessionId/seq 부여 외 재가공하지 않는다 (protocol-design §2).
// 파싱은 관대(loose) — 미지 필드는 보존한다 (FR-1.8, NFR-5).
import { z } from 'zod';

/** FR-1.3.5 세션 상태 모델 — closed 는 삭제가 아니라 "런타임 없음, 재개 가능" */
export const SessionStatusSchema = z.enum(['initializing', 'idle', 'running', 'closed', 'error']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/** FR-1.2.5 툴콜 중립 분류 — 매핑 불가는 other + 원본 페이로드 보존 (드롭 금지) */
export const ToolKindSchema = z.enum([
  'shell',
  'read',
  'edit',
  'write',
  'search',
  'fetch',
  'sub_agent',
  'plan',
  'other',
]);
export type ToolKind = z.infer<typeof ToolKindSchema>;

/** 어댑터 에러 분류 (adapter-contract §1 AdapterError) */
export const ErrorInfoSchema = z.looseObject({
  kind: z.enum(['spawn', 'protocol', 'auth', 'model', 'interrupted', 'unknown']),
  message: z.string(),
  retriable: z.boolean().optional(),
  nativeDetail: z.unknown().optional(),
});
export type ErrorInfo = z.infer<typeof ErrorInfoSchema>;

/** 토큰 사용량 (FR-3.7 데이터원) — 하네스별 편차는 optional 로 흡수 */
export const UsageSchema = z.looseObject({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

// ── 승인(권한) 중립 모델 (adapter-contract §4, FR-1.5) ─────────────────────

export const PermissionOptionKindSchema = z.enum([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
]);

export const PermissionOptionSchema = z.looseObject({
  optionId: z.string(),
  label: z.string(),
  kind: PermissionOptionKindSchema,
});

export const PermissionRequestSchema = z.looseObject({
  requestId: z.string(),
  kind: z.enum(['shell', 'file_write', 'fetch', 'mcp', 'other']),
  summary: z.string(),
  detail: z.unknown().optional(),
  options: z.array(PermissionOptionSchema),
  /**
   * 요청의 출처 (M7 7.2.4, FR-9.2). 생략 = `harness` — 이전 번들이 보내는 요청은 전부 그쪽이다.
   *
   * `reverse_tool` 은 **데몬이 스스로 만든** 요청이다: 역방향 툴의 write 5종을 실행하기 전에
   * 사용자에게 묻는다. 응답 경로가 다르다 — 하네스 요청은 어댑터로 되돌아가지만 이건 데몬
   * 안에서 끝난다. 같은 채널에 태우는 이유는 UI 다: 사이드바 배지·주의 상태·승인 카드가
   * 이미 이 채널을 소비하므로, 별도 채널을 만들면 그 전부를 두 번 구현하게 된다.
   */
  origin: z.enum(['harness', 'reverse_tool']).optional(),
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

export const PermissionOutcomeSchema = z.union([
  z.object({ optionId: z.string() }),
  z.object({ cancelled: z.literal(true) }),
]);
export type PermissionOutcome = z.infer<typeof PermissionOutcomeSchema>;

// ── 이벤트 본문 (어댑터 → 데몬) ────────────────────────────────────────────

/** turn_started 는 데몬(세션 매니저)이 직접 발행 — UI 낙관적 표시 회수 보장 (FR-1.4) */
const turnStarted = z.looseObject({ type: z.literal('turn_started'), turnId: z.string() });
const turnCompleted = z.looseObject({
  type: z.literal('turn_completed'),
  turnId: z.string(),
  usage: UsageSchema.optional(),
});
const turnFailed = z.looseObject({
  type: z.literal('turn_failed'),
  turnId: z.string(),
  error: ErrorInfoSchema,
});
const turnCanceled = z.looseObject({ type: z.literal('turn_canceled'), turnId: z.string() });

const messageDelta = z.looseObject({
  type: z.literal('message_delta'),
  turnId: z.string().optional(),
  delta: z.string(),
});
const reasoningDelta = z.looseObject({
  type: z.literal('reasoning_delta'),
  turnId: z.string().optional(),
  delta: z.string(),
});

const toolExecutionStarted = z.looseObject({
  type: z.literal('tool_execution_started'),
  toolCallId: z.string(),
  kind: ToolKindSchema,
  /** 하네스 네이티브 툴명 — 분류가 other 여도 원본 식별을 남긴다 */
  toolName: z.string().optional(),
  summary: z.string().optional(),
  rawInput: z.unknown().optional(),
});
const toolExecutionUpdated = z.looseObject({
  type: z.literal('tool_execution_updated'),
  toolCallId: z.string(),
  rawUpdate: z.unknown().optional(),
});
const toolExecutionCompleted = z.looseObject({
  type: z.literal('tool_execution_completed'),
  toolCallId: z.string(),
  ok: z.boolean().optional(),
  rawOutput: z.unknown().optional(),
});

const permissionRequested = z.looseObject({
  type: z.literal('permission_requested'),
  request: PermissionRequestSchema,
});
const permissionResolved = z.looseObject({
  type: z.literal('permission_resolved'),
  requestId: z.string(),
  outcome: PermissionOutcomeSchema,
});

const usageUpdated = z.looseObject({ type: z.literal('usage_updated'), usage: UsageSchema });
const sessionStatusChanged = z.looseObject({
  type: z.literal('session_status_changed'),
  status: SessionStatusSchema,
  error: ErrorInfoSchema.optional(),
});
const errorEvent = z.looseObject({ type: z.literal('error'), error: ErrorInfoSchema });
/**
 * 주의 상태 전이 (M7 7.1.2, FR-9.1) — 데몬의 단일 정책 모듈만 발행한다.
 * 사이드바 버킷·트레이 배지·OS 알림·자동 승인이 전부 이 하나를 소비한다.
 */
const attentionChanged = z.looseObject({
  type: z.literal('attention_changed'),
  requiresAttention: z.boolean(),
  attentionReason: z.enum(['permission', 'error', 'finished']).optional(),
  attentionTimestamp: z.string().optional(),
});

/**
 * 세션 제목 확정 (M7 7.6.1, FR-9.5) — 데몬 소유.
 *
 * 별도 이벤트를 둔 이유는 **도착 시점**이다. 휴리스틱 제목은 첫 프롬프트와 함께 정해지지만
 * LLM 제목은 임의의 시점에 온다. 세션 목록 갱신에 얹으면 그때까지 낡은 이름이 남는다.
 */
const titleChanged = z.looseObject({
  type: z.literal('session_title_changed'),
  title: z.string(),
});

/** 어댑터가 올리는 이벤트 — sessionId/seq 없음 (세션 스코프는 데몬이 부여) */
export const AgentEventSchema = z.discriminatedUnion('type', [
  turnStarted,
  turnCompleted,
  turnFailed,
  turnCanceled,
  messageDelta,
  reasoningDelta,
  toolExecutionStarted,
  toolExecutionUpdated,
  toolExecutionCompleted,
  permissionRequested,
  permissionResolved,
  usageUpdated,
  sessionStatusChanged,
  errorEvent,
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

// ── 와이어 이벤트 (데몬 → 클라이언트) ──────────────────────────────────────

/** seq 는 세션 단위 단조 증가 — 재연결 시 갭 감지 (protocol-design §2·§5) */
const wireEnvelope = { sessionId: z.string(), seq: z.number().int().nonnegative() };

/**
 * 사용자 메시지 타임라인 행 — 데몬(세션 매니저)이 발행·소유 (daemon-design §4).
 * FR-1.4 최소 집합의 additive 확장: 어댑터 유니온(AgentEvent)에는 없다.
 */
const userMessage = z.looseObject({
  type: z.literal('user_message'),
  turnId: z.string(),
  text: z.string(),
});

export const SessionEventSchema = z.discriminatedUnion('type', [
  userMessage.extend(wireEnvelope),
  turnStarted.extend(wireEnvelope),
  turnCompleted.extend(wireEnvelope),
  turnFailed.extend(wireEnvelope),
  turnCanceled.extend(wireEnvelope),
  messageDelta.extend(wireEnvelope),
  reasoningDelta.extend(wireEnvelope),
  toolExecutionStarted.extend(wireEnvelope),
  toolExecutionUpdated.extend(wireEnvelope),
  toolExecutionCompleted.extend(wireEnvelope),
  permissionRequested.extend(wireEnvelope),
  permissionResolved.extend(wireEnvelope),
  usageUpdated.extend(wireEnvelope),
  sessionStatusChanged.extend(wireEnvelope),
  errorEvent.extend(wireEnvelope),
  // 데몬 소유 — 어댑터 유니온(AgentEvent)에는 없다 (user_message 와 같은 층)
  attentionChanged.extend(wireEnvelope),
  titleChanged.extend(wireEnvelope),
]);
export type SessionEvent = z.infer<typeof SessionEventSchema>;
