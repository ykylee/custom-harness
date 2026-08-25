// 툴 실행 카드 (WBS 1.5.4, FR-3.2.3) — FR-1.2.5 분류별 요약 + 진행 상태 + 원본 펼침.
// M1 최소 표시: diff 뷰는 원본 페이로드 펼침으로 갈음 (m1-mvp 리스크 §허용, M2 보강).
import type { TimelineItem } from '../timeline.js';

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;

const KIND_LABEL: Record<ToolItem['toolKind'], string> = {
  shell: '명령 실행',
  read: '파일 읽기',
  edit: '파일 수정',
  write: '파일 쓰기',
  search: '검색',
  fetch: '가져오기',
  sub_agent: '서브에이전트',
  plan: '계획',
  other: '툴 실행',
};

const STATUS_LABEL: Record<ToolItem['status'], string> = {
  running: '실행 중…',
  ok: '완료',
  error: '실패',
};

/** 분류별 1줄 요약 (FR-3.2.3) — 원본 구조는 하네스마다 달라 관대하게 추출 */
export function toolSummary(item: ToolItem): string {
  if (item.summary) return item.summary;
  const input = (item.rawInput ?? {}) as Record<string, unknown>;
  switch (item.toolKind) {
    case 'shell':
      return typeof input.command === 'string' ? input.command : (item.toolName ?? 'shell');
    case 'read':
    case 'edit':
    case 'write': {
      const path = input.path ?? input.file_path ?? input.filePath;
      return typeof path === 'string' ? path : (item.toolName ?? '파일');
    }
    case 'search': {
      const target = input.pattern ?? input.query;
      return typeof target === 'string' ? target : (item.toolName ?? '검색');
    }
    default:
      return item.toolName ?? '툴';
  }
}

export function ToolCard({ item }: { item: ToolItem }): React.JSX.Element {
  return (
    <div className={`tool-card tool-${item.status}`} data-testid="tool-card">
      <div className="tool-card-header">
        <span className="tool-kind">{KIND_LABEL[item.toolKind]}</span>
        <code className="tool-summary">{toolSummary(item)}</code>
        <span className={`tool-status status-${item.status}`}>{STATUS_LABEL[item.status]}</span>
      </div>
      <details>
        <summary>원본 상세</summary>
        <pre>{JSON.stringify({ input: item.rawInput, output: item.rawOutput }, null, 2)}</pre>
      </details>
    </div>
  );
}
