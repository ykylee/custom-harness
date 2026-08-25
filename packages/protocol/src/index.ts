// @custom-harness/protocol — 와이어 스키마 단일 소스 (docs/design/protocol-design.md)
// 규칙: 와이어 스키마에 .transform()/.catch()/.preprocess() 금지 (순수성 — 검증과 변환 분리)
import { z } from 'zod';
import { HelloResponseSchema, HelloSchema, PingSchema, PongSchema } from './connection.js';
import { SessionEventSchema } from './events.js';
import { RpcRequestSchema, RpcResponseSchema } from './rpc.js';

export * from './base.js';
export * from './capabilities.js';
export * from './connection.js';
export * from './events.js';
export * from './rpc.js';

/** 클라이언트 → 데몬 전체 프레임 */
export const ClientMessageSchema = z.union([HelloSchema, PingSchema, PongSchema, RpcRequestSchema]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/** 데몬 → 클라이언트 전체 프레임 */
export const ServerMessageSchema = z.union([
  HelloResponseSchema,
  PingSchema,
  PongSchema,
  RpcResponseSchema,
  SessionEventSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
