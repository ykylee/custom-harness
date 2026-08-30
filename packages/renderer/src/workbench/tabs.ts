// 탭 타깃 모델 (WBS 6.2, workbench-tabs §1) — 순수 함수만 둔다(스토어 없이 테스트 가능).
//
// 원칙: 탭은 *무엇을 보느냐*이지 무엇을 소유하느냐가 아니다. 탭을 닫는 것은 레이아웃 변경이고
// 대상(세션·터미널)의 수명과 무관하다.

export type TabTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'terminal'; terminalId: string }
  | { kind: 'files' }
  | { kind: 'file'; path: string }
  | { kind: 'diff'; scope: 'working' }
  | { kind: 'diff'; scope: 'commit'; sha: string };

export interface Tab {
  id: string;
  target: TabTarget;
}

export interface LayoutState {
  tabs: Tab[];
  /** 포커스 탭 id */
  active: string | null;
  /** 보조 페인 — row = 좌우, column = 상하 */
  split: { direction: 'row' | 'column'; secondary: string } | null;
}

export const emptyLayout = (): LayoutState => ({ tabs: [], active: null, split: null });

/** 같은 대상은 한 번만 열린다 — id 를 타깃에서 결정적으로 유도한다 (workbench-tabs §1.2) */
export function tabId(target: TabTarget): string {
  switch (target.kind) {
    case 'session':
      return `session:${target.sessionId}`;
    case 'terminal':
      return `terminal:${target.terminalId}`;
    case 'files':
      return 'files';
    case 'file':
      return `file:${target.path}`;
    case 'diff':
      return target.scope === 'working' ? 'diff:working' : `diff:${target.sha}`;
  }
}

/** 이미 열려 있으면 새로 만들지 않고 포커스만 옮긴다 */
export function openTab(layout: LayoutState, target: TabTarget): LayoutState {
  const id = tabId(target);
  if (layout.tabs.some((tab) => tab.id === id)) return { ...layout, active: id };
  return { ...layout, tabs: [...layout.tabs, { id, target }], active: id };
}

export function closeTab(layout: LayoutState, id: string): LayoutState {
  const index = layout.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return layout;
  const tabs = layout.tabs.filter((tab) => tab.id !== id);
  const split = layout.split?.secondary === id ? null : layout.split;
  const active =
    layout.active === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : layout.active;
  return { tabs, active, split };
}

export function setActiveTab(layout: LayoutState, id: string): LayoutState {
  return layout.tabs.some((tab) => tab.id === id) ? { ...layout, active: id } : layout;
}

export function setSplit(
  layout: LayoutState,
  direction: 'row' | 'column' | null,
  secondary?: string,
): LayoutState {
  if (direction === null) return { ...layout, split: null };
  const candidate = secondary ?? layout.tabs.find((tab) => tab.id !== layout.active)?.id;
  if (candidate === undefined || candidate === layout.active) return { ...layout, split: null };
  return { ...layout, split: { direction, secondary: candidate } };
}

export function targetOf(
  layout: LayoutState,
  id: string | null | undefined,
): TabTarget | undefined {
  if (id === null || id === undefined) return undefined;
  return layout.tabs.find((tab) => tab.id === id)?.target;
}

/**
 * 복원 — 살아 있지 않은 타깃은 조용히 버린다 (workbench-tabs §1.3).
 * 복원 실패가 화면 전체를 막지 않는 것이 목적이다.
 */
export function restoreLayout(
  saved: unknown,
  alive: { sessionIds: Set<string>; terminalIds: Set<string> },
): LayoutState {
  const tabs: Tab[] = [];
  for (const entry of readTabs(saved)) {
    const target = entry.target;
    if (target.kind === 'session' && !alive.sessionIds.has(target.sessionId)) continue;
    if (target.kind === 'terminal' && !alive.terminalIds.has(target.terminalId)) continue;
    if (tabs.some((tab) => tab.id === entry.id)) continue;
    tabs.push(entry);
  }
  const savedRecord = asRecord(saved);
  const savedActive = typeof savedRecord?.active === 'string' ? savedRecord.active : null;
  const active =
    savedActive !== null && tabs.some((tab) => tab.id === savedActive)
      ? savedActive
      : (tabs[0]?.id ?? null);

  const savedSplit = asRecord(savedRecord?.split);
  const secondary = typeof savedSplit?.secondary === 'string' ? savedSplit.secondary : undefined;
  const direction: 'row' | 'column' | undefined =
    savedSplit?.direction === 'row' || savedSplit?.direction === 'column'
      ? savedSplit.direction
      : undefined;
  const split =
    direction !== undefined &&
    secondary !== undefined &&
    secondary !== active &&
    tabs.some((tab) => tab.id === secondary)
      ? { direction, secondary }
      : null;

  return { tabs, active, split };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 구형 배치(문자열 세션 ID 배열)도 읽는다 — 저장은 항상 새 형식으로 한다 (§1.4) */
function readTabs(saved: unknown): Tab[] {
  const record = asRecord(saved);
  const raw = Array.isArray(record?.tabs) ? record.tabs : [];
  const out: Tab[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      out.push({ id: `session:${entry}`, target: { kind: 'session', sessionId: entry } });
      continue;
    }
    const item = asRecord(entry);
    const target = normalizeTarget(item?.target);
    if (target === undefined) continue;
    out.push({ id: tabId(target), target });
  }
  return out;
}

function normalizeTarget(value: unknown): TabTarget | undefined {
  const record = asRecord(value);
  switch (record?.kind) {
    case 'session':
      return typeof record.sessionId === 'string'
        ? { kind: 'session', sessionId: record.sessionId }
        : undefined;
    case 'terminal':
      return typeof record.terminalId === 'string'
        ? { kind: 'terminal', terminalId: record.terminalId }
        : undefined;
    case 'files':
      return { kind: 'files' };
    case 'file':
      return typeof record.path === 'string' ? { kind: 'file', path: record.path } : undefined;
    case 'diff':
      if (record.scope === 'working') return { kind: 'diff', scope: 'working' };
      return record.scope === 'commit' && typeof record.sha === 'string'
        ? { kind: 'diff', scope: 'commit', sha: record.sha }
        : undefined;
    default:
      return undefined;
  }
}
