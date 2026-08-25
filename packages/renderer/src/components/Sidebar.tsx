// 사이드바 세션 목록 (WBS 2.4.1, FR-3.3.1) — 상태 버킷 그룹핑, 하네스 아이콘·디렉토리,
// 승인 대기 배지(FR-3.4.2), 사용량 요약(FR-3.7), 명시적 세션 종료(FR-3.3.3).
import type { SessionSummary } from '@custom-harness/protocol';

/** 하네스 아이콘 — 폐쇄망 자산 없이 텍스트 배지 (색상은 styles.css harness-*) */
export function HarnessBadge({ harness }: { harness: string }): React.JSX.Element {
  return <span className={`harness-badge harness-${harness}`}>{harness}</span>;
}

type Bucket = 'approval' | 'running' | 'idle' | 'error' | 'closed';

const BUCKET_ORDER: Bucket[] = ['approval', 'running', 'idle', 'error', 'closed'];
const BUCKET_LABEL: Record<Bucket, string> = {
  approval: '승인 대기',
  running: '실행 중',
  idle: '유휴',
  error: '에러',
  closed: '완료·보관',
};

export function bucketOf(session: SessionSummary): Bucket {
  if (session.pendingPermissions?.length) return 'approval';
  if (session.status === 'running') return 'running';
  if (session.status === 'error') return 'error';
  if (session.status === 'closed') return 'closed';
  return 'idle'; // idle · initializing
}

export interface SidebarActions {
  open(sessionId: string): void;
  closeSession(sessionId: string): void;
  newSession(): void;
  openSettings(): void;
}

export function Sidebar({
  sessions,
  activeSessionId,
  actions,
}: {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  actions: SidebarActions;
}): React.JSX.Element {
  const buckets = new Map<Bucket, SessionSummary[]>();
  for (const session of sessions) {
    const bucket = bucketOf(session);
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), session]);
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-actions">
        <button className="new-session" onClick={() => actions.newSession()}>
          + 새 세션
        </button>
        <button className="settings-link" onClick={() => actions.openSettings()}>
          설정
        </button>
      </div>
      {BUCKET_ORDER.filter((bucket) => buckets.has(bucket)).map((bucket) => (
        <section key={bucket} className={`bucket bucket-${bucket}`}>
          <h4 className="bucket-title">
            {BUCKET_LABEL[bucket]}{' '}
            <span className="bucket-count">{buckets.get(bucket)!.length}</span>
          </h4>
          <ul className="session-list">
            {buckets.get(bucket)!.map((session) => (
              <li
                key={session.sessionId}
                className={session.sessionId === activeSessionId ? 'selected' : ''}
              >
                <button
                  className="session-entry"
                  data-testid={`session-${session.sessionId}`}
                  onClick={() => actions.open(session.sessionId)}
                >
                  <span className={`status-dot status-${session.status}`} />
                  <HarnessBadge harness={session.harness} />
                  <span className="session-cwd" title={session.cwd}>
                    {session.cwd.split('/').pop() ?? session.cwd}
                  </span>
                  {session.pendingPermissions?.length ? (
                    <span className="pending-badge" data-testid="pending-badge">
                      승인 {session.pendingPermissions.length}
                    </span>
                  ) : null}
                  {session.usage?.totalTokens !== undefined && (
                    <span className="session-usage">
                      {session.usage.totalTokens.toLocaleString()}tk
                    </span>
                  )}
                </button>
                {session.status !== 'closed' && (
                  <button
                    className="session-close"
                    title="세션 종료 (이력 유지 — 재개 가능)"
                    onClick={() => actions.closeSession(session.sessionId)}
                  >
                    ⏻
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}
