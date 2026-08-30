// 변경사항 뷰 (WBS 6.5) — 통합 diff 를 줄 단위로 색칠한다.
import type { DiffState } from '../store/app-store.js';

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-file';
  if (line.startsWith('@@')) return 'diff-hunk';
  if (line.startsWith('+')) return 'diff-add';
  if (line.startsWith('-')) return 'diff-del';
  if (line.startsWith('diff --git')) return 'diff-file';
  return 'diff-ctx';
}

export function DiffView({
  diff,
  onOpenFile,
}: {
  diff: DiffState | undefined;
  onOpenFile?: (path: string) => void;
}): React.JSX.Element {
  if (diff === undefined) return <div className="file-loading">변경사항을 읽는 중…</div>;
  if (diff.unavailable !== undefined) {
    return <div className="file-note">변경사항을 볼 수 없음: {diff.unavailable}</div>;
  }
  const lines = diff.patch === '' ? [] : diff.patch.split('\n');

  return (
    <div className="diff-view" data-testid="diff-view">
      {diff.untracked.length > 0 && (
        <div className="diff-untracked">
          <h4>미추적 파일 {diff.untracked.length}</h4>
          <ul>
            {diff.untracked.map((path) => (
              <li key={path}>
                <button className="file-entry file" onClick={() => onOpenFile?.(path)}>
                  {path}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {lines.length === 0 && diff.untracked.length === 0 ? (
        <div className="file-note">변경사항이 없습니다</div>
      ) : (
        <pre className="diff-body">
          {lines.map((line, index) => (
            <div key={index} className={lineClass(line)}>
              {line === '' ? ' ' : line}
            </div>
          ))}
        </pre>
      )}
      {diff.truncated && <div className="file-note">변경이 많아 일부만 표시했습니다</div>}
    </div>
  );
}
