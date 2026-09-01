import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@custom-harness/protocol';
import { applyEvent, applyEvents, emptySessionView } from './timeline.js';

const sid = 's-1';
let seq = 0;
function ev(body: Record<string, unknown>): SessionEvent {
  return { ...body, sessionId: sid, seq: seq++ } as unknown as SessionEvent;
}

function standardStream(): SessionEvent[] {
  seq = 0;
  return [
    ev({ type: 'session_status_changed', status: 'idle' }),
    ev({ type: 'user_message', turnId: 't-1', text: '파일 고쳐줘' }),
    ev({ type: 'turn_started', turnId: 't-1' }),
    ev({ type: 'session_status_changed', status: 'running' }),
    ev({ type: 'reasoning_delta', turnId: 't-1', delta: '분석 ' }),
    ev({ type: 'reasoning_delta', turnId: 't-1', delta: '중' }),
    ev({ type: 'message_delta', turnId: 't-1', delta: '안녕' }),
    ev({ type: 'message_delta', turnId: 't-1', delta: '하세요' }),
    ev({
      type: 'tool_execution_started',
      toolCallId: 'tc-1',
      kind: 'shell',
      toolName: 'bash',
      rawInput: { command: 'ls -al' },
    }),
    ev({ type: 'tool_execution_updated', toolCallId: 'tc-1', rawUpdate: { line: 1 } }),
    ev({ type: 'tool_execution_completed', toolCallId: 'tc-1', ok: true, rawOutput: { out: 'x' } }),
    ev({ type: 'usage_updated', usage: { totalTokens: 42 } }),
    ev({ type: 'turn_completed', turnId: 't-1', usage: { totalTokens: 42 } }),
    ev({ type: 'session_status_changed', status: 'idle' }),
  ];
}

describe('timeline reducer (FR-3.2 데이터 계층)', () => {
  it('folds a standard stream into ordered view items (mock 타임라인 재생)', () => {
    const view = applyEvents(emptySessionView(), standardStream());
    expect(view.status).toBe('idle');
    expect(view.lastSeq).toBe(13);
    expect(view.usage).toEqual({ totalTokens: 42 });
    expect(view.activeTurnId).toBeUndefined();

    expect(view.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool']);
    const [user, assistant, tool] = view.items;
    expect(user).toMatchObject({ text: '파일 고쳐줘' });
    expect(assistant).toMatchObject({
      text: '안녕하세요',
      reasoning: '분석 중',
      status: 'completed',
    });
    expect(tool).toMatchObject({ toolKind: 'shell', status: 'ok', rawOutput: { out: 'x' } });
  });

  it('drops duplicate/rewound seq — 재동기화 중복 방지', () => {
    const events = standardStream();
    const view = applyEvents(emptySessionView(), events);
    const replayed = applyEvents(view, events); // 전체 재적용
    expect(replayed).toEqual(view);
  });

  it('marks turn failure with the error message', () => {
    seq = 0;
    const view = applyEvents(emptySessionView(), [
      ev({ type: 'turn_started', turnId: 't-1' }),
      ev({ type: 'message_delta', turnId: 't-1', delta: '작업' }),
      ev({
        type: 'turn_failed',
        turnId: 't-1',
        error: { kind: 'auth', message: '게이트웨이 401' },
      }),
    ]);
    expect(view.items[0]).toMatchObject({ status: 'failed', errorMessage: '게이트웨이 401' });
  });

  it('tracks permission request → resolve lifecycle', () => {
    seq = 0;
    const request = {
      requestId: 'p-1',
      kind: 'shell' as const,
      summary: 'rm 실행',
      options: [{ optionId: 'allow', label: '허용', kind: 'allow_once' as const }],
    };
    let view = applyEvents(emptySessionView(), [ev({ type: 'permission_requested', request })]);
    expect(view.items[0]).toMatchObject({ kind: 'permission', status: 'pending' });
    view = applyEvent(
      view,
      ev({ type: 'permission_resolved', requestId: 'p-1', outcome: { optionId: 'allow' } }),
    );
    expect(view.items[0]).toMatchObject({ status: 'resolved', outcome: { optionId: 'allow' } });
  });

  it('creates an implicit assistant turn when a delta arrives first (방어)', () => {
    seq = 0;
    const view = applyEvents(emptySessionView(), [
      ev({ type: 'message_delta', turnId: 't-x', delta: '선행 델타' }),
    ]);
    expect(view.items[0]).toMatchObject({ kind: 'assistant', turnId: 't-x', text: '선행 델타' });
  });

  it('records per-turn usage and accumulates session totals (FR-3.7, WBS 2.4.5)', () => {
    seq = 0;
    const turn = (id: string, tokens: number) => [
      ev({ type: 'user_message', turnId: id, text: 'x' }),
      ev({ type: 'turn_started', turnId: id }),
      ev({ type: 'message_delta', turnId: id, delta: 'ok' }),
      // 턴 중간 usage_updated 는 누적에 이중 집계되지 않아야 한다
      ev({ type: 'usage_updated', usage: { totalTokens: tokens } }),
      ev({ type: 'turn_completed', turnId: id, usage: { totalTokens: tokens } }),
    ];
    const view = applyEvents(emptySessionView(), [...turn('t-1', 15), ...turn('t-2', 25)]);
    expect(view.totalTokens).toBe(40); // 세션 누적
    const assistants = view.items.filter((item) => item.kind === 'assistant');
    expect(assistants[0]).toMatchObject({ usage: { totalTokens: 15 } }); // 턴별
    expect(assistants[1]).toMatchObject({ usage: { totalTokens: 25 } });
  });

  it('splits assistant text into chronological segments around tool cards (2026-08-25 UX)', () => {
    seq = 0;
    const view = applyEvents(emptySessionView(), [
      ev({ type: 'user_message', turnId: 't-1', text: '고쳐줘' }),
      ev({ type: 'turn_started', turnId: 't-1' }),
      ev({ type: 'message_delta', turnId: 't-1', delta: '먼저 확인할게요' }),
      ev({ type: 'tool_execution_started', toolCallId: 'tc-1', kind: 'shell' }),
      ev({ type: 'tool_execution_completed', toolCallId: 'tc-1', ok: true }),
      ev({ type: 'message_delta', turnId: 't-1', delta: '결론: ' }),
      ev({ type: 'message_delta', turnId: 't-1', delta: '수정 완료' }),
      ev({ type: 'turn_completed', turnId: 't-1', usage: { totalTokens: 10 } }),
    ]);
    // 툴 카드 뒤 텍스트는 새 세그먼트 — 시간순 유지 (한 말풍선 누적이면 답변이 위로 밀림)
    expect(view.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(view.items[1]).toMatchObject({ text: '먼저 확인할게요', status: 'completed' });
    // 최종 상태·usage 는 마지막 세그먼트에만 부착 (마커·턴별 토큰 중복 방지)
    expect(view.items[1]).not.toHaveProperty('usage');
    expect(view.items[3]).toMatchObject({
      text: '결론: 수정 완료',
      status: 'completed',
      usage: { totalTokens: 10 },
    });
  });

  it('marks only the final segment canceled — 중단 마커 1회 표시', () => {
    seq = 0;
    const view = applyEvents(emptySessionView(), [
      ev({ type: 'turn_started', turnId: 't-1' }),
      ev({ type: 'message_delta', turnId: 't-1', delta: '진행 중' }),
      ev({ type: 'tool_execution_started', toolCallId: 'tc-1', kind: 'shell' }),
      ev({ type: 'message_delta', turnId: 't-1', delta: '이어서' }),
      ev({ type: 'turn_canceled', turnId: 't-1' }),
    ]);
    const assistants = view.items.filter((item) => item.kind === 'assistant');
    expect(assistants.map((a) => a.status)).toEqual(['completed', 'canceled']);
  });

  it('keeps session error detail from session_status_changed', () => {
    seq = 0;
    const view = applyEvents(emptySessionView(), [
      ev({
        type: 'session_status_changed',
        status: 'error',
        error: { kind: 'spawn', message: 'pi 비정상 종료' },
      }),
    ]);
    expect(view.status).toBe('error');
    expect(view.lastError).toBe('pi 비정상 종료');
  });
});

describe('타임라인 항목의 seq 앵커 (M7 7.4.2)', () => {
  it('각 항목이 자기를 연 이벤트의 seq 를 들고 있다', () => {
    const view = applyEvents(emptySessionView(), standardStream());
    // 검색 결과가 찾아올 자리 — 없으면 7.4.1 의 앵커가 내릴 곳이 없다
    expect(view.items.map((item) => item.seq)).toEqual([1, 2, 8]);
  });

  it('어시스턴트 항목은 turn_started 에서 열린다 — 세그먼트 앵커보다 이르다', () => {
    // 그래서 대화 뷰는 "앵커 이하 중 가장 큰" 항목을 찾는다(정확히 같은 값을 찾지 않는다)
    const view = applyEvents(emptySessionView(), standardStream());
    const assistant = view.items.find((item) => item.kind === 'assistant');
    expect(assistant?.seq).toBe(2); // 첫 message_delta 는 seq 6
  });

  it('turn_started 없이 델타가 먼저 와도 앵커를 잃지 않는다', () => {
    seq = 0;
    const view = applyEvents(emptySessionView(), [
      ev({ type: 'message_delta', turnId: 't-1', delta: '먼저 온 델타' }),
    ]);
    expect(view.items[0]?.seq).toBe(0);
  });

  it('permission 항목도 앵커를 갖는다', () => {
    seq = 0;
    const view = applyEvents(emptySessionView(), [
      ev({
        type: 'permission_requested',
        request: { requestId: 'r-1', kind: 'shell', summary: 'rm', options: [] },
      }),
    ]);
    expect(view.items[0]?.seq).toBe(0);
  });
});
