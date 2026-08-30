// 터미널 바이너리 프레임 (protocol-design v1.2 §1, workbench-tabs §2.2).
//
// 같은 소켓에 JSON 텍스트와 바이너리를 혼재한다. 터미널 I/O 를 JSON 으로 감싸면 매 키 입력마다
// 인코딩 왕복과 이스케이프 비용이 붙는다 — 바이트는 바이트로 보낸다.
//
// 이 파일은 zod 검증 대상이 아니다(순수성 게이트는 JSON 와이어 스키마의 규칙). 대신 검증 실패를
// 예외가 아니라 `undefined` 로 다룬다 — 프레임 하나가 깨졌다고 연결을 끊지 않는다.
import { z } from 'zod';

export const TERMINAL_OPCODE = {
  /** 데몬 → 클라이언트: 터미널 출력 */
  output: 0x01,
  /** 클라이언트 → 데몬: 터미널 입력 */
  input: 0x02,
} as const;
export type TerminalOpcode = (typeof TERMINAL_OPCODE)[keyof typeof TERMINAL_OPCODE];

/** 슬롯은 연결 단위 1바이트 핸들 — 매 프레임에 문자열 ID 를 싣지 않기 위한 장치 */
export const TERMINAL_SLOT_MAX = 255;

export interface TerminalFrame {
  opcode: TerminalOpcode;
  slot: number;
  payload: Uint8Array;
}

function isOpcode(value: number): value is TerminalOpcode {
  return value === TERMINAL_OPCODE.output || value === TERMINAL_OPCODE.input;
}

export function encodeTerminalFrame(frame: TerminalFrame): Uint8Array {
  if (!Number.isInteger(frame.slot) || frame.slot < 0 || frame.slot > TERMINAL_SLOT_MAX) {
    throw new RangeError(`터미널 슬롯 범위 밖: ${frame.slot}`);
  }
  const out = new Uint8Array(frame.payload.length + 2);
  out[0] = frame.opcode;
  out[1] = frame.slot;
  out.set(frame.payload, 2);
  return out;
}

/** 미지 opcode·길이 부족은 조용히 버린다 (관대 파싱, NFR-5) */
export function decodeTerminalFrame(data: Uint8Array): TerminalFrame | undefined {
  if (data.length < 2) return undefined;
  const opcode = data[0]!;
  if (!isOpcode(opcode)) return undefined;
  return { opcode, slot: data[1]!, payload: data.subarray(2) };
}

// ── 터미널 레코드·이벤트 (JSON 측) ─────────────────────────────────────────

export const TerminalSchema = z.looseObject({
  id: z.string(),
  workspaceId: z.string(),
  /** 실행 중인 셸 경로 */
  shell: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  createdAt: z.string(),
  /** 감독 터미널의 표시 이름 (워크스페이스 스크립트 — WBS 6.6) */
  label: z.string().optional(),
  /** 종료된 터미널은 목록에 남되 재사용되지 않는다 */
  exitedAt: z.string().optional(),
  exitCode: z.number().int().optional(),
});
export type Terminal = z.infer<typeof TerminalSchema>;

export const TerminalEventSchema = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('terminal_changed'),
    reason: z.enum(['created', 'exited', 'killed']),
    terminal: TerminalSchema,
  }),
]);
export type TerminalEvent = z.infer<typeof TerminalEventSchema>;
