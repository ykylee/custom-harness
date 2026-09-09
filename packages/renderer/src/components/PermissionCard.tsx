// 승인 인라인 카드 (WBS 1.5.5, FR-3.4.1) — 종류·대상 요약·원본 펼침·옵션 버튼.
import { useState } from 'react';
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

const IMPACT_LABEL: Record<PermissionItem['request']['kind'], string> = {
  shell: '명령 실행',
  file_write: '파일 변경',
  fetch: '외부 연결',
  mcp: '도구 실행',
  other: '검토 필요',
};

const ORIGIN_LABEL = { harness: '하네스 요청', reverse_tool: '내장 도구 요청' } as const;

export function PermissionCard({
  item,
  onRespond,
}: {
  item: PermissionItem;
  onRespond: (requestId: string, outcome: PermissionOutcome) => void;
}): React.JSX.Element {
  const { request } = item;
  const [responding, setResponding] = useState(false);
  const resolvedOptionId =
    item.outcome !== undefined && 'optionId' in item.outcome ? item.outcome.optionId : undefined;
  const resolvedOption =
    resolvedOptionId !== undefined
      ? request.options.find((option) => option.optionId === resolvedOptionId)
      : undefined;
  const respond = (optionId: string): void => {
    setResponding(true);
    onRespond(request.requestId, { optionId });
  };
  return (
    <section
      className={`permission-card is-${item.status} impact-${request.kind}`}
      data-testid="permission-card"
      data-seq={item.seq}
      aria-labelledby={`permission-${request.requestId}`}
      aria-busy={responding || undefined}
    >
      <div className="permission-header">
        <span className="permission-state">
          {item.status === 'pending' ? '결정 필요' : '응답 완료'}
        </span>
        <span className="permission-impact">{IMPACT_LABEL[request.kind]}</span>
      </div>
      <h3 id={`permission-${request.requestId}`}>{KIND_LABEL[request.kind]}</h3>
      <div className="permission-body">
        <span className="permission-summary">{request.summary}</span>
      </div>
      <p className="permission-origin">
        {ORIGIN_LABEL[request.origin ?? 'harness']} · 이 세션에만 적용
      </p>
      {request.detail !== undefined && (
        <details>
          <summary>원본 상세</summary>
          <pre>{JSON.stringify(request.detail, null, 2)}</pre>
        </details>
      )}
      {item.status === 'pending' ? (
        <div className="permission-actions" aria-label="승인 선택">
          {request.options.map((option) => (
            <button
              key={option.optionId}
              className={`permission-option option-${option.kind}`}
              disabled={responding}
              onClick={() => respond(option.optionId)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="permission-resolved">
          {resolvedOption ? `선택됨: ${resolvedOption.label}` : '응답 완료'}
        </div>
      )}
    </section>
  );
}
