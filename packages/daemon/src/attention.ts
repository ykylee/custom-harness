// 주의(attention) 상태 정책 (M7 WBS 7.1.1, FR-9.1) — **단일 정책 지점**.
//
// 왜 데몬이 소유하는가: 지금까지 "사용자가 봐야 할 세션"은 렌더러가 세션 목록을 훑어
// 그때그때 계산했다. 그래서 ① 클라이언트가 없는 동안 생긴 주의 상태가 사라지고
// ② 사이드바 버킷·트레이 배지·OS 알림·자동 승인이 각자 다른 규칙으로 판단했다.
// 이 모듈이 그 규칙의 유일한 정본이고, 결과는 세션 레코드에 **영속 필드**로 남는다.
import type { SessionStatus } from '@custom-harness/protocol';

/** 우선순위가 곧 목록 순서다 — 앞이 급하다 */
export const ATTENTION_REASONS = ['permission', 'error', 'finished'] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

export interface AttentionState {
  requiresAttention: boolean;
  attentionReason?: AttentionReason;
  /** 주의 상태로 **전이한** 시각 (ISO). 같은 사유가 유지되면 갱신하지 않는다 */
  attentionTimestamp?: string;
}

export interface AttentionInput {
  status: SessionStatus;
  /** 미응답 승인 요청 수 */
  pendingPermissions: number;
  /** 마지막 턴이 종료로 끝났는가 (완료·실패·취소 중 완료/실패만 주의 대상) */
  lastTurnOutcome?: 'completed' | 'failed' | 'canceled' | undefined;
  /** 사용자가 이 세션을 확인한 뒤 새 사건이 없었는가 */
  acknowledged: boolean;
}

/**
 * 사유 우선순위: `permission` > `error` > `finished`.
 * 승인 대기는 **세션이 사용자를 기다리며 멈춰 있는** 상태라 가장 급하고, 에러는 개입이
 * 필요하며, 완료는 확인만 하면 된다.
 *
 * `acknowledged` 는 승인 대기를 덮지 못한다 — 사용자가 화면을 봤다는 사실이 응답을
 * 대신하지 않는다. 반대로 완료·에러는 확인하면 사라져야 한다.
 */
export function computeAttention(input: AttentionInput, previous?: AttentionState): AttentionState {
  const reason = resolveReason(input);
  if (reason === undefined) return { requiresAttention: false };
  return {
    requiresAttention: true,
    attentionReason: reason,
    // 같은 사유가 이어지면 최초 전이 시각을 보존한다 — "얼마나 기다렸나"가 정렬 기준이다
    attentionTimestamp:
      previous?.requiresAttention === true && previous.attentionReason === reason
        ? (previous.attentionTimestamp ?? new Date().toISOString())
        : new Date().toISOString(),
  };
}

function resolveReason(input: AttentionInput): AttentionReason | undefined {
  if (input.pendingPermissions > 0) return 'permission';
  if (input.acknowledged) return undefined;
  if (input.status === 'error') return 'error';
  // 실행 중이면 아직 사용자를 기다리는 게 아니다
  if (input.status === 'running' || input.status === 'initializing') return undefined;
  if (input.lastTurnOutcome === 'completed' || input.lastTurnOutcome === 'failed')
    return 'finished';
  return undefined;
}

/** 상태가 실제로 달라졌는지 — 이벤트를 헛되이 발행하지 않기 위한 비교 (7.1.2) */
export function attentionChanged(a: AttentionState | undefined, b: AttentionState): boolean {
  return (
    (a?.requiresAttention ?? false) !== b.requiresAttention ||
    a?.attentionReason !== b.attentionReason
  );
}
