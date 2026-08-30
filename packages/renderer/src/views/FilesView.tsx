// 파일 탐색기·뷰어 (WBS 6.4) — 워크스페이스 트리를 펼칠 때마다 한 단계씩 읽는다(증분).
import { useCallback, useEffect, useState } from 'react';
import type { FileContent, FileEntry } from '../store/app-store.js';

export interface FilesActions {
  list(path: string): Promise<{ entries: FileEntry[]; truncated: boolean }>;
  openFile(path: string): void;
}

function Directory({
  path,
  depth,
  actions,
}: {
  path: string;
  depth: number;
  actions: FilesActions;
}): React.JSX.Element {
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await actions.list(path);
        if (cancelled) return;
        setEntries(result.entries);
        setTruncated(result.truncated);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, actions]);

  const toggle = useCallback((entryPath: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(entryPath)) next.delete(entryPath);
      else next.add(entryPath);
      return next;
    });
  }, []);

  if (error !== null) return <div className="file-error">{error}</div>;
  if (entries === null) return <div className="file-loading">읽는 중…</div>;

  return (
    <ul className="file-list" style={{ paddingInlineStart: depth === 0 ? 0 : 12 }}>
      {entries.map((entry) =>
        entry.kind === 'directory' ? (
          <li key={entry.path}>
            <button
              className="file-entry directory"
              data-testid={`dir-${entry.path}`}
              onClick={() => toggle(entry.path)}
            >
              {expanded.has(entry.path) ? '▾' : '▸'} {entry.name}
            </button>
            {expanded.has(entry.path) && (
              <Directory path={entry.path} depth={depth + 1} actions={actions} />
            )}
          </li>
        ) : (
          <li key={entry.path}>
            <button
              className="file-entry file"
              data-testid={`file-${entry.path}`}
              onClick={() => actions.openFile(entry.path)}
            >
              {entry.name}
            </button>
          </li>
        ),
      )}
      {truncated && <li className="file-truncated">항목이 많아 일부만 표시했습니다</li>}
    </ul>
  );
}

export function FilesView({ actions }: { actions: FilesActions }): React.JSX.Element {
  return (
    <div className="files-view" data-testid="files-view">
      <Directory path="" depth={0} actions={actions} />
    </div>
  );
}

export function FileViewer({
  path,
  read,
}: {
  path: string;
  read: (path: string) => Promise<FileContent>;
}): React.JSX.Element {
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    void (async () => {
      try {
        const result = await read(path);
        if (!cancelled) setContent(result);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, read]);

  if (error !== null) return <div className="file-error">열 수 없음: {error}</div>;
  if (content === null) return <div className="file-loading">읽는 중…</div>;
  if (content.binary) {
    return (
      <div className="file-viewer" data-testid="file-viewer">
        <div className="file-note">바이너리 파일 ({content.size.toLocaleString()} bytes)</div>
      </div>
    );
  }
  if (content.tooLarge) {
    return (
      <div className="file-viewer" data-testid="file-viewer">
        <div className="file-note">
          파일이 너무 큽니다 ({content.size.toLocaleString()} bytes) — 뷰어 상한 초과
        </div>
      </div>
    );
  }
  return (
    <div className="file-viewer" data-testid="file-viewer">
      <pre className="file-content">{content.text}</pre>
    </div>
  );
}
