// 세션 명령 카탈로그 — 하네스가 알려 준 네이티브 슬래시 명령의 최소 공통 표현.
// 이 단계에서는 발견·삽입만 담당한다. 실행은 기존 session.prompt 원문 전달을 따른다.
import { z } from 'zod';

export const SessionCommandSourceSchema = z.enum(['harness']);
export type SessionCommandSource = z.infer<typeof SessionCommandSourceSchema>;

export const SessionCommandSchema = z.looseObject({
  /** 세션 안에서 안정적인 식별자 — 하네스 이름까지 포함해 충돌을 막는다. */
  id: z.string(),
  /** 컴포저에 넣을 슬래시 토큰. 항상 `/`로 시작한다. */
  name: z.string().regex(/^\/[\w-]+$/),
  title: z.string(),
  description: z.string().optional(),
  source: SessionCommandSourceSchema,
  /** 현재는 원문 프롬프트 전달만 검증됐다. 구조화 실행을 주장하지 않는다. */
  executionMode: z.literal('raw-prompt'),
});
export type SessionCommand = z.infer<typeof SessionCommandSchema>;
