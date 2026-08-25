// @custom-harness/protocol — 와이어 스키마 단일 소스 (docs/design/protocol-design.md)
// 규칙: 와이어 스키마에 .transform()/.catch()/.preprocess() 금지 (순수성 — 검증과 변환 분리)
import { z } from 'zod';

/** 와이어 버전은 올리지 않는다 — 진화는 capability 협상으로 (protocol-design §3) */
export const PROTOCOL_VERSION = 1 as const;

export const HarnessIdSchema = z.enum(['pi', 'omp', 'grok', 'mock']);
export type HarnessId = z.infer<typeof HarnessIdSchema>;

/** 연결 레벨 hello — 클라이언트 capability 는 알려지지 않은 키를 보존한다 */
export const HelloSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  clientInfo: z.object({ name: z.string(), version: z.string() }),
  capabilities: z.record(z.string(), z.boolean()),
});
export type Hello = z.infer<typeof HelloSchema>;

// 세션 이벤트·RPC 스키마는 WBS 1.1.2 에서 채운다 (FR-1.4 유니온).
