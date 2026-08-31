// 주의 상태 정책 (M7 WBS 7.1.1, FR-9.1) — 규칙이 한 곳에만 있는지 지키는 테스트.
import { describe, expect, it } from 'vitest';
import { attentionChanged, computeAttention, type AttentionState } from './attention.js';

const base = { status: 'idle' as const, pendingPermissions: 0, acknowledged: true };

describe('computeAttention', () => {
  it('승인 대기가 최우선 — 확인 처리로도 사라지지 않는다', () => {
    // 화면을 봤다는 사실이 승인 응답을 대신하지 않는다
    const state = computeAttention({ ...base, pendingPermissions: 1, acknowledged: true });
    expect(state).toMatchObject({ requiresAttention: true, attentionReason: 'permission' });
  });

  it('승인 대기 > 에러 > 완료 순으로 사유를 고른다', () => {
    expect(
      computeAttention({
        status: 'error',
        pendingPermissions: 2,
        acknowledged: false,
        lastTurnOutcome: 'failed',
      }).attentionReason,
    ).toBe('permission');
    expect(
      computeAttention({
        status: 'error',
        pendingPermissions: 0,
        acknowledged: false,
        lastTurnOutcome: 'failed',
      }).attentionReason,
    ).toBe('error');
    expect(
      computeAttention({ ...base, acknowledged: false, lastTurnOutcome: 'completed' })
        .attentionReason,
    ).toBe('finished');
  });

  it('실행 중에는 주의 대상이 아니다 — 아직 사용자를 기다리지 않는다', () => {
    for (const status of ['running', 'initializing'] as const) {
      expect(
        computeAttention({ status, pendingPermissions: 0, acknowledged: false }).requiresAttention,
      ).toBe(false);
    }
  });

  it('취소된 턴은 주의 대상이 아니다 — 사용자가 스스로 멈춘 것이다', () => {
    expect(
      computeAttention({ ...base, acknowledged: false, lastTurnOutcome: 'canceled' })
        .requiresAttention,
    ).toBe(false);
  });

  it('확인 처리하면 완료·에러 주의는 사라진다', () => {
    expect(
      computeAttention({
        status: 'error',
        pendingPermissions: 0,
        acknowledged: true,
        lastTurnOutcome: 'failed',
      }),
    ).toEqual({ requiresAttention: false });
  });

  it('같은 사유가 이어지면 최초 전이 시각을 보존한다 ("얼마나 기다렸나")', () => {
    const first = computeAttention({ ...base, acknowledged: false, lastTurnOutcome: 'completed' });
    const again = computeAttention(
      { ...base, acknowledged: false, lastTurnOutcome: 'completed' },
      first,
    );
    expect(again.attentionTimestamp).toBe(first.attentionTimestamp);
  });

  it('사유가 바뀌면 시각을 갱신한다', () => {
    const finished: AttentionState = {
      requiresAttention: true,
      attentionReason: 'finished',
      attentionTimestamp: '2020-01-01T00:00:00.000Z',
    };
    const next = computeAttention({ ...base, pendingPermissions: 1 }, finished);
    expect(next.attentionReason).toBe('permission');
    expect(next.attentionTimestamp).not.toBe(finished.attentionTimestamp);
  });
});

describe('attentionChanged', () => {
  it('사유·플래그가 같으면 변화가 아니다 — 헛된 이벤트를 막는다', () => {
    const a: AttentionState = { requiresAttention: true, attentionReason: 'finished' };
    expect(attentionChanged(a, { ...a, attentionTimestamp: 'x' })).toBe(false);
  });

  it('플래그나 사유가 달라지면 변화다', () => {
    expect(attentionChanged(undefined, { requiresAttention: true })).toBe(true);
    expect(
      attentionChanged(
        { requiresAttention: true, attentionReason: 'finished' },
        { requiresAttention: true, attentionReason: 'error' },
      ),
    ).toBe(true);
    expect(attentionChanged({ requiresAttention: true }, { requiresAttention: false })).toBe(true);
  });
});
