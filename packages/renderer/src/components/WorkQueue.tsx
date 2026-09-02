import { useMemo, useState } from 'react';
import {
  ArrowUpRight,
  CircleAlert,
  CirclePlay,
  Clock3,
  GitBranch,
  Info,
  Plus,
  Search,
} from 'lucide-react';
import type { SessionSummary, Workspace } from '@custom-harness/protocol';
import { Button } from './ui/button.js';

type QueueFilter = 'all' | 'attention' | 'running' | 'idle' | 'closed';

const filterLabel: Record<QueueFilter, string> = {
  all: '전체',
  attention: '확인 필요',
  running: '실행 중',
  idle: '대기',
  closed: '완료',
};

function queueStatus(session: SessionSummary): { label: string; tone: QueueFilter } {
  if (session.requiresAttention) {
    return {
      label: session.attentionReason === 'permission' ? '승인 대기' : '확인 필요',
      tone: 'attention',
    };
  }
  if (session.status === 'running') return { label: '실행 중', tone: 'running' };
  if (session.status === 'closed') return { label: '완료', tone: 'closed' };
  return { label: '대기', tone: 'idle' };
}

function titleOf(session: SessionSummary): string {
  return session.title ?? session.cwd.split('/').filter(Boolean).at(-1) ?? session.sessionId;
}

/** 데몬의 attentionTimestamp 를 그대로 써서 오래 기다린 주의 작업을 먼저 놓는다. */
export function compareQueueSessions(a: SessionSummary, b: SessionSummary): number {
  const aAttention = a.requiresAttention === true;
  const bAttention = b.requiresAttention === true;
  if (aAttention !== bAttention) return aAttention ? -1 : 1;
  if (aAttention && bAttention) {
    return (a.attentionTimestamp ?? '').localeCompare(b.attentionTimestamp ?? '');
  }
  return 0;
}

export function WorkQueue({
  workspaces,
  sessions,
  activeWorkspaceId,
  onOpenSession,
  onCreateSession,
}: {
  workspaces: Workspace[];
  sessions: SessionSummary[];
  activeWorkspaceId: string | null;
  onOpenSession(sessionId: string): void;
  onCreateSession(): void;
}): React.JSX.Element {
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [query, setQuery] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const workspaceName = new Map(
    workspaces.map((workspace) => [workspace.id, workspace.displayName]),
  );
  const normalizedQuery = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      sessions
        .filter((session) => {
          const status = queueStatus(session);
          const filterMatches = filter === 'all' || status.tone === filter;
          const text =
            `${titleOf(session)} ${session.harness} ${session.cwd} ${workspaceName.get(session.workspaceId ?? '') ?? ''}`.toLowerCase();
          return filterMatches && (normalizedQuery === '' || text.includes(normalizedQuery));
        })
        .sort(compareQueueSessions),
    [filter, normalizedQuery, sessions, workspaceName],
  );
  const selected =
    visible.find((session) => session.sessionId === selectedSessionId) ?? visible.at(0) ?? null;

  return (
    <section className="work-queue" aria-label="세션 작업 큐">
      <header className="work-queue-heading">
        <div>
          <p className="work-queue-eyebrow">OPERATIONS</p>
          <h1>워크 큐</h1>
          <p>실행 중인 세션과 사용자의 확인이 필요한 작업을 관리합니다.</p>
        </div>
        <Button onClick={onCreateSession}>
          <Plus size={16} /> 새 세션
        </Button>
      </header>

      <div className="work-queue-toolbar">
        <div className="work-queue-filters" aria-label="세션 상태 필터">
          {(Object.keys(filterLabel) as QueueFilter[]).map((item) => (
            <button
              key={item}
              className={filter === item ? 'is-selected' : ''}
              onClick={() => setFilter(item)}
            >
              {filterLabel[item]}
            </button>
          ))}
        </div>
        <label className="work-queue-search">
          <Search size={16} />
          <span className="sr-only">세션 검색</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="세션, 하네스, 워크스페이스 검색"
          />
        </label>
      </div>

      <div className="work-queue-summary">
        <span>{visible.length}개 세션</span>
        {activeWorkspaceId !== null && (
          <span>{workspaceName.get(activeWorkspaceId) ?? '선택된 워크스페이스'}</span>
        )}
      </div>

      <div className="work-queue-table" role="list" aria-label="세션 작업 목록">
        <div className="work-queue-table-head" aria-hidden="true">
          <span>상태</span>
          <span>세션</span>
          <span>하네스</span>
          <span>최근 변경</span>
        </div>
        {visible.map((session) => {
          const status = queueStatus(session);
          return (
            <div key={session.sessionId} role="listitem">
              <button
                className={`work-queue-row ${selected?.sessionId === session.sessionId ? 'is-selected' : ''}`}
                onClick={() => {
                  setSelectedSessionId(session.sessionId);
                  onOpenSession(session.sessionId);
                }}
                aria-label={`${titleOf(session)} ${status.label}`}
                aria-pressed={selected?.sessionId === session.sessionId}
              >
                <span className={`work-queue-status is-${status.tone}`}>
                  {status.tone === 'attention' ? (
                    <CircleAlert size={16} />
                  ) : (
                    <CirclePlay size={16} />
                  )}
                  {status.label}
                </span>
                <span className="work-queue-session">
                  <strong>{titleOf(session)}</strong>
                  <small>{workspaceName.get(session.workspaceId ?? '') ?? session.cwd}</small>
                </span>
                <span className={`work-queue-harness harness-${session.harness}`}>
                  {session.harness}
                </span>
                <span className="work-queue-meta">
                  <Clock3 size={15} />{' '}
                  {session.updatedAt ? new Date(session.updatedAt).toLocaleString() : '방금 전'}
                </span>
              </button>
            </div>
          );
        })}
        {visible.length === 0 && <p className="work-queue-empty">표시할 세션이 없습니다.</p>}
      </div>
      {selected !== null && (
        <section className="work-queue-detail" aria-label={`선택한 세션 ${titleOf(selected)} 상세`}>
          <header>
            <div>
              <p className="work-queue-detail-kicker">SELECTED SESSION</p>
              <h2>{titleOf(selected)}</h2>
              <span className={`work-queue-status is-${queueStatus(selected).tone}`}>
                상태 · {queueStatus(selected).label}
              </span>
            </div>
            <button className="work-queue-open" onClick={() => onOpenSession(selected.sessionId)}>
              세션 열기 <ArrowUpRight size={15} aria-hidden="true" />
            </button>
          </header>
          <div className="work-queue-detail-grid">
            <div>
              <Info size={15} aria-hidden="true" />
              <span>세션 ID</span>
              <code>{selected.sessionId}</code>
            </div>
            <div>
              <GitBranch size={15} aria-hidden="true" />
              <span>워크스페이스</span>
              <strong>{workspaceName.get(selected.workspaceId ?? '') ?? selected.cwd}</strong>
            </div>
            <div>
              <CirclePlay size={15} aria-hidden="true" />
              <span>하네스</span>
              <strong>{selected.harness}</strong>
            </div>
            <div>
              <Clock3 size={15} aria-hidden="true" />
              <span>최근 변경</span>
              <strong>
                {selected.updatedAt ? new Date(selected.updatedAt).toLocaleString() : '방금 전'}
              </strong>
            </div>
          </div>
        </section>
      )}
    </section>
  );
}
