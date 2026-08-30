// 앱 상태 스토어·컨트롤러 (WBS 1.5.1·2.4) — 데몬 RPC/이벤트를 상태로 투영한다.
// 컨트롤러는 전송 계층을 인터페이스로 받는다 (컴포넌트 테스트에서 fake 주입).
// M2 2.4: 탭·분할 레이아웃(FR-3.3.2/3, localStorage 복원), 자동 승인 opt-in(FR-3.4.3),
// 네이티브 알림(FR-3.5.2 — Electron 렌더러의 Notification API), 하네스 상태 패널 데이터.
import type {
  HarnessId,
  HarnessInfo,
  PermissionOutcome,
  ProbeResult,
  Project,
  SessionSummary,
  Workspace,
  WorkspaceSetupState,
} from '@custom-harness/protocol';
import type { ConnectionState, DaemonClient } from '../ws/client.js';
import { applyEvent, applyEvents, emptySessionView, type SessionView } from '../timeline.js';
import { Store } from './store.js';

export type Route = 'onboarding' | 'main' | 'settings' | 'workspace-create';

export interface GatewaySettings {
  baseUrl: string;
  defaultModel?: string;
  models: { id: string; name?: string }[];
}

export interface KeyState {
  present: boolean;
  fallback: boolean;
}

/** 탭 + 분할 페인 배치 (FR-3.3.2) — 1차는 2분할까지 */
export interface LayoutState {
  /** 열린 탭(세션 ID) 순서 — 탭 닫기는 세션 종료가 아니다 (FR-3.3.3) */
  tabs: string[];
  /** 포커스 탭 (주 페인) */
  active: string | null;
  /** 분할 시 보조 페인 세션 — row = 좌우, column = 상하 */
  split: { direction: 'row' | 'column'; secondary: string } | null;
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
  layout: LayoutState;
  views: Record<string, SessionView>;
  /** 세션 한정 자동 승인 opt-in (FR-3.4.3) — 렌더러 수명, 영속화하지 않는다 */
  autoApprove: Record<string, boolean>;
  /** 네이티브 알림 on/off (FR-3.5.2) — localStorage 영속 */
  notificationsEnabled: boolean;
  /** 하네스 상태 패널 (FR-3.6.3) — harness.probe 결과 캐시 */
  probes: Record<string, ProbeResult>;
  /** 마지막 전역 오류 (RPC 실패 등) — 배너 표시용 */
  lastError: string | null;
}

const LAYOUT_KEY = 'custom-harness.layout';
const WORKSPACE_KEY = 'custom-harness.active-workspace';
const NOTIFICATIONS_KEY = 'custom-harness.notifications';

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
    layout: { tabs: [], active: null, split: null },
    views: {},
    autoApprove: {},
    notificationsEnabled: loadPersisted<boolean>(NOTIFICATIONS_KEY) ?? true,
    probes: {},
    lastError: null,
  };
}

/** DaemonClient 의 컨트롤러 사용 표면 — 테스트 fake 주입 지점 */
export interface DaemonTransport {
  rpc(type: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: Parameters<DaemonClient['onEvent']>[0]): () => void;
  onState(listener: (state: ConnectionState) => void): () => void;
  onReconnected(listener: () => void): () => void;
  start(): void;
  stop(): void;
}

export class AppController {
  readonly store = new Store<AppState>(initialAppState());

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
      this.store.set((prev) => {
        const view = prev.views[event.sessionId] ?? emptySessionView();
        return { ...prev, views: { ...prev.views, [event.sessionId]: applyEvent(view, event) } };
      });
      if (event.type === 'session_status_changed') void this.refreshSessions();
      if (event.type === 'permission_requested') this.onPermissionRequested(event.sessionId, event);
      if (event.type === 'turn_completed' || event.type === 'turn_failed') {
        this.maybeNotify(
          event.sessionId,
          event.type === 'turn_completed' ? '턴 완료' : '턴 실패',
          `세션 ${this.sessionLabel(event.sessionId)}`,
        );
        void this.refreshSessions(); // 목록 usage 요약 갱신 (FR-3.7)
      }
    });
    client.onReconnected(() => void this.resync());
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
      const { layout } = this.store.get();
      const open = [layout.active, layout.split?.secondary].filter(
        (id): id is string => id !== null && id !== undefined,
      );
      for (const sessionId of open) await this.syncTimelineGap(sessionId);
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

  selectWorkspace(workspaceId: string): void {
    persist(WORKSPACE_KEY, workspaceId);
    this.store.set({ activeWorkspaceId: workspaceId });
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

  // ── 탭·분할 레이아웃 (FR-3.3.2/3, WBS 2.4.2) ─────────────────────────────

  private setLayout(mutate: (layout: LayoutState) => LayoutState): void {
    this.store.set((prev) => {
      const layout = mutate(prev.layout);
      persist(LAYOUT_KEY, layout);
      return { ...prev, layout };
    });
  }

  private restoreLayout(): void {
    const saved = loadPersisted<LayoutState>(LAYOUT_KEY);
    if (!saved) return;
    const alive = new Set(this.store.get().sessions.map((s) => s.sessionId));
    const tabs = (saved.tabs ?? []).filter((id) => alive.has(id));
    const active =
      saved.active !== null && alive.has(saved.active) ? saved.active : (tabs[0] ?? null);
    const split =
      saved.split && alive.has(saved.split.secondary) && saved.split.secondary !== active
        ? saved.split
        : null;
    this.setLayout(() => ({ tabs, active, split }));
    // 복원된 페인 타임라인 적재
    for (const id of [active, split?.secondary]) {
      if (id !== null && id !== undefined) void this.loadTimeline(id);
    }
  }

  /** 탭으로 열기 — 목록·재개 공용 진입점 */
  async openSession(sessionId: string): Promise<void> {
    const summary = this.store.get().sessions.find((s) => s.sessionId === sessionId);
    if (summary?.status === 'closed') {
      await this.client.rpc('session.resume', { sessionId });
      await this.refreshSessions();
    }
    this.setLayout((layout) => ({
      ...layout,
      tabs: layout.tabs.includes(sessionId) ? layout.tabs : [...layout.tabs, sessionId],
      active: sessionId,
    }));
    await this.loadTimeline(sessionId);
  }

  setActiveTab(sessionId: string): void {
    this.setLayout((layout) =>
      layout.tabs.includes(sessionId) ? { ...layout, active: sessionId } : layout,
    );
  }

  /** 새 세션 뷰 — 활성 탭 해제 (탭은 유지) */
  showNewSessionView(): void {
    this.store.set({ route: 'main' });
    this.setLayout((layout) => ({ ...layout, active: null }));
  }

  /** 탭 닫기 — 세션은 데몬에 유지 (FR-3.3.3) */
  closeTab(sessionId: string): void {
    this.setLayout((layout) => {
      const tabs = layout.tabs.filter((id) => id !== sessionId);
      const split = layout.split?.secondary === sessionId ? null : layout.split;
      const active =
        layout.active === sessionId
          ? (tabs[Math.min(layout.tabs.indexOf(sessionId), tabs.length - 1)] ?? null)
          : layout.active;
      return { tabs, active, split };
    });
  }

  /** 명시적 세션 종료 (FR-3.3.3) — 하네스 프로세스 정리, 이력은 유지(재개 가능) */
  async closeSession(sessionId: string): Promise<void> {
    await this.client.rpc('session.close', { sessionId });
    this.closeTab(sessionId);
    await this.refreshSessions();
  }

  /** 분할 토글 — secondary 미지정 시 active 외 첫 탭 (없으면 무시) */
  setSplit(direction: 'row' | 'column' | null, secondary?: string): void {
    this.setLayout((layout) => {
      if (direction === null) return { ...layout, split: null };
      const candidate = secondary ?? layout.tabs.find((id) => id !== layout.active);
      if (candidate === undefined || candidate === layout.active) return { ...layout, split: null };
      return { ...layout, split: { direction, secondary: candidate } };
    });
    const target = this.store.get().layout.split?.secondary;
    if (target !== undefined) void this.loadTimeline(target);
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
      views: {
        ...prev.views,
        [session.sessionId]: prev.views[session.sessionId] ?? emptySessionView(session.status),
      },
    }));
    this.setLayout((layout) => ({
      ...layout,
      tabs: [...layout.tabs, session.sessionId],
      active: session.sessionId,
    }));
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
    event: { request: { requestId: string; options: { optionId: string; kind: string }[] } },
  ): void {
    if (this.store.get().autoApprove[sessionId] === true) {
      const allow = event.request.options.find((o) => o.kind === 'allow_once');
      if (allow) {
        void this.respondPermission(sessionId, event.request.requestId, {
          optionId: allow.optionId,
        });
        return;
      }
    }
    // 백그라운드 세션 승인 대기 유도 (FR-3.4.2) — 배지는 목록 갱신, 알림은 여기서
    void this.refreshSessions();
    this.maybeNotify(sessionId, '승인 대기', `세션 ${this.sessionLabel(sessionId)} 승인 요청`);
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
    const isVisible =
      state.layout.active === sessionId || state.layout.split?.secondary === sessionId;
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

  private reportError(error: unknown): void {
    this.store.set({ lastError: error instanceof Error ? error.message : String(error) });
  }
}
