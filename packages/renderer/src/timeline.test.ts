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
