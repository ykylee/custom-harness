// 앱 상태 스토어·컨트롤러 (WBS 1.5.1·2.4) — 데몬 RPC/이벤트를 상태로 투영한다.
// 컨트롤러는 전송 계층을 인터페이스로 받는다 (컴포넌트 테스트에서 fake 주입).
// M2 2.4: 탭·분할 레이아웃(FR-3.3.2/3, localStorage 복원), 자동 승인 opt-in(FR-3.4.3),
// 네이티브 알림(FR-3.5.2 — Electron 렌더러의 Notification API), 하네스 상태 패널 데이터.
import type {
  BundleInfo,
  HarnessId,
  HarnessInfo,
  PermissionOutcome,
  ProbeResult,
  Project,
  LicenseIndex,
  SearchHit,
  SessionSummary,
  SessionUsageTree,
  Terminal,
  Workspace,
  WorkspaceSetupState,
} from '@custom-harness/protocol';
import type { ConnectionState, DaemonClient } from '../ws/client.js';
import {
  closeTab as closeTabIn,
  emptyLayout,
  openTab,
  restoreLayout as restoreLayoutFrom,
  setActiveTab as setActiveTabIn,
  setSplit as setSplitIn,
  targetOf,
  type LayoutState,
  type TabTarget,
} from '../workbench/tabs.js';
import {
  buildItems,
  type PaletteAction,
  type PaletteCommandId,
  type PaletteItem,
} from '../palette/items.js';
import { applyEvent, applyEvents, emptySessionView, type SessionView } from '../timeline.js';
import { Store } from './store.js';

export type Route =
  'onboarding' | 'main' | 'settings' | 'workspace-create' | 'session-create' | 'about';

/** 앱 정보 화면의 데이터 (WBS 3.3.2, FR-4.5) — 전부 데몬이 번들에서 읽어 온 것이다 */
export interface AboutInfo {
  version: string;
  protocolVersion: number;
  bundle?: BundleInfo;
  licenses: LicenseIndex;
}

/** 라이선스 원문 한 조각 — 20MB 고지를 이어 읽는다 */
export interface LicenseChunk {
  path: string;
  size: number;
  offset: number;
  nextOffset: number;
  text: string;
  eof: boolean;
}

export interface GatewaySettings {
  baseUrl: string;
  defaultModel?: string;
  models: { id: string; name?: string }[];
}

export interface KeyState {
  present: boolean;
  fallback: boolean;
}

export type { LayoutState, TabTarget } from '../workbench/tabs.js';

export interface FileEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size?: number;
}

export interface FileContent {
  path: string;
  size: number;
  text?: string;
  binary: boolean;
  tooLarge: boolean;
}

export interface DiffState {
  scope: 'working' | 'commit';
  patch: string;
  truncated: boolean;
  untracked: string[];
  unavailable?: string;
}

export interface AppState {
  connection: ConnectionState;
  route: Route;
  bootstrapped: boolean;
  gateway: GatewaySettings | null;
  keyState: KeyState | null;
  maxSessions: number | null;
  harnesses: HarnessInfo[];
  /** 프로젝트 → 워크스페이스 → 세션 3계층 (WBS 5.6.1) */
  projects: Project[];
  workspaces: Workspace[];
  /** 세션을 만들 대상 워크스페이스 — localStorage 영속 */
  activeWorkspaceId: string | null;
  sessions: SessionSummary[];
  /** 워크스페이스별 배치 (workbench-tabs §1.3) — 워크스페이스를 바꾸면 그 배치가 돌아온다 */
  layouts: Record<string, LayoutState>;
  views: Record<string, SessionView>;
  /** 데몬 소유 터미널 목록 (WBS 6.3) */
  terminals: Terminal[];
  /** 변경사항 캐시 (WBS 6.5) — 키는 diffKey() */
  diffs: Record<string, DiffState>;
  /** 세션 한정 자동 승인 opt-in (FR-3.4.3) — 렌더러 수명, 영속화하지 않는다 */
  autoApprove: Record<string, boolean>;
  /** 네이티브 알림 on/off (FR-3.5.2) — localStorage 영속 */
  notificationsEnabled: boolean;
  /**
   * 위임 비용 트리 (M7 7.3.3) — 자식 트랙이 소비한다. 화면에 떠 있는 세션 탭만 채운다.
   * 합산을 렌더러에서 다시 계산하지 않는 이유: 데몬의 게이트가 세는 값과 갈라지면
   * 사용자가 보는 "자식 2개"와 상한이 막는 기준이 달라진다 (7.3.2 결정).
   */
  usageTrees: Record<string, SessionUsageTree>;
  /** 하네스 상태 패널 (FR-3.6.3) — harness.probe 결과 캐시 */
  probes: Record<string, ProbeResult>;
  /** 커맨드 팔레트 (M7 7.4.2, FR-9.4) */
  palette: PaletteState;
  /** 마지막 전역 오류 (RPC 실패 등) — 배너 표시용 */
  lastError: string | null;
}

export interface PaletteState {
  open: boolean;
  query: string;
  /**
   * 원격 결과(파일·대화 내용)가 **어느 질의의 답인지**. 늦게 온 옛 응답이 새 결과를
   * 덮어쓰는 것을 막는 유일한 근거다 — 타이핑마다 요청이 나가므로 순서 보장이 없다.
   */
  resultsFor: string;
  filePaths: string[];
  hits: SearchHit[];
  /** 원격 조회가 도는 중 — 로컬 결과는 이미 떠 있으므로 화면을 막지는 않는다 */
  loading: boolean;
}

export function emptyPaletteState(): PaletteState {
  return { open: false, query: '', resultsFor: '', filePaths: [], hits: [], loading: false };
}

const LAYOUT_KEY = 'custom-harness.layout';
const WORKSPACE_KEY = 'custom-harness.active-workspace';
const NOTIFICATIONS_KEY = 'custom-harness.notifications';

/** 주의 사유 → 알림 제목 (M7 7.1.3) — 사유는 데몬 정책 모듈이 정한다 */
const ATTENTION_TITLE: Record<'permission' | 'error' | 'finished', string> = {
  permission: '승인 대기',
  error: '세션 에러',
  finished: '턴 완료',
};

/** window.localStorage 명시 참조 — Node 22 의 전역 localStorage(제한 구현)와 혼동 방지 */
function storage(): Storage | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

function loadPersisted<T>(key: string): T | undefined {
  try {
    const raw = storage()?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined; // 브라우저 비상 경로·테스트 환경 — 복원 생략
  }
}

function persist(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    /* 영속 실패는 무해 — 다음 실행에서 기본 배치 */
  }
}

export function initialAppState(): AppState {
  return {
    connection: 'closed',
    route: 'main',
    bootstrapped: false,
    gateway: null,
    keyState: null,
    maxSessions: null,
    harnesses: [],
    projects: [],
    workspaces: [],
    activeWorkspaceId: loadPersisted<string>(WORKSPACE_KEY) ?? null,
    sessions: [],
    layouts: {},
    views: {},
    terminals: [],
    autoApprove: {},
    usageTrees: {},
    notificationsEnabled: loadPersisted<boolean>(NOTIFICATIONS_KEY) ?? true,
    probes: {},
    diffs: {},
    palette: emptyPaletteState(),
    lastError: null,
  };
}

/** DaemonClient 의 컨트롤러 사용 표면 — 테스트 fake 주입 지점 */
export interface DaemonTransport {
  rpc(type: string, params?: Record<string, unknown>): Promise<unknown>;
  /** 터미널 바이너리 채널 (WBS 6.3) — 배선되지 않은 전송(테스트 fake)에서는 없을 수 있다 */
  onTerminalData?: DaemonClient['onTerminalData'];
  sendTerminalFrame?: DaemonClient['sendTerminalFrame'];
  onEvent(listener: Parameters<DaemonClient['onEvent']>[0]): () => void;
  onState(listener: (state: ConnectionState) => void): () => void;
  onReconnected(listener: () => void): () => void;
  start(): void;
  stop(): void;
}

/** 변경사항 캐시 키 — working 은 하나, 커밋은 sha 별 */
export function diffKey(scope: 'working' | 'commit', sha?: string): string {
  return scope === 'working' ? 'working' : `commit:${sha ?? ''}`;
}

export class AppController {
  readonly store = new Store<AppState>(initialAppState());
  /** 현재 구독 중인 워크스페이스 — 워크스페이스를 바꾸면 옮겨 건다 */
  private diffSubscription: string | undefined;
  /** 팔레트 원격 조회 일련번호 (M7 7.4.2) — 늦게 온 옛 응답을 버리는 근거 */
  private paletteSeq = 0;

  constructor(private readonly client: DaemonTransport) {
    client.onState((connection) => {
      this.store.set({ connection });
      if (connection === 'connected' && !this.store.get().bootstrapped) {
        void this.bootstrap();
      }
    });
    client.onEvent((event) => {
      // 레지스트리 이벤트는 세션 봉투가 없다 — 신호만 받고 목록을 다시 읽는다 (WBS 5.2.3)
      if (event.type === 'project_changed') {
        void this.refreshProjects();
        return;
      }
      if (event.type === 'workspace_changed') {
        void this.refreshWorkspaces();
        return;
      }
      if (event.type === 'terminal_changed') {
        void this.refreshTerminals();
        return;
      }
      if (event.type === 'diff_changed') {
        // 신호만 받고 내용은 회수한다 — 이벤트에 patch 를 싣지 않는 이유(크기)
        if (event.workspaceId === this.store.get().activeWorkspaceId) void this.refreshDiff();
        return;
      }
      this.store.set((prev) => {
        const view = prev.views[event.sessionId] ?? emptySessionView();
        return { ...prev, views: { ...prev.views, [event.sessionId]: applyEvent(view, event) } };
      });
      if (event.type === 'session_status_changed') void this.refreshSessions();
      if (event.type === 'permission_requested') this.onPermissionRequested(event.sessionId, event);
      if (event.type === 'turn_completed' || event.type === 'turn_failed') {
        void this.refreshSessions(); // 목록 usage 요약 갱신 (FR-3.7)
      }
      // 알림은 **데몬의 주의 상태 전이**만 소비한다 (M7 7.1.3, FR-9.1) — 턴 종료·승인
      // 요청을 각자 해석하던 로컬 규칙을 제거했다. 버킷·배지와 같은 하나의 답을 쓴다.
      if (event.type === 'attention_changed') this.onAttentionChanged(event);
      // 제목은 목록을 다시 읽지 않고 그 세션만 갱신한다 (M7 7.6.1) — LLM 모드는 임의
      // 시점에 도착하므로, 목록 갱신을 기다리면 그때까지 낡은 이름이 탭에 남는다
      if (event.type === 'session_title_changed') {
        const { sessionId, title } = event;
        this.store.set((prev) => ({
          ...prev,
          sessions: prev.sessions.map((session) =>
            session.sessionId === sessionId ? { ...session, title } : session,
          ),
        }));
      }
    });
    client.onReconnected(() => void this.resync());
  }

  /** 터미널 뷰가 쓰는 전송 표면 — 바이너리 채널까지 포함한다 */
  get terminalTransport(): {
    rpc: DaemonTransport['rpc'];
    onTerminalData: NonNullable<DaemonTransport['onTerminalData']>;
    sendTerminalFrame: NonNullable<DaemonTransport['sendTerminalFrame']>;
  } {
    return {
      rpc: (type, params) => this.client.rpc(type, params),
      onTerminalData: (listener) => this.client.onTerminalData?.(listener) ?? (() => undefined),
      sendTerminalFrame: (frame) => this.client.sendTerminalFrame?.(frame),
    };
  }

  start(): void {
    this.client.start();
  }

  stop(): void {
    this.client.stop();
  }

  /** 최초 연결 시 상태 적재 — 온보딩 필요 여부 판정 (FR-3.8) + 배치 복원 (FR-3.3.2) */
  async bootstrap(): Promise<void> {
    try {
      await this.refreshConfig();
      await this.refreshHarnesses();
      await this.refreshRegistries();
      await this.refreshSessions();
      await this.refreshTerminals();
      this.diffSubscription = undefined; // 데몬은 구독을 기억하지 않는다 — 다시 건다
      await this.subscribeDiff();
      this.restoreLayout();
      const { gateway, keyState } = this.store.get();
      this.store.set({
        bootstrapped: true,
        route: gateway === null || keyState?.present !== true ? 'onboarding' : 'main',
      });
    } catch (error) {
      this.reportError(error);
    }
  }

  /** 재연결 재동기화 — 목록 + 열린 페인들의 타임라인 갭 회수 (protocol-design §5) */
  async resync(): Promise<void> {
    try {
      await this.refreshSessions();
      await this.refreshTerminals();
      // 열린 세션 페인의 타임라인 갭만 회수한다. 터미널은 재연결 후 뷰가 다시 attach 한다
      for (const tabId of this.openTabIds()) {
        const target = targetOf(this.layout, tabId);
        if (target?.kind === 'session') await this.syncTimelineGap(target.sessionId);
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  private async syncTimelineGap(sessionId: string): Promise<void> {
    const fromSeq = (this.store.get().views[sessionId]?.lastSeq ?? -1) + 1;
    const result = (await this.client.rpc('session.timeline', { sessionId, fromSeq })) as {
      events: Parameters<typeof applyEvents>[1];
    };
    this.store.set((prev) => {
      const view = prev.views[sessionId] ?? emptySessionView();
      return { ...prev, views: { ...prev.views, [sessionId]: applyEvents(view, result.events) } };
    });
  }

  async refreshConfig(): Promise<void> {
    const result = (await this.client.rpc('config.get')) as {
      values: { gateway: GatewaySettings | null; keyState: KeyState; maxSessions?: number };
    };
    this.store.set({
      gateway: result.values.gateway,
      keyState: result.values.keyState,
      maxSessions: result.values.maxSessions ?? null,
    });
  }

  async refreshHarnesses(): Promise<void> {
    const result = (await this.client.rpc('harness.list')) as { harnesses: HarnessInfo[] };
    this.store.set({ harnesses: result.harnesses });
  }

  async refreshSessions(): Promise<void> {
    const result = (await this.client.rpc('session.list')) as { sessions: SessionSummary[] };
    this.store.set({ sessions: result.sessions });
    // 열린 세션 탭의 자식 트랙도 같이 갱신한다 — 자식의 상태·토큰이 바뀌는 시점이
    // 곧 목록이 바뀌는 시점이고, 여기서 안 하면 트랙이 탭을 다시 열 때까지 낡는다
    for (const tabId of this.openTabIds()) {
      const target = targetOf(this.layout, tabId);
      if (target?.kind === 'session') void this.refreshUsageTree(target.sessionId);
    }
  }

  // ── 프로젝트·워크스페이스 (WBS 5.6) ───────────────────────────────────────

  /**
   * 프로젝트·워크스페이스 적재. 데몬이 이 도메인을 배선하지 않았어도(구버전·축소 기동)
   * 기동 자체는 성공해야 한다 — 실패는 빈 목록으로 흡수하고 나머지 화면을 살린다.
   */
  async refreshRegistries(): Promise<void> {
    try {
      await this.refreshProjects();
      await this.refreshWorkspaces();
    } catch {
      this.store.set({ projects: [], workspaces: [] });
    }
  }

  async refreshProjects(): Promise<void> {
    const result = (await this.client.rpc('project.list')) as { projects?: Project[] };
    this.store.set({ projects: result.projects ?? [] });
  }

  async refreshWorkspaces(): Promise<void> {
    const result = (await this.client.rpc('workspace.list')) as { workspaces?: Workspace[] };
    const workspaces = result.workspaces ?? [];
    this.store.set((prev) => {
      // 활성 워크스페이스가 사라졌으면(아카이브 등) 첫 워크스페이스로 내려앉는다
      const active =
        prev.activeWorkspaceId !== null &&
        workspaces.some((workspace) => workspace.id === prev.activeWorkspaceId)
          ? prev.activeWorkspaceId
          : (workspaces[0]?.id ?? null);
      if (active !== prev.activeWorkspaceId) persist(WORKSPACE_KEY, active);
      return { ...prev, workspaces, activeWorkspaceId: active };
    });
  }

  // ── 파일·변경사항 (WBS 6.4·6.5) ───────────────────────────────────────────

  async listDirectory(path: string): Promise<{ entries: FileEntry[]; truncated: boolean }> {
    const workspaceId = this.store.get().activeWorkspaceId;
    if (workspaceId === null) return { entries: [], truncated: false };
    return (await this.client.rpc('file.list', { workspaceId, path })) as {
      entries: FileEntry[];
      truncated: boolean;
    };
  }

  // ── 앱 정보·라이선스 고지 (WBS 3.3.2, FR-4.5) ─────────────────────────────

  async about(): Promise<AboutInfo> {
    return (await this.client.rpc('system.about', {})) as AboutInfo;
  }

  async readLicense(path: string, offset: number): Promise<LicenseChunk> {
    return (await this.client.rpc('system.license.read', { path, offset })) as LicenseChunk;
  }

  async readFile(path: string): Promise<FileContent> {
    const workspaceId = this.store.get().activeWorkspaceId;
    if (workspaceId === null) throw new Error('워크스페이스가 선택되지 않음');
    return (await this.client.rpc('file.read', { workspaceId, path })) as FileContent;
  }

  // ── 워크스페이스 스크립트 (WBS 6.6) ───────────────────────────────────────

  async listWorkspaceScripts(
    workspaceId: string,
  ): Promise<{ scripts: { name: string; command: string }[]; trusted: boolean }> {
    return (await this.client.rpc('workspace.scripts.list', { workspaceId })) as {
      scripts: { name: string; command: string }[];
      trusted: boolean;
    };
  }

  /** 스크립트를 감독 터미널로 실행하고 그 탭을 연다 */
  async runWorkspaceScript(workspaceId: string, name: string): Promise<void> {
    try {
      const result = (await this.client.rpc('workspace.scripts.run', {
        workspaceId,
        name,
        cols: 100,
        rows: 30,
      })) as { terminal: Terminal };
      await this.refreshTerminals();
      this.openTarget({ kind: 'terminal', terminalId: result.terminal.id });
    } catch (error) {
      this.reportError(error);
    }
  }

  /** 파일을 탭으로 연다 — 응답·툴 카드의 경로 링크가 쓰는 진입점 (WBS 6.4.3) */
  openFile(path: string): void {
    this.openTarget({ kind: 'file', path });
  }

  /** 현재 워크스페이스의 변경사항 회수 + 구독 유지 */
  async refreshDiff(scope: 'working' | 'commit' = 'working', sha?: string): Promise<void> {
    const workspaceId = this.store.get().activeWorkspaceId;
    if (workspaceId === null) return;
    try {
      const result = (await this.client.rpc('diff.get', {
        workspaceId,
        scope,
        ...(sha !== undefined ? { sha } : {}),
      })) as DiffState;
      this.store.set((prev) => ({
        ...prev,
        diffs: { ...prev.diffs, [diffKey(scope, sha)]: result },
      }));
    } catch (error) {
      this.reportError(error);
    }
  }

  /** 변경사항 구독 — 재연결 시 클라이언트가 다시 건다(데몬은 구독을 영속하지 않는다) */
  async subscribeDiff(): Promise<void> {
    const workspaceId = this.store.get().activeWorkspaceId;
    if (workspaceId === null || this.diffSubscription === workspaceId) return;
    if (this.diffSubscription !== undefined) {
      const previous = this.diffSubscription;
      this.diffSubscription = undefined;
      void this.client.rpc('diff.unsubscribe', { workspaceId: previous }).catch(() => undefined);
    }
    try {
      await this.client.rpc('diff.subscribe', { workspaceId });
      this.diffSubscription = workspaceId;
      await this.refreshDiff();
    } catch (error) {
      this.reportError(error);
    }
  }

  // ── 터미널 (WBS 6.3) ──────────────────────────────────────────────────────

  async refreshTerminals(): Promise<void> {
    try {
      const result = (await this.client.rpc('terminal.list')) as { terminals?: Terminal[] };
      this.store.set({ terminals: result.terminals ?? [] });
    } catch {
      this.store.set({ terminals: [] }); // 터미널 미배선 데몬에서도 나머지 화면은 살린다
    }
  }

  /** 터미널을 만들고 바로 탭으로 연다 */
  async createTerminal(cols = 80, rows = 24): Promise<void> {
    const workspaceId = this.store.get().activeWorkspaceId;
    if (workspaceId === null) return;
    try {
      const result = (await this.client.rpc('terminal.create', { workspaceId, cols, rows })) as {
        terminal: Terminal;
      };
      await this.refreshTerminals();
      this.openTarget({ kind: 'terminal', terminalId: result.terminal.id });
    } catch (error) {
      this.reportError(error);
    }
  }

  async killTerminal(terminalId: string): Promise<void> {
    try {
      await this.client.rpc('terminal.kill', { terminalId });
      await this.refreshTerminals();
    } catch (error) {
      this.reportError(error);
    }
  }

  selectWorkspace(workspaceId: string): void {
    persist(WORKSPACE_KEY, workspaceId);
    this.store.set({ activeWorkspaceId: workspaceId, diffs: {} });
    void this.subscribeDiff(); // 변경사항 구독을 새 워크스페이스로 옮긴다
  }

  /** 디렉토리를 프로젝트로 연다 — 기본 워크스페이스가 함께 생긴다 (D-2) */
  async openProject(root: string): Promise<void> {
    const result = (await this.client.rpc('project.open', { root })) as {
      project: Project;
      workspace: Workspace;
    };
    await this.refreshProjects();
    await this.refreshWorkspaces();
    this.selectWorkspace(result.workspace.id);
  }

  async createWorkspace(params: {
    projectId: string;
    isolation: 'directory' | 'worktree';
    cwd?: string;
    branch?: string;
    baseBranch?: string;
    displayName?: string;
  }): Promise<void> {
    const result = (await this.client.rpc('workspace.create', { ...params })) as {
      workspace: Workspace;
    };
    await this.refreshWorkspaces();
    this.selectWorkspace(result.workspace.id);
  }

  async renameWorkspace(workspaceId: string, displayName: string): Promise<void> {
    await this.client.rpc('workspace.update', { workspaceId, displayName });
    await this.refreshWorkspaces();
  }

  async setWorkspaceLabels(workspaceId: string, labels: Record<string, string>): Promise<void> {
    await this.client.rpc('workspace.update', { workspaceId, labels });
    await this.refreshWorkspaces();
  }

  async archiveWorkspace(workspaceId: string, removeCheckout = false): Promise<void> {
    await this.client.rpc('workspace.archive', { workspaceId, removeCheckout });
    await this.refreshWorkspaces();
    await this.refreshSessions();
  }

  /**
   * setup 실행 흐름 (FR-7.5 신뢰 경계의 UI 측 절반) — 먼저 신뢰 없이 시도해 데몬이
   * `pending` 을 돌려주면 사용자에게 동의를 구하고, 동의한 경우에만 신뢰를 부여해 재시도한다.
   * 사용자가 거절하면 워크스페이스는 pending 인 채로 남는다.
   */
  async confirmAndRunSetup(
    workspaceId: string,
    confirm: (detail: string) => boolean = (detail) =>
      typeof window !== 'undefined' && window.confirm(detail),
  ): Promise<void> {
    try {
      const first = await this.runWorkspaceSetup(workspaceId);
      if (first.setupState !== 'pending') return;
      const workspace = this.store.get().workspaces.find((entry) => entry.id === workspaceId);
      const detail = `이 프로젝트의 설정 파일(setup)을 실행합니다. 저장소에 담긴 명령이 그대로 실행되므로 내용을 확인한 뒤 동의하세요.\n\n워크스페이스: ${workspace?.displayName ?? workspaceId}`;
      if (!confirm(detail)) return;
      const second = await this.runWorkspaceSetup(workspaceId, true);
      if (second.setupState === 'failed') {
        this.store.set({ lastError: `setup 실패: ${second.detail ?? ''}` });
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  /** 프로젝트 설정 파일 setup 실행 — `trust` 는 사용자가 내용을 보고 동의했을 때만 true */
  async runWorkspaceSetup(
    workspaceId: string,
    trust = false,
  ): Promise<{ setupState: WorkspaceSetupState; detail?: string }> {
    const result = (await this.client.rpc('workspace.setup.run', { workspaceId, trust })) as {
      setupState: WorkspaceSetupState;
      detail?: string;
    };
    await this.refreshWorkspaces();
    return result;
  }

  /** 하네스 상태 패널 (FR-3.6.3) — 버전·검증·가용성 probe */
  async probeHarness(harness: HarnessId): Promise<void> {
    const result = (await this.client.rpc('harness.probe', { harness })) as { probe: ProbeResult };
    this.store.set((prev) => ({ ...prev, probes: { ...prev.probes, [harness]: result.probe } }));
  }

  navigate(route: Route): void {
    this.store.set({ route });
  }

  // ── 탭·분할 레이아웃 (FR-3.3.2/3, WBS 6.2) ───────────────────────────────

  /** 활성 워크스페이스의 배치. 워크스페이스가 없으면 빈 배치를 준다 */
  get layout(): LayoutState {
    const state = this.store.get();
    const key = state.activeWorkspaceId;
    return (key !== null ? state.layouts[key] : undefined) ?? emptyLayout();
  }

  private setLayout(mutate: (layout: LayoutState) => LayoutState): void {
    this.store.set((prev) => {
      const key = prev.activeWorkspaceId;
      if (key === null) return prev; // 워크스페이스 없이는 배치가 성립하지 않는다
      const layouts = { ...prev.layouts, [key]: mutate(prev.layouts[key] ?? emptyLayout()) };
      persist(LAYOUT_KEY, layouts);
      return { ...prev, layouts };
    });
  }

  /**
   * 배치 복원 — 살아 있지 않은 타깃은 조용히 버린다.
   * 구형(문자열 세션 ID 배열) 배치는 활성 워크스페이스로 1회 이관한다 (workbench-tabs §1.4).
   */
  private restoreLayout(): void {
    const saved = loadPersisted<Record<string, unknown>>(LAYOUT_KEY);
    if (saved === undefined) return;
    const state = this.store.get();
    const alive = {
      sessionIds: new Set(state.sessions.map((session) => session.sessionId)),
      terminalIds: new Set(state.terminals.map((terminal) => terminal.id)),
    };
    // 구형은 { tabs, active, split } 단일 배치 — 새 형식은 워크스페이스 id 로 키가 잡힌다
    const isLegacySingle = Array.isArray((saved as { tabs?: unknown }).tabs);
    const layouts: Record<string, LayoutState> = {};
    if (isLegacySingle) {
      if (state.activeWorkspaceId !== null) {
        layouts[state.activeWorkspaceId] = restoreLayoutFrom(saved, alive);
      }
    } else {
      for (const [workspaceId, value] of Object.entries(saved)) {
        layouts[workspaceId] = restoreLayoutFrom(value, alive);
      }
    }
    this.store.set({ layouts });
    persist(LAYOUT_KEY, layouts);
    for (const id of this.openTabIds()) void this.loadTabContent(id);
  }

  /** 현재 화면에 떠 있는 탭(주·보조 페인) */
  private openTabIds(): string[] {
    const layout = this.layout;
    return [layout.active, layout.split?.secondary].filter(
      (id): id is string => id !== null && id !== undefined,
    );
  }

  /** 탭 타깃별 적재 — 세션은 타임라인 + 위임 비용, 그 외는 아직 없다 */
  private async loadTabContent(tabId: string): Promise<void> {
    const target = targetOf(this.layout, tabId);
    if (target?.kind === 'session') await this.loadSessionTab(target.sessionId);
  }

  /**
   * 세션 탭 하나가 필요로 하는 것 — 진입점이 둘(목록에서 열기 / 탭 전환)이라 여기 모은다.
   * 나뉘어 있으면 한쪽에만 적재를 추가하는 실수가 조용히 통과한다.
   */
  private async loadSessionTab(sessionId: string): Promise<void> {
    await this.loadTimeline(sessionId);
    await this.refreshUsageTree(sessionId);
  }

  /**
   * 위임 비용 조회 (M7 7.3.3). 열려 있는 세션 탭에 대해서만 부른다 — 목록 전체를 훑으면
   * 세션 수만큼 RPC 가 나가고, 화면에 없는 세션의 트랙은 아무도 보지 않는다.
   *
   * 실패는 삼킨다. 트랙은 보조 정보라 못 받았다고 대화 화면을 막을 이유가 없다.
   */
  async refreshUsageTree(sessionId: string): Promise<void> {
    try {
      const tree = (await this.client.rpc('session.usage', { sessionId })) as SessionUsageTree;
      this.store.set({ usageTrees: { ...this.store.get().usageTrees, [sessionId]: tree } });
    } catch {
      /* 트랙 없이도 대화는 된다 */
    }
  }

  /** 탭으로 열기 — 목록·재개 공용 진입점 */
  async openSession(sessionId: string): Promise<void> {
    const summary = this.store.get().sessions.find((s) => s.sessionId === sessionId);
    if (summary?.status === 'closed') {
      await this.client.rpc('session.resume', { sessionId });
      await this.refreshSessions();
    }
    // 세션이 다른 워크스페이스 소속이면 그쪽으로 옮겨서 연다 — 배치가 워크스페이스 단위라서다
    if (
      summary?.workspaceId !== undefined &&
      summary.workspaceId !== this.store.get().activeWorkspaceId
    ) {
      this.selectWorkspace(summary.workspaceId);
    }
    this.openTarget({ kind: 'session', sessionId });
    this.acknowledgeAttention(sessionId);
    await this.loadSessionTab(sessionId);
  }

  // ── 커맨드 팔레트 (M7 WBS 7.4.2, FR-9.4) ─────────────────────────────────

  openPalette(): void {
    // 온보딩 중에는 열지 않는다 — 그 화면은 팔레트를 그리지 않으므로 상태만 켜지고
    // 사용자에게는 단축키가 먹통으로 보인다
    if (this.store.get().route === 'onboarding') return;
    // 열 때 이전 질의를 비운다 — 남아 있으면 그 결과가 잠깐 깜빡인 뒤 갱신된다
    this.store.set({ palette: { ...emptyPaletteState(), open: true } });
    void this.searchPalette('');
  }

  closePalette(): void {
    this.paletteSeq += 1; // 도는 중인 응답을 버린다
    this.store.set({ palette: emptyPaletteState() });
  }

  /**
   * 질의 갱신 — 로컬 소스는 즉시 반영되고 원격(파일·대화 내용)만 여기서 조회한다.
   *
   * 응답 경합을 **질의 문자열이 아니라 일련번호**로 막는다: 같은 글자를 지웠다 다시
   * 치면 질의는 같지만 앞 요청의 답이 뒤에 올 수 있다. 세는 것은 "몇 번째 요청인가"다.
   */
  async searchPalette(query: string): Promise<void> {
    const seq = ++this.paletteSeq;
    const previous = this.store.get().palette;
    this.store.set({ palette: { ...previous, query, loading: query.trim() !== '' } });
    const trimmed = query.trim();
    if (trimmed === '') {
      this.store.set({
        palette: { ...this.store.get().palette, resultsFor: '', filePaths: [], hits: [] },
      });
      return;
    }
    const workspaceId = this.store.get().activeWorkspaceId;
    const [files, timeline] = await Promise.all([
      workspaceId === null
        ? Promise.resolve({ paths: [] })
        : (this.client.rpc('file.search', { workspaceId, query: trimmed, limit: 50 }).catch(() => ({
            paths: [] as string[],
          })) as Promise<{ paths: string[] }>),
      this.client.rpc('session.search', { query: trimmed, limit: 20 }).catch(() => ({
        hits: [] as SearchHit[],
      })) as Promise<{ hits: SearchHit[] }>,
    ]);
    // 이 응답을 기다리는 사이 사용자가 더 쳤다면 버린다 (실패도 조용히 — 팔레트는 보조 경로다)
    if (seq !== this.paletteSeq) return;
    this.store.set({
      palette: {
        ...this.store.get().palette,
        resultsFor: trimmed,
        // RPC 경계에서는 응답이 완전하다는 보장이 없다. 보조 UI인 팔레트가
        // 불완전한 검색 응답 하나로 앱 전체를 무너뜨리면 안 된다.
        filePaths: Array.isArray(files.paths) ? files.paths : [],
        hits: Array.isArray(timeline.hits) ? timeline.hits : [],
        loading: false,
      },
    });
  }

  /** 현재 질의로 세운 목록 — 컴포넌트가 소스 조립을 다시 하지 않게 컨트롤러가 준다 */
  paletteItems(): PaletteItem[] {
    const state = this.store.get();
    const palette = state.palette;
    const trimmed = palette.query.trim();
    // 원격 결과는 **그 질의의 답일 때만** 쓴다 — 아니면 옛 파일·히트가 잠깐 섞여 보인다
    const fresh = palette.resultsFor === trimmed;
    return buildItems(palette.query, {
      sessions: state.sessions,
      workspaces: state.workspaces,
      filePaths: fresh ? palette.filePaths : [],
      hits: fresh ? palette.hits : [],
      context: {
        hasActiveTab: this.layout.active !== null,
        hasWorkspace: state.activeWorkspaceId !== null,
        isSplit: this.layout.split !== null,
      },
    });
  }

  /** 항목 실행 — 팔레트는 닫고 동작을 넘긴다 */
  runPaletteAction(action: PaletteAction): void {
    this.closePalette();
    switch (action.kind) {
      case 'command':
        this.runPaletteCommand(action.id);
        return;
      case 'open-session':
        void this.openSession(action.sessionId);
        return;
      case 'select-workspace':
        this.selectWorkspace(action.workspaceId);
        return;
      case 'open-file':
        this.openFile(action.path);
        return;
      case 'open-timeline':
        // 대화 내용 히트는 세션 탭으로 데려간다. `seq` 는 7.4.1 이 실어 준 앵커이고,
        // 타임라인 안에서 그 자리로 스크롤하는 것은 대화 뷰의 몫이다.
        void this.openSession(action.sessionId).then(() =>
          this.store.set({
            views: {
              ...this.store.get().views,
              [action.sessionId]: {
                ...(this.store.get().views[action.sessionId] ?? emptySessionView()),
                focusSeq: action.seq,
              },
            },
          }),
        );
        return;
    }
  }

  private runPaletteCommand(id: PaletteCommandId): void {
    switch (id) {
      case 'new-session':
        this.showNewSessionView();
        return;
      case 'new-workspace':
        this.navigate('workspace-create');
        return;
      case 'new-terminal':
        void this.createTerminal();
        return;
      case 'open-files':
        this.openTarget({ kind: 'files' });
        return;
      case 'open-diff':
        this.openTarget({ kind: 'diff', scope: 'working' });
        void this.refreshDiff();
        return;
      case 'open-about':
        this.navigate('about');
        return;
      case 'open-settings':
        this.navigate('settings');
        return;
      case 'close-tab': {
        const active = this.layout.active;
        if (active !== null) this.closeTab(active);
        return;
      }
      case 'split-row':
        this.setSplit('row');
        return;
      case 'split-column':
        this.setSplit('column');
        return;
      case 'split-off':
        this.setSplit(null);
        return;
    }
  }

  /** 임의 타깃을 탭으로 연다 (WBS 6.2.1) */
  openTarget(target: TabTarget): void {
    this.setLayout((layout) => openTab(layout, target));
  }

  setActiveTab(tabId: string): void {
    this.setLayout((layout) => setActiveTabIn(layout, tabId));
    void this.loadTabContent(tabId);
  }

  /** 새 세션 화면 — 하네스와 모델을 고른 뒤 생성한다. */
  showNewSessionView(): void {
    this.store.set({ route: 'session-create' });
    this.setLayout((layout) => ({ ...layout, active: null }));
  }

  /** 탭 닫기 — 대상(세션·터미널)의 수명과 무관한 레이아웃 변경이다 (FR-8.1) */
  closeTab(tabId: string): void {
    this.setLayout((layout) => closeTabIn(layout, tabId));
  }

  /** 명시적 세션 종료 (FR-3.3.3) — 하네스 프로세스 정리, 이력은 유지(재개 가능) */
  async closeSession(sessionId: string): Promise<void> {
    await this.client.rpc('session.close', { sessionId });
    this.closeTab(`session:${sessionId}`);
    await this.refreshSessions();
  }

  /** 분할 토글 — secondary 미지정 시 active 외 첫 탭 (없으면 무시) */
  setSplit(direction: 'row' | 'column' | null, secondary?: string): void {
    this.setLayout((layout) => setSplitIn(layout, direction, secondary));
    const target = this.layout.split?.secondary;
    if (target !== undefined) void this.loadTabContent(target);
  }

  private async loadTimeline(sessionId: string): Promise<void> {
    try {
      const result = (await this.client.rpc('session.timeline', { sessionId, fromSeq: 0 })) as {
        events: Parameters<typeof applyEvents>[1];
      };
      this.store.set((prev) => ({
        ...prev,
        views: { ...prev.views, [sessionId]: applyEvents(emptySessionView(), result.events) },
      }));
    } catch (error) {
      this.reportError(error);
    }
  }

  /**
   * 세션 생성 — 소유 워크스페이스를 명시한다 (WBS 5.6.4).
   * cwd 는 데몬이 워크스페이스에서 가져오므로 렌더러가 보내지 않는다.
   */
  async createSession(params: {
    harness: HarnessId;
    workspaceId: string;
    modelId?: string;
  }): Promise<void> {
    const result = (await this.client.rpc('session.create', { ...params })) as {
      session: SessionSummary;
    };
    const session = result.session;
    this.store.set((prev) => ({
      ...prev,
      route: 'main',
      views: {
        ...prev.views,
        [session.sessionId]: prev.views[session.sessionId] ?? emptySessionView(session.status),
      },
    }));
    this.openTarget({ kind: 'session', sessionId: session.sessionId });
    await this.refreshSessions();
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    await this.client.rpc('session.prompt', { sessionId, prompt: text });
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.client.rpc('session.interrupt', { sessionId });
  }

  async respondPermission(
    sessionId: string,
    requestId: string,
    outcome: PermissionOutcome,
  ): Promise<void> {
    await this.client.rpc('session.permission.respond', { sessionId, requestId, outcome });
  }

  // ── 자동 승인 (FR-3.4.3, WBS 2.4.7) ──────────────────────────────────────

  /** 세션 한정 opt-in — 위험 고지는 UI 가 담당. 렌더러 수명이라 재시작 시 초기화 */
  setAutoApprove(sessionId: string, enabled: boolean): void {
    this.store.set((prev) => ({
      ...prev,
      autoApprove: { ...prev.autoApprove, [sessionId]: enabled },
    }));
  }

  private onPermissionRequested(
    sessionId: string,
    event: {
      request: {
        requestId: string;
        options: { optionId: string; kind: string }[];
        origin?: 'harness' | 'reverse_tool' | undefined;
      };
    },
  ): void {
    // 역방향 툴은 다른 세션·터미널을 제어할 수 있으므로, 세션의 하네스 자동 승인 범위에
    // 넣지 않는다. origin 생략은 이전 하네스와의 호환을 위해 harness 로 해석한다.
    if (
      event.request.origin !== 'reverse_tool' &&
      this.store.get().autoApprove[sessionId] === true
    ) {
      const allow = event.request.options.find((o) => o.kind === 'allow_once');
      if (allow) {
        void this.respondPermission(sessionId, event.request.requestId, {
          optionId: allow.optionId,
        });
        return;
      }
    }
    // 배지는 목록 갱신으로 (FR-3.4.2). 알림은 attention_changed 가 담당한다 (7.1.3)
    void this.refreshSessions();
  }

  /** 주의 상태 전이 → 목록 갱신 + 알림 1회 (M7 7.1.3) */
  private onAttentionChanged(event: {
    sessionId: string;
    requiresAttention: boolean;
    attentionReason?: 'permission' | 'error' | 'finished' | undefined;
  }): void {
    void this.refreshSessions();
    if (!event.requiresAttention) return;
    const title = ATTENTION_TITLE[event.attentionReason ?? 'finished'];
    this.maybeNotify(event.sessionId, title, `세션 ${this.sessionLabel(event.sessionId)}`);
  }

  /** 사용자가 세션을 열었다 = 확인했다 (7.1.2 ack). 승인 대기는 이걸로 사라지지 않는다 */
  private acknowledgeAttention(sessionId: string): void {
    void this.client.rpc('session.attention.ack', { sessionId }).catch(() => undefined); // 확인 신호 실패는 무해 — 다음 전이에서 다시 계산된다
  }

  // ── 네이티브 알림 (FR-3.5.2, WBS 2.4.6) ──────────────────────────────────

  setNotificationsEnabled(enabled: boolean): void {
    persist(NOTIFICATIONS_KEY, enabled);
    this.store.set({ notificationsEnabled: enabled });
  }

  /** 비활성(백그라운드) 세션에만 알림 — 클릭 시 해당 세션 포커스 */
  private maybeNotify(sessionId: string, title: string, body: string): void {
    const state = this.store.get();
    if (!state.notificationsEnabled) return;
    const layout = this.layout;
    const visibleSessions = [layout.active, layout.split?.secondary]
      .map((id) => targetOf(layout, id))
      .filter((target) => target?.kind === 'session')
      .map((target) => (target as { sessionId: string }).sessionId);
    const isVisible = visibleSessions.includes(sessionId);
    const windowFocused = typeof document !== 'undefined' && document.hasFocus();
    if (isVisible && windowFocused) return;
    if (typeof Notification === 'undefined') return; // 테스트·비지원 환경
    try {
      const notification = new Notification(title, { body });
      notification.onclick = () => {
        window.focus();
        void this.openSession(sessionId);
      };
    } catch {
      /* 알림 실패는 무해 */
    }
  }

  private sessionLabel(sessionId: string): string {
    const summary = this.store.get().sessions.find((s) => s.sessionId === sessionId);
    if (!summary) return sessionId.slice(0, 8);
    return `${summary.harness} · ${summary.cwd.split('/').pop() ?? summary.cwd}`;
  }

  // ── 설정 (FR-3.6, WBS 2.4.4) ─────────────────────────────────────────────

  /** 온보딩·설정 — 게이트웨이 설정 저장 (config.set) */
  async saveGateway(settings: Partial<GatewaySettings>): Promise<void> {
    await this.client.rpc('config.set', { values: { gateway: settings } });
    await this.refreshConfig();
  }

  /** 기본 모델 선택 (FR-3.6.2) */
  async setDefaultModel(modelId: string): Promise<void> {
    await this.saveGateway({ defaultModel: modelId });
  }

  /** 키 저장 후 연결 확인 — 결과를 그대로 반환해 화면이 원인별 안내 (FR-3.8) */
  async setKeyAndTest(apiKey: string): Promise<{ valid: boolean; detail?: string }> {
    await this.client.rpc('config.key.set', { apiKey });
    const result = (await this.client.rpc('config.key.test')) as {
      valid: boolean;
      detail?: string;
    };
    await this.refreshConfig();
    return result;
  }

  clearError(): void {
    this.store.set({ lastError: null });
  }

  reportError(error: unknown): void {
    this.store.set({ lastError: error instanceof Error ? error.message : String(error) });
  }
}
