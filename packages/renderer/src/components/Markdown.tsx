// 마크다운 렌더 (FR-3.2.1) — marked(파싱) + DOMPurify(정화).
// 코드 블록 구문 강조는 M1 최소 표시(m1-mvp 리스크 §허용) — <pre><code> 스타일만, 강조 라이브러리는 후속.
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo } from 'react';

export function Markdown({ text }: { text: string }): React.JSX.Element {
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false, gfm: true, breaks: true });
    return DOMPurify.sanitize(raw);
  }, [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
