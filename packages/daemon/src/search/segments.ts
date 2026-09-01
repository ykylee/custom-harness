// 검색 코퍼스 조립 (M7 WBS 7.4.1, FR-9.4) — 타임라인 이벤트를 **검색 가능한 단위**로 합친다.
//
// 왜 원본 타임라인을 그대로 색인하지 않는가: `message_delta` 는 조각이다. 어시스턴트가
// "인덱스 전략" 이라고 말해도 델타 경계가 "인덱" / "스 전략" 으로 갈리면 원본 줄을 아무리
// 뒤져도 그 문자열은 어디에도 없다. 검색 대상은 델타가 아니라 **합쳐진 텍스트**여야 한다.
// 부수 효과로 색인 대상 바이트가 한 자릿수 % 로 줄어든다(엔진 선택과 무관하게 이득).
//
// 누적기(accumulator)를 하나만 두고 두 경로가 함께 쓴다 — 기동 시 재색인(파일 전량 폴드)과
// 실행 중 색인(이벤트 스트림). 두 벌로 구현하면 경계 처리가 반드시 갈라진다.
import type { SessionEvent } from '@custom-harness/protocol';

/** 검색 결과의 한 행. `seq` 는 이 세그먼트를 **여는** 이벤트의 seq — 타임라인 점프 앵커다 */
export interface SearchSegment {
  sessionId: string;
  seq: number;
  kind: SearchSegmentKind;
  text: string;
  /** tool 세그먼트의 하네스 네이티브 툴명 */
  toolName?: string;
}

export const SEARCH_SEGMENT_KINDS = ['user', 'assistant', 'reasoning', 'tool'] as const;
export type SearchSegmentKind = (typeof SEARCH_SEGMENT_KINDS)[number];

/**
 * 툴 입력 직렬화 상한. 툴 `rawInput` 을 넣는 이유는 실사용 질의가 대개 거기에 있기 때문이다 —
 * "그 파일 어느 세션에서 고쳤지" 의 파일 경로, "그 명령 뭐였지" 의 셸 명령줄. 다만 임의 JSON 이라
 * 상한 없이 실으면 코퍼스가 원본 타임라인만큼 커진다.
 */
const RAW_INPUT_LIMIT = 2000;

/**
 * 이벤트를 밀어 넣으면 **완성된** 세그먼트만 돌려주는 누적기.
 *
 * 델타는 완성 시점을 스스로 알리지 않는다(종료 이벤트가 따로 없다). 그래서 "다른 종류의
 * 사건이 왔다" 를 경계로 삼는다 — 툴 실행이 시작됐거나, 사용자가 말했거나, 턴이 끝났거나.
 */
export class SegmentAccumulator {
  /** 진행 중인 텍스트 버퍼 — 종류가 바뀌는 순간 확정된다 */
  private pending: { kind: 'assistant' | 'reasoning'; seq: number; parts: string[] } | undefined;

  push(event: SessionEvent): SearchSegment[] {
    switch (event.type) {
      case 'message_delta':
        return this.appendDelta(event.sessionId, event.seq, 'assistant', event.delta);
      case 'reasoning_delta':
        return this.appendDelta(event.sessionId, event.seq, 'reasoning', event.delta);
      case 'user_message': {
        // 사용자 메시지는 한 이벤트가 곧 한 세그먼트다 — 도착 즉시 확정된다
        const flushed = this.flush(event.sessionId);
        const text = event.text.trim();
        return text === ''
          ? flushed
          : [...flushed, { sessionId: event.sessionId, seq: event.seq, kind: 'user', text }];
      }
      case 'tool_execution_started': {
        const flushed = this.flush(event.sessionId);
        const text = toolText(event.toolName, event.summary, event.rawInput);
        if (text === '') return flushed;
        return [
          ...flushed,
          {
            sessionId: event.sessionId,
            seq: event.seq,
            kind: 'tool',
            text,
            ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
          },
        ];
      }
      case 'turn_completed':
      case 'turn_failed':
      case 'turn_canceled':
        return this.flush(event.sessionId);
      default:
        return [];
    }
  }

  /** 남은 버퍼 확정 — 폴드의 마지막, 그리고 세션이 조용해질 때 호출한다 */
  flush(sessionId: string): SearchSegment[] {
    const pending = this.pending;
    this.pending = undefined;
    if (pending === undefined) return [];
    const text = pending.parts.join('').trim();
    if (text === '') return [];
    return [{ sessionId, seq: pending.seq, kind: pending.kind, text }];
  }

  private appendDelta(
    sessionId: string,
    seq: number,
    kind: 'assistant' | 'reasoning',
    delta: string,
  ): SearchSegment[] {
    // 종류가 바뀌면(사고 → 발화) 앞의 버퍼를 확정한다. 섞으면 검색어가 두 흐름에 걸쳐
    // 우연히 매치되는 가짜 결과가 나온다.
    const flushed = this.pending?.kind === kind ? [] : this.flush(sessionId);
    if (this.pending === undefined) this.pending = { kind, seq, parts: [] };
    this.pending.parts.push(delta);
    return flushed;
  }
}

/** 타임라인 전량 → 세그먼트 전량. 기동 시 재색인 경로 (누적기와 같은 규칙을 쓴다) */
export function segmentTimeline(events: SessionEvent[]): SearchSegment[] {
  const accumulator = new SegmentAccumulator();
  const segments: SearchSegment[] = [];
  let lastSessionId: string | undefined;
  for (const event of events) {
    lastSessionId = event.sessionId;
    segments.push(...accumulator.push(event));
  }
  if (lastSessionId !== undefined) segments.push(...accumulator.flush(lastSessionId));
  return segments;
}

function toolText(
  toolName: string | undefined,
  summary: string | undefined,
  rawInput: unknown,
): string {
  const parts = [toolName, summary, serializeRawInput(rawInput)].filter(
    (part): part is string => part !== undefined && part.trim() !== '',
  );
  return parts.join(' ').trim();
}

function serializeRawInput(rawInput: unknown): string | undefined {
  if (rawInput === undefined || rawInput === null) return undefined;
  if (typeof rawInput === 'string') return rawInput.slice(0, RAW_INPUT_LIMIT);
  try {
    return JSON.stringify(rawInput)?.slice(0, RAW_INPUT_LIMIT);
  } catch {
    return undefined; // 순환 참조 등 — 색인은 보조 기능이라 조용히 건너뛴다
  }
}
