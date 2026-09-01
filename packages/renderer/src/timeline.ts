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
  | { kind: 'user'; seq: number; turnId: string; text: string }
  | {
      kind: 'assistant';
      /** 이 항목을 **연** 이벤트의 seq — 검색 결과에서 찾아오는 앵커 (M7 7.4.2) */
      seq: number;
      turnId: string;
      text: string;
      reasoning: string;
      status: 'running' | 'completed' | 'failed' | 'canceled';
      errorMessage?: string;
      /** 턴별 토큰 (FR-3.7, WBS 2.4.5) — turn_completed usage */
      usage?: Usage;
    }
  | {
      kind: 'tool';
      seq: number;
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
      seq: number;
      request: PermissionRequest;
      status: 'pending' | 'resolved';
      outcome?: PermissionOutcome;
    };

export interface SessionView {
  status: SessionStatus;
  /** 마지막 반영 seq — 재동기화 요청 기준점 (fromSeq = lastSeq + 1) */
  lastSeq: number;
  items: TimelineItem[];
  /** 마지막 턴 usage (표시용) */
  usage?: Usage;
  /** 세션 누적 토큰 (FR-3.7) — turn_completed usage.totalTokens 합산 */
  totalTokens?: number;
  activeTurnId?: string;
  lastError?: string;
  /**
   * 검색 결과에서 찾아온 자리 (M7 7.4.2) — 대화 뷰가 여기로 스크롤한다.
   * 세그먼트를 연 이벤트의 seq 라 **그 이하 중 가장 큰** 항목이 목표다: 어시스턴트 항목은
   * `turn_started` 에서 만들어지고 세그먼트 앵커는 첫 델타라 seq 가 정확히 같지 않다.
   */
  focusSeq?: number;
}

export function emptySessionView(status: SessionStatus = 'initializing'): SessionView {
  return { status, lastSeq: -1, items: [] };
}

function replaceItem(items: TimelineItem[], index: number, next: TimelineItem): TimelineItem[] {
  const copy = items.slice();
  copy[index] = next;
  return copy;
}

/**
 * 델타를 시간순 세그먼트로 누적한다 — 마지막 아이템이 이 턴의 열린 assistant 일 때만 이어 붙이고,
 * 툴/승인 카드가 끼어든 뒤(또는 turn_started 방어 경로)는 새 세그먼트를 연다.
 * 한 말풍선에 턴 전체를 몰아 붙이면 툴 카드들이 쌓인 뒤 도착하는 최종 답변이
 * 화면 위로 밀려 보이지 않는다 (2026-08-25 실사용 보고).
 */
function appendToAssistant(
  view: SessionView,
  turnId: string | undefined,
  field: 'text' | 'reasoning',
  delta: string,
): SessionView {
  const id = turnId ?? view.activeTurnId ?? 'unknown-turn';
  const last = view.items[view.items.length - 1];
  if (last && last.kind === 'assistant' && last.turnId === id && last.status === 'running') {
    return {
      ...view,
      items: replaceItem(view.items, view.items.length - 1, {
        ...last,
        [field]: last[field] + delta,
      }),
    };
  }
  return {
    ...view,
    activeTurnId: id,
    items: [
      ...view.items,
      // turn_started 없이 델타가 먼저 온 경로 — 이 항목을 연 이벤트가 곧 지금 이벤트다
      {
        kind: 'assistant',
        seq: view.lastSeq,
        turnId: id,
        text: '',
        reasoning: '',
        status: 'running',
        [field]: delta,
      },
    ],
  };
}

function closeTurn(
  view: SessionView,
  turnId: string,
  status: 'completed' | 'failed' | 'canceled',
  options: { errorMessage?: string; usage?: Usage } = {},
): SessionView {
  const next: SessionView = { ...view };
  delete next.activeTurnId;
  // 세션 누적 토큰 (FR-3.7) — 턴 종료 시점에만 합산 (중간 usage_updated 와 이중 집계 방지)
  if (options.usage?.totalTokens !== undefined) {
    next.totalTokens = (view.totalTokens ?? 0) + options.usage.totalTokens;
  }
  // 세그먼트 전부 닫되, 최종 상태·에러·usage 는 마지막 세그먼트에만 — 마커·턴별 토큰 중복 방지
  let lastIndex = -1;
  view.items.forEach((item, i) => {
    if (item.kind === 'assistant' && item.turnId === turnId) lastIndex = i;
  });
  if (lastIndex < 0) return next;
  return {
    ...next,
    items: view.items.map((item, i) => {
      if (item.kind !== 'assistant' || item.turnId !== turnId) return item;
      if (i !== lastIndex)
        return item.status === 'running' ? { ...item, status: 'completed' } : item;
      return {
        ...item,
        status,
        ...(options.errorMessage !== undefined ? { errorMessage: options.errorMessage } : {}),
        ...(options.usage !== undefined ? { usage: options.usage } : {}),
      };
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
        items: [
          ...base.items,
          { kind: 'user', seq: event.seq, turnId: event.turnId, text: event.text },
        ],
      };
    case 'turn_started':
      return {
        ...base,
        activeTurnId: event.turnId,
        items: [
          ...base.items,
          {
            kind: 'assistant',
            seq: event.seq,
            turnId: event.turnId,
            text: '',
            reasoning: '',
            status: 'running',
          },
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
        {
          ...(event.usage !== undefined ? { usage: event.usage } : {}),
        },
      );
    case 'turn_failed':
      return closeTurn(base, event.turnId, 'failed', { errorMessage: event.error.message });
    case 'turn_canceled':
      return closeTurn(base, event.turnId, 'canceled');
    case 'tool_execution_started':
      return {
        ...base,
        items: [
          ...base.items,
          {
            kind: 'tool',
            seq: event.seq,
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
        items: [
          ...base.items,
          { kind: 'permission', seq: event.seq, request: event.request, status: 'pending' },
        ],
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
