import { describe, expect, it } from 'vitest';
import { TERMINAL_OPCODE, decodeTerminalFrame, encodeTerminalFrame } from './terminal.js';

describe('터미널 바이너리 프레임 (protocol-design v1.2 §1)', () => {
  it('왕복한다', () => {
    const payload = new TextEncoder().encode('ls -al\n');
    const encoded = encodeTerminalFrame({ opcode: TERMINAL_OPCODE.input, slot: 3, payload });
    const decoded = decodeTerminalFrame(encoded);
    expect(decoded?.opcode).toBe(TERMINAL_OPCODE.input);
    expect(decoded?.slot).toBe(3);
    expect(new TextDecoder().decode(decoded?.payload)).toBe('ls -al\n');
  });

  it('빈 페이로드도 유효하다', () => {
    const encoded = encodeTerminalFrame({
      opcode: TERMINAL_OPCODE.output,
      slot: 0,
      payload: new Uint8Array(),
    });
    expect(encoded).toHaveLength(2);
    expect(decodeTerminalFrame(encoded)?.payload).toHaveLength(0);
  });

  it('바이트를 그대로 보존한다 — UTF-8 경계로 자르지 않는다', () => {
    // 멀티바이트 문자가 프레임 경계에서 쪼개져도 바이트는 손상되지 않아야 한다
    const payload = new Uint8Array([0xed, 0x95, 0x9c, 0xed]); // '한' + 잘린 첫 바이트
    const decoded = decodeTerminalFrame(
      encodeTerminalFrame({ opcode: TERMINAL_OPCODE.output, slot: 7, payload }),
    );
    expect([...(decoded?.payload ?? [])]).toEqual([0xed, 0x95, 0x9c, 0xed]);
  });

  it('미지 opcode·길이 부족은 조용히 버린다 (관대 파싱)', () => {
    expect(decodeTerminalFrame(new Uint8Array([0x09, 0x00, 0x41]))).toBeUndefined();
    expect(decodeTerminalFrame(new Uint8Array([0x01]))).toBeUndefined();
    expect(decodeTerminalFrame(new Uint8Array())).toBeUndefined();
  });

  it('슬롯 범위를 벗어나면 인코딩을 거부한다', () => {
    const payload = new Uint8Array();
    expect(() =>
      encodeTerminalFrame({ opcode: TERMINAL_OPCODE.output, slot: 256, payload }),
    ).toThrow(RangeError);
    expect(() =>
      encodeTerminalFrame({ opcode: TERMINAL_OPCODE.output, slot: -1, payload }),
    ).toThrow(RangeError);
  });
});
