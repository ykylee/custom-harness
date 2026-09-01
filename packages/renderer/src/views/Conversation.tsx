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
  /** 세션 한정 자동 승인 opt-in (FR-3.4.3, WBS 2.4.7) */
  setAutoApprove?(enabled: boolean): void;
}

const AUTO_APPROVE_WARNING =
  '이 세션의 모든 승인 요청(셸 실행·파일 쓰기 포함)을 자동으로 허용합니다.\n' +
  '에이전트가 확인 없이 위험한 작업을 수행할 수 있습니다. 계속할까요?';

export function Conversation({
  view,
  autoApprove = false,
  actions,
}: {
  view: SessionView;
  autoApprove?: boolean;
  actions: ConversationActions;
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  // 자동 스크롤이 유발한 onScroll 을 사용자 조작으로 오인하지 않기 위한 플래그 —
  // 구분 없이는 스트리밍 중 매 델타의 바닥 강제 이동이 사용자 스크롤(드래그·휠)을
  // 즉시 되돌려 "스크롤바가 안 움직이는" 경합이 된다 (2026-08-26 win 실기기 보고)
  const programmaticScroll = useRef(false);
  const [tracking, setTracking] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const running = view.status === 'running';

  /**
   * 검색 결과에서 찾아온 자리로 이동 (M7 7.4.2). 앵커 seq **이하 중 가장 큰** 항목이
   * 목표다 — 어시스턴트 항목은 `turn_started` 에서 만들어지고 검색 세그먼트의 앵커는
   * 첫 델타라 둘이 정확히 같지 않다.
   *
   * 추적(tracking)을 끈다: 켜 둔 채로 이동하면 다음 델타 한 번에 바닥으로 되돌아가
   * 찾아온 자리가 사라진다.
   */
  useEffect(() => {
    const focusSeq = view.focusSeq;
    if (focusSeq === undefined) return;
    const container = scrollRef.current;
    if (!container) return;
    let target: Element | undefined;
    for (const element of container.querySelectorAll('[data-seq]')) {
      const seq = Number(element.getAttribute('data-seq'));
      if (Number.isNaN(seq) || seq > focusSeq) continue;
      target = element;
    }
    if (target === undefined) return;
    setTracking(false);
    programmaticScroll.current = true;
    target.scrollIntoView?.({ block: 'center' });
    target.classList.add('timeline-focus');
  }, [view.focusSeq, view.items.length]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    // 찾아온 자리를 보고 있는 동안에는 바닥으로 끌고 가지 않는다
    if (view.focusSeq !== undefined && !tracking) return;
    if (tracking) {
      programmaticScroll.current = true;
      container.scrollTop = container.scrollHeight;
      setUnseen(0);
    } else {
      setUnseen((count) => count + 1);
    }
  }, [view.lastSeq, tracking]);

  const onScroll = (): void => {
    const container = scrollRef.current;
    if (!container) return;
    if (programmaticScroll.current) {
      programmaticScroll.current = false;
      return;
    }
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
        {view.totalTokens !== undefined && (
          <span className="usage" data-testid="session-usage">
            누적 {view.totalTokens.toLocaleString()} 토큰
          </span>
        )}
        {actions.setAutoApprove && (
          <label className="auto-approve" data-testid="auto-approve">
            <input
              type="checkbox"
              checked={autoApprove}
              onChange={(event) => {
                // 위험 고지 (FR-3.4.3) — 켤 때만 확인
                if (event.target.checked && !window.confirm(AUTO_APPROVE_WARNING)) return;
                actions.setAutoApprove?.(event.target.checked);
              }}
            />
            자동 승인
            {autoApprove && <span className="auto-approve-on">⚠ 이 세션 자동 허용 중</span>}
          </label>
        )}
      </div>

      <div className="conversation-scroll" ref={scrollRef} onScroll={onScroll}>
        {view.items.map((item, index) => {
          switch (item.kind) {
            case 'user':
              return (
                <div
                  key={index}
                  className="msg-user"
                  data-testid="user-message"
                  data-seq={item.seq}
                >
                  {item.text}
                </div>
              );
            case 'assistant': {
              // 세그먼트 분할(timeline)로 생기는 빈 껍데기는 숨김 — 단, 마지막 아이템로서
              // 델타 대기 중인 running 세그먼트는 스피너 자리로 남긴다
              const isLast = index === view.items.length - 1;
              const isEmpty =
                item.text === '' &&
                item.reasoning === '' &&
                item.usage?.totalTokens === undefined &&
                item.status !== 'failed' &&
                item.status !== 'canceled';
              if (isEmpty && !(item.status === 'running' && isLast)) return null;
              return (
                <div
                  key={index}
                  className={`msg-assistant turn-${item.status}`}
                  data-seq={item.seq}
                >
                  {item.reasoning && (
                    <details className="reasoning" data-testid="reasoning">
                      <summary>사고 과정</summary>
                      <div className="reasoning-body">{item.reasoning}</div>
                    </details>
                  )}
                  <Markdown text={item.text} />
                  {item.status === 'running' && isLast && <span className="turn-spinner">●</span>}
                  {item.usage?.totalTokens !== undefined && (
                    <span className="turn-usage" data-testid="turn-usage">
                      {item.usage.totalTokens.toLocaleString()} 토큰
                    </span>
                  )}
                  {item.status === 'failed' && (
                    <div className="turn-error">턴 실패: {item.errorMessage ?? '원인 미상'}</div>
                  )}
                  {item.status === 'canceled' && <div className="turn-canceled">중단됨</div>}
                </div>
              );
            }
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
