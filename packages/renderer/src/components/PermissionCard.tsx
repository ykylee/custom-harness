// 승인 인라인 카드 (WBS 1.5.5, FR-3.4.1) — 종류·대상 요약·원본 펼침·옵션 버튼.
import type { PermissionOutcome } from '@custom-harness/protocol';
import type { TimelineItem } from '../timeline.js';

type PermissionItem = Extract<TimelineItem, { kind: 'permission' }>;

const KIND_LABEL: Record<PermissionItem['request']['kind'], string> = {
  shell: '명령 실행 승인',
  file_write: '파일 쓰기 승인',
  fetch: '네트워크 접근 승인',
  mcp: 'MCP 승인',
  other: '승인 요청',
};

export function PermissionCard({
  item,
  onRespond,
}: {
  item: PermissionItem;
  onRespond: (requestId: string, outcome: PermissionOutcome) => void;
}): React.JSX.Element {
  const { request } = item;
  return (
    <div className="permission-card" data-testid="permission-card" data-seq={item.seq}>
      <div className="permission-header">
        <strong>{KIND_LABEL[request.kind]}</strong>
        <span className="permission-summary">{request.summary}</span>
      </div>
      {request.detail !== undefined && (
        <details>
          <summary>원본 상세</summary>
          <pre>{JSON.stringify(request.detail, null, 2)}</pre>
        </details>
      )}
      {item.status === 'pending' ? (
        <div className="permission-actions">
          {request.options.map((option) => (
            <button
              key={option.optionId}
              className={`permission-option option-${option.kind}`}
              onClick={() => onRespond(request.requestId, { optionId: option.optionId })}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="permission-resolved">응답 완료</div>
      )}
    </div>
  );
}
