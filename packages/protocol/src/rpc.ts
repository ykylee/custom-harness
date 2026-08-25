// 세션 레벨 RPC — `domain.verb.request` / `.response`, requestId 상관 (protocol-design §2)
// 도메인: session.* / config.* / harness.* / system.*
import { z } from 'zod';
import { HarnessIdSchema, PROTOCOL_VERSION } from './base.js';
import { CapabilityFlagsSchema } from './capabilities.js';
import {
  PermissionOutcomeSchema,
  PermissionRequestSchema,
  SessionEventSchema,
  SessionStatusSchema,
} from './events.js';

export const RpcErrorSchema = z.looseObject({
  /** 어댑터 에러 kind('spawn'|'protocol'|…) 또는 데몬 에러 코드 */
  code: z.string(),
  message: z.string(),
  retriable: z.boolean().optional(),
  detail: z.unknown().optional(),
});
export type RpcError = z.infer<typeof RpcErrorSchema>;

/** method 당 request/response 스키마 쌍 — 응답은 ok 판별 유니온 (성공 result / 실패 error) */
function rpcPair<M extends string, P extends z.ZodType, R extends z.ZodType>(
  method: M,
  params: P,
  result: R,
) {
  const request = z.looseObject({
    type: z.literal(`${method}.request` as const),
    requestId: z.string(),
    params,
  });
  const response = z.discriminatedUnion('ok', [
    z.looseObject({
      type: z.literal(`${method}.response` as const),
      requestId: z.string(),
      ok: z.literal(true),
      result,
    }),
    z.looseObject({
      type: z.literal(`${method}.response` as const),
      requestId: z.string(),
      ok: z.literal(false),
      error: RpcErrorSchema,
    }),
  ]);
  return { method, request, response };
}

// ── 공용 데이터 형 ─────────────────────────────────────────────────────────

export const SessionSummarySchema = z.looseObject({
  sessionId: z.string(),
  harness: HarnessIdSchema,
  cwd: z.string(),
  status: SessionStatusSchema,
  modelId: z.string().optional(),
  /** 마지막 이벤트 seq — 재연결 갭 감지 (protocol-design §5) */
  seq: z.number().int().nonnegative(),
  /** 미응답 승인 요청 — 데몬 재시작·재연결 후 조회 보장 (FR-1.5) */
  pendingPermissions: z.array(PermissionRequestSchema).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const ModelInfoSchema = z.looseObject({
  id: z.string(),
  displayName: z.string().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

/** probe 결과 (adapter-contract §1 ProbeResult — FR-1.8 버전 검증) */
export const ProbeResultSchema = z.looseObject({
  available: z.boolean(),
  version: z.string().optional(),
  verified: z.boolean().optional(),
  warnings: z.array(z.string()),
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

export const HarnessInfoSchema = z.looseObject({
  id: HarnessIdSchema,
  capabilities: CapabilityFlagsSchema,
  models: z.array(ModelInfoSchema).optional(),
});
export type HarnessInfo = z.infer<typeof HarnessInfoSchema>;

export const McpServerConfigSchema = z.looseObject({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

// ── method 정의 ────────────────────────────────────────────────────────────

export const rpc = {
  session: {
    create: rpcPair(
      'session.create',
      z.looseObject({
        harness: HarnessIdSchema,
        cwd: z.string(),
        modelId: z.string().optional(),
        approvalPolicy: z.enum(['mediate', 'auto']).optional(),
        mcpServers: z.array(McpServerConfigSchema).optional(),
      }),
      z.looseObject({ session: SessionSummarySchema }),
    ),
    resume: rpcPair(
      'session.resume',
      z.looseObject({ sessionId: z.string() }),
      z.looseObject({ session: SessionSummarySchema }),
    ),
    list: rpcPair(
      'session.list',
      z.looseObject({}),
      z.looseObject({ sessions: z.array(SessionSummarySchema) }),
    ),
    close: rpcPair('session.close', z.looseObject({ sessionId: z.string() }), z.looseObject({})),
    prompt: rpcPair(
      'session.prompt',
      z.looseObject({ sessionId: z.string(), prompt: z.string() }),
      z.looseObject({ turnId: z.string() }),
    ),
    /** 멱등 — 이미 중단됐거나 실행 중이 아니어도 성공 응답 (FR-1.6) */
    interrupt: rpcPair(
      'session.interrupt',
      z.looseObject({ sessionId: z.string() }),
      z.looseObject({}),
    ),
    permissionRespond: rpcPair(
      'session.permission.respond',
      z.looseObject({
        sessionId: z.string(),
        requestId: z.string(),
        outcome: PermissionOutcomeSchema,
      }),
      z.looseObject({}),
    ),
    modelSet: rpcPair(
      'session.model.set',
      z.looseObject({ sessionId: z.string(), modelId: z.string() }),
      z.looseObject({}),
    ),
    /** 재연결 갭 발생 시 타임라인 재동기화 (protocol-design §5) */
    timeline: rpcPair(
      'session.timeline',
      z.looseObject({ sessionId: z.string(), fromSeq: z.number().int().nonnegative().optional() }),
      z.looseObject({ events: z.array(SessionEventSchema) }),
    ),
  },
  config: {
    /** 게이트웨이 API 키 저장 (FR-2) — 키 값은 응답·이벤트에 되돌려 보내지 않는다 */
    keySet: rpcPair('config.key.set', z.looseObject({ apiKey: z.string() }), z.looseObject({})),
    keyTest: rpcPair(
      'config.key.test',
      z.looseObject({}),
      z.looseObject({ valid: z.boolean(), detail: z.string().optional() }),
    ),
    get: rpcPair(
      'config.get',
      z.looseObject({ keys: z.array(z.string()).optional() }),
      z.looseObject({ values: z.record(z.string(), z.unknown()) }),
    ),
    set: rpcPair(
      'config.set',
      z.looseObject({ values: z.record(z.string(), z.unknown()) }),
      z.looseObject({}),
    ),
  },
  harness: {
    list: rpcPair(
      'harness.list',
      z.looseObject({}),
      z.looseObject({ harnesses: z.array(HarnessInfoSchema) }),
    ),
    probe: rpcPair(
      'harness.probe',
      z.looseObject({ harness: HarnessIdSchema }),
      z.looseObject({ probe: ProbeResultSchema }),
    ),
  },
  system: {
    version: rpcPair(
      'system.version',
      z.looseObject({}),
      z.looseObject({ version: z.string(), protocolVersion: z.literal(PROTOCOL_VERSION) }),
    ),
    shutdown: rpcPair('system.shutdown', z.looseObject({}), z.looseObject({})),
  },
} as const;

// ── 수신 프레임 파싱용 집계 유니온 ─────────────────────────────────────────

export const RpcRequestSchema = z.discriminatedUnion('type', [
  rpc.session.create.request,
  rpc.session.resume.request,
  rpc.session.list.request,
  rpc.session.close.request,
  rpc.session.prompt.request,
  rpc.session.interrupt.request,
  rpc.session.permissionRespond.request,
  rpc.session.modelSet.request,
  rpc.session.timeline.request,
  rpc.config.keySet.request,
  rpc.config.keyTest.request,
  rpc.config.get.request,
  rpc.config.set.request,
  rpc.harness.list.request,
  rpc.harness.probe.request,
  rpc.system.version.request,
  rpc.system.shutdown.request,
]);
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

// 응답은 method 별로 ok 유니온이라 type 단일 판별이 불가 — z.union 으로 집계
export const RpcResponseSchema = z.union([
  rpc.session.create.response,
  rpc.session.resume.response,
  rpc.session.list.response,
  rpc.session.close.response,
  rpc.session.prompt.response,
  rpc.session.interrupt.response,
  rpc.session.permissionRespond.response,
  rpc.session.modelSet.response,
  rpc.session.timeline.response,
  rpc.config.keySet.response,
  rpc.config.keyTest.response,
  rpc.config.get.response,
  rpc.config.set.response,
  rpc.harness.list.response,
  rpc.harness.probe.response,
  rpc.system.version.response,
  rpc.system.shutdown.response,
]);
export type RpcResponse = z.infer<typeof RpcResponseSchema>;
