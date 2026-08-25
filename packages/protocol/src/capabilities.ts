// capability 플래그와 협상 헬퍼 (adapter-contract §2, protocol-design §3)
import { z } from 'zod';

/** 어댑터가 정적 선언하는 알려진 플래그 — 추가는 optional 로만, probe() 는 하향 보정만 가능 */
export const KNOWN_CAPABILITIES = [
  'streaming',
  'reasoningStream',
  'sessionResume',
  'runtimePermission',
  'modelSwitch',
  'mcpInjection',
  'nativeToolRegistration',
  'steering',
  'usageReporting',
  'compaction',
] as const;
export type KnownCapability = (typeof KNOWN_CAPABILITIES)[number];

/** 미지 키 보존 — 이전 번들의 클라이언트가 새 플래그를 만나도 파싱 가능해야 한다 */
export const CapabilityFlagsSchema = z.record(z.string(), z.boolean());
export type CapabilityFlags = z.infer<typeof CapabilityFlagsSchema>;

/**
 * 협상 단일 지점 — 부재·미지 키는 false. 플래그가 없으면 기능을 숨긴다
 * (폴백 경로 금지 — protocol-design §3).
 */
export function hasCapability(
  flags: CapabilityFlags | undefined,
  name: KnownCapability | (string & {}),
): boolean {
  return flags?.[name] === true;
}
