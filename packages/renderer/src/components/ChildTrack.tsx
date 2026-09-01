// 자식 세션 트랙 (M7 WBS 7.3.3, FR-9.3) — 부모 화면 위의 **한 줄**.
//
// 형제 세션(같은 워크스페이스의 독립 세션)은 탭·페인으로 보여 주고, 부모-자식은 이 트랙으로
// 구분한다. 자식을 탭으로 승격시키지 않는 이유는 자리 다툼이다 — 위임한 작업 5개가 탭 5개가
// 되면 사용자가 하던 일이 밀려난다. 트랙은 "무엇이 돌고 있고 얼마를 썼는가"만 보여 주고,
// 눌렀을 때 비로소 탭이 열린다(자식도 1급 세션이라 직접 대화할 수 있다 — FR-9.3).
import type { SessionUsageTree } from '@custom-harness/protocol';

const STATUS_LABEL: Record<string, string> = {
  initializing: '준비 중',
  idle: '대기',
  running: '진행 중',
  error: '오류',
  closed: '종료',
};

/** 토큰 수는 자릿수가 커서 그대로 두면 줄이 흔들린다 — 천 단위로 줄인다 */
function tokens(value: number | undefined): string {
  if (value === undefined) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

export interface ChildTrackActions {
  open(sessionId: string): void;
}

export function ChildTrack({
  usage,
  parentSessionId,
  actions,
}: {
  /** `session.usage` 결과 그대로. 아직 안 받았으면 undefined */
  usage: SessionUsageTree | undefined;
  /** 이 세션이 자식이면 부모 id — 되돌아갈 길이 없으면 자식 탭은 맥락을 잃는다 */
  parentSessionId?: string | undefined;
  actions: ChildTrackActions;
}): React.JSX.Element | null {
  const children = usage?.children ?? [];
  // 자식도 부모도 없으면 트랙 자체를 그리지 않는다 — 위임을 안 쓰는 세션에 빈 줄을 남기지 않는다
  if (children.length === 0 && parentSessionId === undefined) return null;

  return (
    <div className="child-track" data-testid="child-track">
      {parentSessionId !== undefined && (
        <button
          className="child-track-parent"
          onClick={() => actions.open(parentSessionId)}
          title={`부모 세션 ${parentSessionId}`}
        >
          ↑ 부모 세션
        </button>
      )}
      {children.length > 0 && (
        <>
          <span className="child-track-label">
            자식 {children.length}
            {usage !== undefined && usage.activeChildCount !== children.length
              ? ` (진행 ${usage.activeChildCount})`
              : ''}
          </span>
          <ul className="child-track-list">
            {children.map((child) => (
              <li key={child.sessionId}>
                <button
                  className="child-chip"
                  data-testid={`child-chip-${child.sessionId}`}
                  onClick={() => actions.open(child.sessionId)}
                  title={`${child.sessionId} · ${STATUS_LABEL[child.status] ?? child.status}`}
                >
                  <span className={`status-dot status-${child.status}`} />
                  <span className="child-harness">{child.harness}</span>
                  {/* 자손까지 포함한 합 — 이 가지가 통째로 얼마를 썼는지가 판단 기준이다 */}
                  <span className="child-tokens">{tokens(child.subtree.totalTokens)}tk</span>
                </button>
              </li>
            ))}
          </ul>
          {usage !== undefined && (
            // 합산 표시는 FR-9.3 이 필수로 요구한다 — 자기 것과 위임 비용을 나눠 보여 준다
            <span className="child-track-total" data-testid="child-track-total">
              합계 {tokens(usage.subtree.totalTokens)}tk (내 대화 {tokens(usage.own.totalTokens)}tk)
            </span>
          )}
        </>
      )}
    </div>
  );
}
