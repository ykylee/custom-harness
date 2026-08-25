// @custom-harness/protocol — 공통 기본 상수·식별자
import { z } from 'zod';

/** 와이어 버전은 올리지 않는다 — 진화는 capability 협상으로 (protocol-design §3) */
export const PROTOCOL_VERSION = 1 as const;

export const HarnessIdSchema = z.enum(['pi', 'omp', 'grok', 'mock']);
export type HarnessId = z.infer<typeof HarnessIdSchema>;
