// 프롬프트 컴포저 (WBS 1.5.5, FR-3.2.6) — Enter 전송, Cmd/Ctrl+Enter 줄바꿈.
// 실행 중 입력은 세션 FIFO에 넣는다.
import { useId, useMemo, useState } from 'react';
import type { SessionCommand } from '@custom-harness/protocol';

export function Composer({
  disabled,
  queueing = false,
  queuedCount = 0,
  commands = [],
  onSubmit,
}: {
  disabled: boolean;
  /** 실행 중에도 입력은 가능하며, 전송하면 세션 FIFO에 들어간다. */
  queueing?: boolean;
  queuedCount?: number;
  commands?: readonly SessionCommand[];
  onSubmit: (text: string) => void;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = useId();
  const matches = useMemo(() => {
    const query = text.trimStart();
    if (!query.startsWith('/')) return [];
    const needle = query.toLowerCase();
    return commands.filter((command) =>
      `${command.name} ${command.title} ${command.description ?? ''}`
        .toLowerCase()
        .includes(needle),
    );
  }, [commands, text]);
  const showCommands = open && text.trimStart().startsWith('/');

  const complete = (command: SessionCommand): void => {
    setText(`${command.name} `);
    setOpen(false);
  };

  const submit = (): void => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setText('');
    setOpen(false);
  };

  return (
    <div className="composer">
      <div className="composer-field">
        {showCommands && (
          <div className="slash-popover" role="presentation">
            <div className="slash-popover-label" aria-live="polite">
              하네스 명령 {matches.length}개 · Tab으로 입력
            </div>
            {matches.length > 0 && (
              <div id={listboxId} role="listbox" className="slash-command-list">
                {matches.map((command, index) => (
                  <div
                    key={command.id}
                    id={`${listboxId}-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    className={index === activeIndex ? 'is-active' : undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => complete(command)}
                  >
                    <strong>{command.name}</strong>
                    <span>{command.description ?? command.title}</span>
                    <em>하네스 · 원문 전달</em>
                  </div>
                ))}
              </div>
            )}
            <div className="slash-raw-fallback">알 수 없는 명령은 그대로 하네스에 전달됩니다.</div>
          </div>
        )}
        <textarea
          value={text}
          placeholder={
            disabled
              ? '닫힌 세션 — 재개 후 입력 가능'
              : queueing
                ? '다음 메시지를 대기열에 추가 (Enter 전송 · ⌘/Ctrl+Enter 줄바꿈)'
                : '메시지 입력 (Enter 전송 · ⌘/Ctrl+Enter 줄바꿈)'
          }
          disabled={disabled}
          aria-autocomplete="list"
          aria-expanded={showCommands}
          aria-controls={showCommands && matches.length > 0 ? listboxId : undefined}
          aria-activedescendant={
            showCommands && matches[activeIndex] ? `${listboxId}-${activeIndex}` : undefined
          }
          onChange={(event) => {
            setText(event.target.value);
            setOpen(event.target.value.trimStart().startsWith('/'));
            setActiveIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              submit();
              return;
            }
            if (!showCommands) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              setOpen(false);
            } else if (event.key === 'ArrowDown' && matches.length > 0) {
              event.preventDefault();
              setActiveIndex((index) => (index + 1) % matches.length);
            } else if (event.key === 'ArrowUp' && matches.length > 0) {
              event.preventDefault();
              setActiveIndex((index) => (index - 1 + matches.length) % matches.length);
            } else if (event.key === 'Tab' && matches[activeIndex]) {
              event.preventDefault();
              complete(matches[activeIndex]);
            }
          }}
        />
      </div>
      <button onClick={submit} disabled={disabled || !text.trim()}>
        {queueing ? '대기열 추가' : '전송'}
      </button>
      {queuedCount > 0 && <span className="composer-queue-count">대기 {queuedCount}</span>}
    </div>
  );
}
