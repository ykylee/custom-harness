// 세션 상태의 표시 정본 — 색·레이블을 각 표면에서 따로 해석하지 않는다.
import type { SessionStatus } from '@custom-harness/protocol';

export type DisplaySessionStatus = SessionStatus | 'approval';

const STATUS_LABEL: Record<DisplaySessionStatus, string> = {
  approval: '승인 필요',
  initializing: '준비 중',
  idle: '대기',
  running: '실행 중',
  closed: '종료됨',
  error: '오류',
};

export function displaySessionStatus(
  status: SessionStatus,
  options: { requiresApproval?: boolean } = {},
): { kind: DisplaySessionStatus; label: string } {
  const kind: DisplaySessionStatus = options.requiresApproval === true ? 'approval' : status;
  return { kind, label: STATUS_LABEL[kind] };
}
