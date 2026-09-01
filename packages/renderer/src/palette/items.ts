// 커맨드 팔레트 항목 모델·매칭 (M7 WBS 7.4.2, FR-9.4) — 순수 함수만 둔다.
//
// 팔레트의 어려움은 검색이 아니라 **한 줄에 세우기**다. 세션·워크스페이스·파일·명령·
// 대화 내용은 출처도 지연 시간도 다른데 사용자는 목록 하나를 위아래로 훑는다.
// 그래서 점수 계산을 여기 한 곳에만 둔다 — 소스별로 흩으면 파일만 다른 규칙으로 정렬된다.
//
// 데몬이 이미 걸러 온 것(파일 후보·타임라인 히트)도 여기서 다시 점수를 매긴다.
// 데몬은 "무엇이 후보인가"를, 렌더러는 "어떤 순서인가"를 정한다.

import type { SearchHit, SessionSummary, Workspace } from '@custom-harness/protocol';

/** 그룹 표시 순서이자 동점 시 우선순위 — 사용자가 의도한 것에 가까운 쪽이 앞이다 */
export const PALETTE_GROUPS = ['command', 'session', 'workspace', 'file', 'timeline'] as const;
export type PaletteGroup = (typeof PALETTE_GROUPS)[number];

export const PALETTE_GROUP_LABEL: Record<PaletteGroup, string> = {
  command: '명령',
  session: '세션',
  workspace: '워크스페이스',
  file: '파일',
  timeline: '대화 내용',
};

/** 실행할 동작 — 컨트롤러가 해석한다(항목이 컨트롤러를 알면 순수성이 깨진다) */
export type PaletteAction =
  | { kind: 'command'; id: PaletteCommandId }
  | { kind: 'open-session'; sessionId: string }
  | { kind: 'select-workspace'; workspaceId: string }
  | { kind: 'open-file'; path: string }
  | { kind: 'open-timeline'; sessionId: string; seq: number };

export type PaletteCommandId =
  | 'new-session'
  | 'new-workspace'
  | 'new-terminal'
  | 'open-files'
  | 'open-diff'
  | 'open-settings'
  | 'close-tab'
  | 'split-row'
  | 'split-column'
  | 'split-off';

export interface PaletteItem {
  /** 목록 키이자 선택 상태의 동일성 판단 — 질의가 바뀌어도 같은 대상이면 같다 */
  id: string;
  group: PaletteGroup;
  label: string;
  /** 라벨 아래 보조 설명 (경로·워크스페이스·하네스 등) */
  detail?: string;
  action: PaletteAction;
  /** 정렬 점수 — 낮을수록 앞. `rankItems` 가 채운다 */
  score?: number;
}

export interface PaletteSources {
  sessions: readonly SessionSummary[];
  workspaces: readonly Workspace[];
  /** 데몬이 고른 파일 후보 (file.search) */
  filePaths: readonly string[];
  /** 타임라인 검색 결과 (session.search) */
  hits: readonly SearchHit[];
  /** 지금 무엇을 볼 수 있는지가 명령 목록을 정한다 */
  context: { hasActiveTab: boolean; hasWorkspace: boolean; isSplit: boolean };
}

interface CommandSpec {
  id: PaletteCommandId;
  label: string;
  detail?: string;
  /** 지금 쓸 수 없는 명령은 아예 안 보인다 — 눌러도 아무 일이 없는 항목이 더 나쁘다 */
  available?: (context: PaletteSources['context']) => boolean;
}

const COMMANDS: CommandSpec[] = [
  { id: 'new-session', label: '새 세션', detail: 'Mod+N' },
  { id: 'new-workspace', label: '새 워크스페이스' },
  {
    id: 'new-terminal',
    label: '새 터미널',
    available: (context) => context.hasWorkspace,
  },
  {
    id: 'open-files',
    label: '파일 탐색기 열기',
    available: (context) => context.hasWorkspace,
  },
  {
    id: 'open-diff',
    label: '변경사항 보기',
    available: (context) => context.hasWorkspace,
  },
  { id: 'open-settings', label: '설정 열기' },
  {
    id: 'close-tab',
    label: '탭 닫기',
    detail: 'Mod+W',
    available: (context) => context.hasActiveTab,
  },
  {
    id: 'split-row',
    label: '좌우로 분할',
    available: (context) => context.hasActiveTab,
  },
  {
    id: 'split-column',
    label: '상하로 분할',
    available: (context) => context.hasActiveTab,
  },
  {
    id: 'split-off',
    label: '분할 해제',
    available: (context) => context.isSplit,
  },
];

/** 질의가 비었을 때 보여 줄 개수 — 팔레트가 빈 화면으로 열리면 무엇을 칠지도 모른다 */
const EMPTY_QUERY_LIMIT = 8;
const RESULT_LIMIT = 40;

/**
 * 점수: 낮을수록 앞. `undefined` 는 매치 실패다.
 *
 * 부분 문자열이 부분 수열을 이긴다 — `index` 로 `index.ts` 를 찾는 것이
 * `i…n…d…e…x` 로 흩어져 맞는 것보다 사용자 의도에 가깝다. 같은 방식 안에서는
 * **매치가 이른 쪽**이 앞이다(파일명은 뒤쪽에 오므로 경로 꼬리 매치가 유리해진다).
 */
export function scoreMatch(text: string, query: string): number | undefined {
  if (query === '') return 0;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const direct = haystack.indexOf(needle);
  if (direct !== -1) return direct;
  const spread = subsequenceSpan(haystack, needle);
  // 부분 수열은 어떤 경우에도 부분 문자열 뒤로 — 상수를 더해 두 영역을 분리한다
  return spread === undefined ? undefined : 10_000 + spread;
}

/** 부분 수열이 차지한 폭 — 글자들이 모여 있을수록 좋은 매치다 */
function subsequenceSpan(haystack: string, needle: string): number | undefined {
  let at = 0;
  let first = -1;
  for (const char of needle) {
    at = haystack.indexOf(char, at);
    if (at === -1) return undefined;
    if (first === -1) first = at;
    at += 1;
  }
  return at - first;
}

/** 소스 전부를 한 목록으로 — 질의가 비면 "지금 할 만한 것"을 보여 준다 */
export function buildItems(query: string, sources: PaletteSources): PaletteItem[] {
  const trimmed = query.trim();
  const candidates: PaletteItem[] = [
    ...commandItems(sources.context),
    ...sessionItems(sources.sessions),
    ...workspaceItems(sources.workspaces),
    ...fileItems(sources.filePaths),
    ...timelineItems(sources.hits),
  ];
  return rankItems(candidates, trimmed);
}

/**
 * 점수를 매기고 정렬한다.
 *
 * **대화 내용(timeline)은 점수 매김에서 빼둔다** — 데몬이 이미 최근순으로 골라 온
 * 결과이고, 조각난 본문에 라벨 점수를 다시 매기면 데몬의 순서를 뒤엎으면서 근거는
 * 더 약해진다. 그룹 안 순서는 온 그대로 유지한다.
 */
export function rankItems(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const scored: PaletteItem[] = [];
  for (const item of items) {
    if (item.group === 'timeline') {
      scored.push({ ...item, score: 0 });
      continue;
    }
    const score = scoreMatch(item.label, query) ?? scoreMatch(item.detail ?? '', query);
    if (score === undefined) continue;
    scored.push({ ...item, score });
  }
  const groupRank = (group: PaletteGroup): number => PALETTE_GROUPS.indexOf(group);
  scored.sort(
    (a, b) =>
      (a.score ?? 0) - (b.score ?? 0) ||
      groupRank(a.group) - groupRank(b.group) ||
      a.label.localeCompare(b.label),
  );
  // 질의가 비면 목록 전체가 동점이라 정렬이 무의미하다 — 그룹 순서대로 앞부분만 보여 준다
  if (query === '') {
    const byGroup = [...scored].sort((a, b) => groupRank(a.group) - groupRank(b.group));
    return byGroup.slice(0, EMPTY_QUERY_LIMIT);
  }
  return scored.slice(0, RESULT_LIMIT);
}

function commandItems(context: PaletteSources['context']): PaletteItem[] {
  return COMMANDS.filter((command) => command.available?.(context) ?? true).map((command) => ({
    id: `command:${command.id}`,
    group: 'command' as const,
    label: command.label,
    ...(command.detail !== undefined ? { detail: command.detail } : {}),
    action: { kind: 'command' as const, id: command.id },
  }));
}

function sessionItems(sessions: readonly SessionSummary[]): PaletteItem[] {
  return sessions.map((session) => ({
    id: `session:${session.sessionId}`,
    group: 'session' as const,
    // 제목은 7.6 이 채운다 — 그때까지는 세션 id 가 유일한 식별자다
    label: session.title ?? session.sessionId,
    detail: `${session.harness} · ${session.status}`,
    action: { kind: 'open-session' as const, sessionId: session.sessionId },
  }));
}

function workspaceItems(workspaces: readonly Workspace[]): PaletteItem[] {
  return workspaces.map((workspace) => ({
    id: `workspace:${workspace.id}`,
    group: 'workspace' as const,
    label: workspace.displayName,
    detail: workspace.cwd,
    action: { kind: 'select-workspace' as const, workspaceId: workspace.id },
  }));
}

function fileItems(paths: readonly string[]): PaletteItem[] {
  return paths.map((path) => ({
    id: `file:${path}`,
    group: 'file' as const,
    label: path.slice(path.lastIndexOf('/') + 1),
    detail: path,
    action: { kind: 'open-file' as const, path },
  }));
}

function timelineItems(hits: readonly SearchHit[]): PaletteItem[] {
  return hits.map((hit) => ({
    id: `timeline:${hit.sessionId}:${hit.seq}`,
    group: 'timeline' as const,
    label: hit.snippet,
    detail: `${hit.title ?? hit.sessionId} · ${hit.harness}`,
    action: { kind: 'open-timeline' as const, sessionId: hit.sessionId, seq: hit.seq },
  }));
}
