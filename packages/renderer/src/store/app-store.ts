// 앱 상태 스토어·컨트롤러 (WBS 1.5.1) — 데몬 RPC/이벤트를 상태로 투영한다.
// 컨트롤러는 전송 계층을 인터페이스로 받는다 (컴포넌트 테스트에서 fake 주입).
import type {
  HarnessId,
  HarnessInfo,
  PermissionOutcome,
  SessionSummary,
} from '@custom-harness/protocol';
import type { ConnectionState, DaemonClient } from '../ws/client.js';
import { applyEvent, applyEvents, emptySessionView, type SessionView } from '../timeline.js';
import { Store } from './store.js';

export type Route = 'onboarding' | 'main' | 'settings';

export interface GatewaySettings {
  baseUrl: string;
  defaultModel?: string;
  models: { id: string; name?: string }[];
}

export interface KeyState {
  present: boolean;
  fallback: boolean;
}

export interface AppState {
  connection: ConnectionState;
  route: Route;
  bootstrapped: boolean;
  gateway: GatewaySettings | null;
  keyState: KeyState | null;
  harnesses: HarnessInfo[];
  sessions: SessionSummary[];
  currentSessionId: string | null;
  views: Record<string, SessionView>;
  /** 마지막 전역 오류 (RPC 실패 등) — 배너 표시용 */
  lastError: string | null;
}

export function initialAppState(): AppState {
  return {
    connection: 'closed',
    route: 'main',
    bootstrapped: false,
    gateway: null,
    keyState: null,
    harnesses: [],
    sessions: [],
    currentSessionId: null,
    views: {},
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
      this.store.set((prev) => {
        const view = prev.views[event.sessionId] ?? emptySessionView();
        return { ...prev, views: { ...prev.views, [event.sessionId]: applyEvent(view, event) } };
      });
      if (event.type === 'session_status_changed') void this.refreshSessions();
    });
    client.onReconnected(() => void this.resync());
  }

  start(): void {
    this.client.start();
  }

  stop(): void {
    this.client.stop();
  }

  /** 최초 연결 시 상태 적재 — 온보딩 필요 여부 판정 (FR-3.8) */
  async bootstrap(): Promise<void> {
    try {
      await this.refreshConfig();
      await this.refreshHarnesses();
      await this.refreshSessions();
      const { gateway, keyState } = this.store.get();
      this.store.set({
        bootstrapped: true,
        route: gateway === null || keyState?.present !== true ? 'onboarding' : 'main',
      });
    } catch (error) {
      this.reportError(error);
    }
  }

  /** 재연결 재동기화 — 목록 + 현재 세션 타임라인 갭 회수 (protocol-design §5) */
  async resync(): Promise<void> {
    try {
      await this.refreshSessions();
      const { currentSessionId, views } = this.store.get();
      if (!currentSessionId) return;
      const fromSeq = (views[currentSessionId]?.lastSeq ?? -1) + 1;
      const result = (await this.client.rpc('session.timeline', {
        sessionId: currentSessionId,
        fromSeq,
      })) as { events: Parameters<typeof applyEvents>[1] };
      this.store.set((prev) => {
        const view = prev.views[currentSessionId] ?? emptySessionView();
        return {
          ...prev,
          views: { ...prev.views, [currentSessionId]: applyEvents(view, result.events) },
        };
      });
    } catch (error) {
      this.reportError(error);
    }
  }

  async refreshConfig(): Promise<void> {
    const result = (await this.client.rpc('config.get')) as {
      values: { gateway: GatewaySettings | null; keyState: KeyState };
    };
    this.store.set({ gateway: result.values.gateway, keyState: result.values.keyState });
  }

  async refreshHarnesses(): Promise<void> {
    const result = (await this.client.rpc('harness.list')) as { harnesses: HarnessInfo[] };
    this.store.set({ harnesses: result.harnesses });
  }

  async refreshSessions(): Promise<void> {
    const result = (await this.client.rpc('session.list')) as { sessions: SessionSummary[] };
    this.store.set({ sessions: result.sessions });
  }

  navigate(route: Route): void {
    this.store.set({ route });
  }

  async createSession(params: {
    harness: HarnessId;
    cwd: string;
    modelId?: string;
  }): Promise<void> {
    const result = (await this.client.rpc('session.create', { ...params })) as {
      session: SessionSummary;
    };
    const session = result.session;
    this.store.set((prev) => ({
      ...prev,
      currentSessionId: session.sessionId,
      views: {
        ...prev.views,
        [session.sessionId]: prev.views[session.sessionId] ?? emptySessionView(session.status),
      },
    }));
    await this.refreshSessions();
  }

  async selectSession(sessionId: string): Promise<void> {
    this.store.set({ currentSessionId: sessionId });
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

  async resumeSession(sessionId: string): Promise<void> {
    await this.client.rpc('session.resume', { sessionId });
    await this.selectSession(sessionId);
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

  /** 온보딩·설정 — 게이트웨이 설정 저장 (config.set) */
  async saveGateway(settings: Partial<GatewaySettings>): Promise<void> {
    await this.client.rpc('config.set', { values: { gateway: settings } });
    await this.refreshConfig();
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
