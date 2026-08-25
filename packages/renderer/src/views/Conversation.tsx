// 대화 뷰 (WBS 1.5.3~1.5.5, FR-3.2) — 스트리밍 델타, 사고 과정 접기(기본 접힘),
// 툴/승인 카드, 턴 상태·중단, 자동 스크롤 추적(위로 스크롤 시 해제 + 새 메시지 배지).
import { useEffect, useRef, useState } from 'react';
import type { PermissionOutcome } from '@custom-harness/protocol';
import type { SessionView } from '../timeline.js';
import { Composer } from '../components/Composer.js';
import { Markdown } from '../components/Markdown.js';
import { PermissionCard } from '../components/PermissionCard.js';
import { ToolCard } from '../components/ToolCard.js';

export interface ConversationActions {
  prompt(text: string): void;
  interrupt(): void;
  respondPermission(requestId: string, outcome: PermissionOutcome): void;
}

export function Conversation({
  view,
  actions,
}: {
  view: SessionView;
  actions: ConversationActions;
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [tracking, setTracking] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const running = view.status === 'running';

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    if (tracking) {
      container.scrollTop = container.scrollHeight;
      setUnseen(0);
    } else {
      setUnseen((count) => count + 1);
    }
  }, [view.lastSeq, tracking]);

  const onScroll = (): void => {
    const container = scrollRef.current;
    if (!container) return;
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 24;
    setTracking(atBottom);
    if (atBottom) setUnseen(0);
  };

  return (
    <div className="conversation">
      <div className="conversation-status" data-testid="session-status">
        <span className={`status-chip status-${view.status}`}>{view.status}</span>
        {running && (
          <button className="interrupt" onClick={() => actions.interrupt()}>
            중단
          </button>
        )}
        {view.lastError && <span className="session-error">{view.lastError}</span>}
        {view.usage?.totalTokens !== undefined && (
          <span className="usage">토큰 {view.usage.totalTokens.toLocaleString()}</span>
        )}
      </div>

      <div className="conversation-scroll" ref={scrollRef} onScroll={onScroll}>
        {view.items.map((item, index) => {
          switch (item.kind) {
            case 'user':
              return (
                <div key={index} className="msg-user" data-testid="user-message">
                  {item.text}
                </div>
              );
            case 'assistant':
              return (
                <div key={index} className={`msg-assistant turn-${item.status}`}>
                  {item.reasoning && (
                    <details className="reasoning" data-testid="reasoning">
                      <summary>사고 과정</summary>
                      <div className="reasoning-body">{item.reasoning}</div>
                    </details>
                  )}
                  <Markdown text={item.text} />
                  {item.status === 'running' && <span className="turn-spinner">●</span>}
                  {item.status === 'failed' && (
                    <div className="turn-error">턴 실패: {item.errorMessage ?? '원인 미상'}</div>
                  )}
                  {item.status === 'canceled' && <div className="turn-canceled">중단됨</div>}
                </div>
              );
            case 'tool':
              return <ToolCard key={index} item={item} />;
            case 'permission':
              return (
                <PermissionCard
                  key={index}
                  item={item}
                  onRespond={(requestId, outcome) => actions.respondPermission(requestId, outcome)}
                />
              );
          }
        })}
      </div>

      {!tracking && unseen > 0 && (
        <button
          className="new-message-badge"
          data-testid="new-message-badge"
          onClick={() => {
            setTracking(true);
            const container = scrollRef.current;
            if (container) container.scrollTop = container.scrollHeight;
          }}
        >
          새 메시지 {unseen}
        </button>
      )}

      <Composer disabled={running || view.status === 'closed'} onSubmit={actions.prompt} />
    </div>
  );
}
