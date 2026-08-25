// 연결 레벨 봉투 — hello / hello.response / ping / pong (protocol-design §1·§3·§5)
import { z } from 'zod';
import { PROTOCOL_VERSION } from './base.js';
import { CapabilityFlagsSchema } from './capabilities.js';

/** 클라이언트 → 데몬. capabilities 의 미지 키는 보존 — 데몬이 다운그레이드 인코딩 선택 */
export const HelloSchema = z.looseObject({
  type: z.literal('hello'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  clientInfo: z.object({ name: z.string(), version: z.string() }),
  capabilities: CapabilityFlagsSchema,
});
export type Hello = z.infer<typeof HelloSchema>;

/** 데몬 → 클라이언트. features.* 는 렌더러가 단일 지점에서 검사 — 없으면 기능 숨김 */
export const HelloResponseSchema = z.looseObject({
  type: z.literal('hello.response'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  serverInfo: z.object({ name: z.string(), version: z.string() }),
  features: CapabilityFlagsSchema,
});
export type HelloResponse = z.infer<typeof HelloResponseSchema>;

/** 애플리케이션 레벨 ping/pong — 끊김 감지 (protocol-design §5). 양방향 공용 */
export const PingSchema = z.looseObject({ type: z.literal('ping') });
export const PongSchema = z.looseObject({ type: z.literal('pong') });
