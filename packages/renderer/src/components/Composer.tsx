// 프롬프트 컴포저 (WBS 1.5.5, FR-3.2.6) — 멀티라인 입력, Cmd/Ctrl+Enter 전송.
// 실행 중에는 비활성 (큐잉 없음 — daemon-design §4 결정).
import { useState } from 'react';

export function Composer({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (text: string) => void;
}): React.JSX.Element {
  const [text, setText] = useState('');

  const submit = (): void => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setText('');
  };

  return (
    <div className="composer">
      <textarea
        value={text}
        placeholder={
          disabled ? '턴 실행 중 — 완료 후 입력 가능' : '메시지 입력 (⌘/Ctrl+Enter 전송)'
        }
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <button onClick={submit} disabled={disabled || !text.trim()}>
        전송
      </button>
    </div>
  );
}
