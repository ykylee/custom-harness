// 타임라인 뷰 모델 리듀서 (WBS 1.5.3~1.5.5 데이터 계층, FR-3.2)
// 와이어 이벤트 스트림(SessionEvent)을 렌더링 아이템으로 접는다 — 순수 함수, 불변 갱신.
// seq 중복·역행 이벤트는 드롭한다 (재연결 재동기화 시 중복 방지, protocol-design §5).
import type {
  PermissionOutcome,
  PermissionRequest,
  SessionEvent,
  SessionStatus,
  ToolKind,
  Usage,
} from '@custom-harness/protocol';

export type TimelineItem =
  | { kind: 'user'; turnId: string; text: string }
  | {
      kind: 'assistant';
      turnId: string;
      text: string;
      reasoning: string;
      status: 'running' | 'completed' | 'failed' | 'canceled';
      errorMessage?: string;
    }
  | {
      kind: 'tool';
      toolCallId: string;
      toolKind: ToolKind;
      toolName?: string;
      summary?: string;
      status: 'running' | 'ok' | 'error';
      rawInput?: unknown;
      rawOutput?: unknown;
    }
  | {
      kind: 'permission';
      request: PermissionRequest;
      status: 'pending' | 'resolved';
      outcome?: PermissionOutcome;
    };

export interface SessionView {
  status: SessionStatus;
  /** 마지막 반영 seq — 재동기화 요청 기준점 (fromSeq = lastSeq + 1) */
  lastSeq: number;
  items: TimelineItem[];
  usage?: Usage;
  activeTurnId?: string;
  lastError?: string;
}

export function emptySessionView(status: SessionStatus = 'initializing'): SessionView {
  return { status, lastSeq: -1, items: [] };
}

function replaceItem(items: TimelineItem[], index: number, next: TimelineItem): TimelineItem[] {
  const copy = items.slice();
  copy[index] = next;
  return copy;
}

/** 델타가 turn_started 보다 먼저 도착하는 방어 — 열린 assistant 턴이 없으면 만든다 */
function ensureAssistant(view: SessionView, turnId: string | undefined): SessionView {
  const id = turnId ?? view.activeTurnId ?? 'unknown-turn';
  const index = view.items.findIndex(
    (item) => item.kind === 'assistant' && item.turnId === id && item.status === 'running',
  );
  if (index >= 0) return view;
  return {
    ...view,
    activeTurnId: id,
    items: [
      ...view.items,
      { kind: 'assistant', turnId: id, text: '', reasoning: '', status: 'running' },
    ],
  };
}

function appendToAssistant(
  view: SessionView,
  turnId: string | undefined,
  field: 'text' | 'reasoning',
  delta: string,
): SessionView {
  const ensured = ensureAssistant(view, turnId);
  const id = turnId ?? ensured.activeTurnId ?? 'unknown-turn';
  const index = ensured.items.findIndex(
    (item) => item.kind === 'assistant' && item.turnId === id && item.status === 'running',
  );
  const item = ensured.items[index];
  if (!item || item.kind !== 'assistant') return ensured;
  return {
    ...ensured,
    items: replaceItem(ensured.items, index, { ...item, [field]: item[field] + delta }),
  };
}

function closeTurn(
  view: SessionView,
  turnId: string,
  status: 'completed' | 'failed' | 'canceled',
  errorMessage?: string,
): SessionView {
  const index = view.items.findIndex((item) => item.kind === 'assistant' && item.turnId === turnId);
  const next: SessionView = { ...view };
  delete next.activeTurnId;
  if (index < 0) return next;
  const item = view.items[index];
  if (!item || item.kind !== 'assistant') return next;
  return {
    ...next,
    items: replaceItem(view.items, index, {
      ...item,
      status,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    }),
  };
}

export function applyEvent(view: SessionView, event: SessionEvent): SessionView {
  if (event.seq <= view.lastSeq) return view; // 중복·역행 드롭
  const base: SessionView = { ...view, lastSeq: event.seq };

  switch (event.type) {
    case 'user_message':
      return {
        ...base,
        items: [...base.items, { kind: 'user', turnId: event.turnId, text: event.text }],
      };
    case 'turn_started':
      return {
        ...base,
        activeTurnId: event.turnId,
        items: [
          ...base.items,
          { kind: 'assistant', turnId: event.turnId, text: '', reasoning: '', status: 'running' },
        ],
      };
    case 'message_delta':
      return appendToAssistant(base, event.turnId, 'text', event.delta);
    case 'reasoning_delta':
      return appendToAssistant(base, event.turnId, 'reasoning', event.delta);
    case 'turn_completed':
      return closeTurn(
        event.usage ? { ...base, usage: event.usage } : base,
        event.turnId,
        'completed',
      );
    case 'turn_failed':
      return closeTurn(base, event.turnId, 'failed', event.error.message);
    case 'turn_canceled':
      return closeTurn(base, event.turnId, 'canceled');
    case 'tool_execution_started':
      return {
        ...base,
        items: [
          ...base.items,
          {
            kind: 'tool',
            toolCallId: event.toolCallId,
            toolKind: event.kind,
            ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
            ...(event.summary !== undefined ? { summary: event.summary } : {}),
            status: 'running',
            ...(event.rawInput !== undefined ? { rawInput: event.rawInput } : {}),
          },
        ],
      };
    case 'tool_execution_updated': {
      const index = base.items.findIndex(
        (item) => item.kind === 'tool' && item.toolCallId === event.toolCallId,
      );
      const item = base.items[index];
      if (!item || item.kind !== 'tool') return base;
      return {
        ...base,
        items: replaceItem(base.items, index, { ...item, rawOutput: event.rawUpdate }),
      };
    }
    case 'tool_execution_completed': {
      const index = base.items.findIndex(
        (item) => item.kind === 'tool' && item.toolCallId === event.toolCallId,
      );
      const item = base.items[index];
      if (!item || item.kind !== 'tool') return base;
      return {
        ...base,
        items: replaceItem(base.items, index, {
          ...item,
          status: event.ok === false ? 'error' : 'ok',
          ...(event.rawOutput !== undefined ? { rawOutput: event.rawOutput } : {}),
        }),
      };
    }
    case 'permission_requested':
      return {
        ...base,
        items: [...base.items, { kind: 'permission', request: event.request, status: 'pending' }],
      };
    case 'permission_resolved': {
      const index = base.items.findIndex(
        (item) => item.kind === 'permission' && item.request.requestId === event.requestId,
      );
      const item = base.items[index];
      if (!item || item.kind !== 'permission') return base;
      return {
        ...base,
        items: replaceItem(base.items, index, {
          ...item,
          status: 'resolved',
          outcome: event.outcome,
        }),
      };
    }
    case 'usage_updated':
      return { ...base, usage: event.usage };
    case 'session_status_changed':
      return {
        ...base,
        status: event.status,
        ...(event.error !== undefined ? { lastError: event.error.message } : {}),
      };
    case 'error':
      return { ...base, lastError: event.error.message };
    default:
      return base;
  }
}

export function applyEvents(view: SessionView, events: SessionEvent[]): SessionView {
  return events.reduce(applyEvent, view);
}
