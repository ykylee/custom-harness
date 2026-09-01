// 커맨드 팔레트 (M7 WBS 7.4.2, FR-9.4) — 한 입력창에서 세션·워크스페이스·파일·명령·대화 내용.
//
// 이 컴포넌트는 **무엇도 검색하지 않는다**. 항목 조립과 순위는 컨트롤러(`paletteItems()`)가
// 하고 여기는 그 목록을 그리고 키보드를 처리한다 — 소스가 다섯인데 화면이 순위를 다시
// 매기면 정렬 규칙이 두 곳으로 갈라진다.
//
// 원격 조회(파일·대화 내용)가 도는 동안에도 로컬 항목은 이미 떠 있다. 그래서 로딩 표시가
// 목록을 가리지 않는다 — 팔레트가 잠깐이라도 빈 화면이 되면 사용자는 그냥 닫는다.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PALETTE_GROUP_LABEL,
  type PaletteAction,
  type PaletteGroup,
  type PaletteItem,
} from '../palette/items.js';

export interface CommandPaletteActions {
  search(query: string): void;
  run(action: PaletteAction): void;
  close(): void;
}

export function CommandPalette({
  query,
  items,
  loading,
  actions,
}: {
  query: string;
  items: PaletteItem[];
  loading: boolean;
  actions: CommandPaletteActions;
}): React.JSX.Element {
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => inputRef.current?.focus(), []);
  // 목록이 바뀌면 선택을 맨 위로 되돌린다 — 안 그러면 커서가 엉뚱한 항목에 남는다
  useEffect(() => setCursor(0), [query]);

  // 그룹 머리글은 목록을 훑을 때 "이게 무엇인지"를 알려 준다(스니펫과 파일 경로는 닮았다)
  const rows = useMemo(() => withGroupHeadings(items), [items]);

  useEffect(() => {
    const selected = listRef.current?.querySelector('[data-selected="true"]');
    // scrollIntoView 는 어디에나 있지 않다(jsdom 등) — 없으면 스크롤만 못 할 뿐이다
    selected?.scrollIntoView?.({ block: 'nearest' });
  }, [cursor, items]);

  const move = (delta: number): void => {
    if (items.length === 0) return;
    // 순환한다 — 목록 끝에서 아래를 눌렀을 때 아무 일도 안 일어나면 멈춘 것처럼 보인다
    setCursor((at) => (at + delta + items.length) % items.length);
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      const item = items[cursor];
      if (item !== undefined) {
        event.preventDefault();
        actions.run(item.action);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      actions.close();
    }
  };

  return (
    // 바깥을 누르면 닫힌다 — 팔레트에서 빠져나올 길이 Esc 하나뿐이면 마우스 사용자가 갇힌다
    <div className="palette-backdrop" onMouseDown={() => actions.close()}>
      <div
        className="palette"
        data-testid="command-palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="세션·워크스페이스·파일·명령 검색"
          aria-label="커맨드 팔레트"
          value={query}
          onChange={(event) => actions.search(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list" ref={listRef} role="listbox">
          {rows.map((row) =>
            row.kind === 'heading' ? (
              <div className="palette-heading" key={`heading:${row.group}:${row.at}`}>
                {PALETTE_GROUP_LABEL[row.group]}
              </div>
            ) : (
              <button
                key={row.item.id}
                role="option"
                aria-selected={row.index === cursor}
                data-selected={row.index === cursor}
                className={`palette-item${row.index === cursor ? ' is-selected' : ''}`}
                // click 이 아니라 mouseDown 이면 입력창 blur 전에 실행된다
                onMouseDown={(event) => {
                  event.preventDefault();
                  actions.run(row.item.action);
                }}
                onMouseEnter={() => setCursor(row.index)}
              >
                <span className="palette-item-label">{row.item.label}</span>
                {row.item.detail !== undefined && (
                  <span className="palette-item-detail">{row.item.detail}</span>
                )}
              </button>
            ),
          )}
          {items.length === 0 && (
            <div className="palette-empty">{loading ? '검색 중…' : '결과 없음'}</div>
          )}
        </div>
        {loading && items.length > 0 && (
          <div className="palette-status" data-testid="palette-loading">
            검색 중…
          </div>
        )}
      </div>
    </div>
  );
}

type Row =
  | { kind: 'heading'; group: PaletteGroup; at: number }
  | { kind: 'item'; item: PaletteItem; index: number };

/**
 * 그룹이 **직전 행에서 바뀌는** 자리마다 머리글을 끼운다. "처음 본 그룹에만"이 아닌 이유는
 * 순위가 점수 우선이라 그룹이 섞여 나올 수 있어서다 — 그때 머리글을 한 번만 넣으면 뒤에 온
 * 항목이 엉뚱한 머리글 아래에 놓인다.
 *
 * **항목 순서는 건드리지 않는다** — 커서 인덱스가 컨트롤러가 준 목록의 인덱스와 같아야
 * Enter 가 화면에서 보이는 것을 실행한다.
 */
function withGroupHeadings(items: readonly PaletteItem[]): Row[] {
  const rows: Row[] = [];
  let previous: PaletteGroup | undefined;
  for (const [index, item] of items.entries()) {
    if (item.group !== previous) {
      previous = item.group;
      rows.push({ kind: 'heading', group: item.group, at: index });
    }
    rows.push({ kind: 'item', item, index });
  }
  return rows;
}
