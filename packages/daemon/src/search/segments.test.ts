import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@custom-harness/protocol';
import { SegmentAccumulator, segmentTimeline } from './segments.js';

let seq = 0;
const event = (partial: Omit<SessionEvent, 'sessionId' | 'seq'>): SessionEvent =>
  ({ sessionId: 's-1', seq: seq++, ...partial }) as SessionEvent;

const reset = (): void => {
  seq = 0;
};

describe('segmentTimeline', () => {
  it('델타 조각을 합쳐 하나의 검색 단위로 만든다', () => {
    reset();
    // 검색어가 델타 경계에 걸리는 경우 — 원본 줄에는 이 문자열이 없다
    const segments = segmentTimeline([
      event({ type: 'turn_started', turnId: 't-1' }),
      event({ type: 'message_delta', turnId: 't-1', delta: '인덱' }),
      event({ type: 'message_delta', turnId: 't-1', delta: '스 전략을 정한다' }),
      event({ type: 'turn_completed', turnId: 't-1' }),
    ]);
    expect(segments).toEqual([
      { sessionId: 's-1', seq: 1, kind: 'assistant', text: '인덱스 전략을 정한다' },
    ]);
  });

  it('사용자 메시지와 툴 실행을 각각의 세그먼트로 남긴다', () => {
    reset();
    const segments = segmentTimeline([
      event({ type: 'user_message', turnId: 't-1', text: '전문 검색 붙여줘' }),
      event({
        type: 'tool_execution_started',
        toolCallId: 'c-1',
        kind: 'edit',
        toolName: 'apply_patch',
        summary: 'search/index-store.ts 수정',
        rawInput: { path: 'packages/daemon/src/search/index-store.ts' },
      }),
    ]);
    expect(segments.map((s) => s.kind)).toEqual(['user', 'tool']);
    expect(segments[0]?.text).toBe('전문 검색 붙여줘');
    // rawInput 을 싣는 이유 — "그 파일 어디서 고쳤지" 의 답이 거기에 있다
    expect(segments[1]?.text).toContain('packages/daemon/src/search/index-store.ts');
    expect(segments[1]?.toolName).toBe('apply_patch');
  });

  it('사고와 발화를 섞지 않는다', () => {
    reset();
    const segments = segmentTimeline([
      event({ type: 'reasoning_delta', turnId: 't-1', delta: '먼저 인덱' }),
      event({ type: 'message_delta', turnId: 't-1', delta: '스를 만든다' }),
      event({ type: 'turn_completed', turnId: 't-1' }),
    ]);
    // 이어 붙였다면 '인덱스' 가 생겨 가짜 매치가 된다
    expect(segments).toEqual([
      { sessionId: 's-1', seq: 0, kind: 'reasoning', text: '먼저 인덱' },
      { sessionId: 's-1', seq: 1, kind: 'assistant', text: '스를 만든다' },
    ]);
  });

  it('툴 실행이 끼어들면 앞의 텍스트를 먼저 확정한다', () => {
    reset();
    const segments = segmentTimeline([
      event({ type: 'message_delta', turnId: 't-1', delta: '파일을 읽는다' }),
      event({ type: 'tool_execution_started', toolCallId: 'c-1', kind: 'read', toolName: 'read' }),
      event({ type: 'message_delta', turnId: 't-1', delta: '다 읽었다' }),
      event({ type: 'turn_completed', turnId: 't-1' }),
    ]);
    expect(segments.map((s) => s.text)).toEqual(['파일을 읽는다', 'read', '다 읽었다']);
  });

  it('턴이 끝나지 않아도 마지막 버퍼를 잃지 않는다', () => {
    reset();
    const segments = segmentTimeline([
      event({ type: 'message_delta', turnId: 't-1', delta: '아직 진행 중' }),
    ]);
    expect(segments).toEqual([
      { sessionId: 's-1', seq: 0, kind: 'assistant', text: '아직 진행 중' },
    ]);
  });

  it('빈 텍스트는 행을 만들지 않는다', () => {
    reset();
    expect(
      segmentTimeline([
        event({ type: 'user_message', turnId: 't-1', text: '   ' }),
        event({ type: 'message_delta', turnId: 't-1', delta: '\n\n' }),
        event({ type: 'turn_completed', turnId: 't-1' }),
      ]),
    ).toEqual([]);
  });
});

describe('SegmentAccumulator', () => {
  it('폴드와 스트림이 같은 결과를 낸다', () => {
    reset();
    const events = [
      event({ type: 'user_message', turnId: 't-1', text: '검색 붙여줘' }),
      event({ type: 'message_delta', turnId: 't-1', delta: '알겠' }),
      event({ type: 'message_delta', turnId: 't-1', delta: '다' }),
      event({ type: 'turn_completed', turnId: 't-1' }),
    ];
    const accumulator = new SegmentAccumulator();
    const streamed = events.flatMap((e) => accumulator.push(e));
    expect(streamed).toEqual(segmentTimeline(events));
  });
});
